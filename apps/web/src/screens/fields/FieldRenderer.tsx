/**
 * Renders a FormField as an interactive input. Shared by the builder's live
 * preview and the external fill flow, so a field looks and behaves identically
 * wherever it appears. Values use the shared SubmissionValue union.
 */
import { useEffect, useId, useRef, useState } from 'react';
import {
  Checkbox,
  DateTimePicker,
  FileDropzone,
  Icon,
  Input,
  MicButton,
  Radio,
  RepeatingGroup,
  Select,
  SignaturePad,
  Textarea,
  currentTimeHHMM,
  type RepeatingRow,
} from '@formai/ui';
import type { FormField, SubmissionFileRef, SubmissionValue } from '@formai/shared';
import {
  ALLOWED_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  applyCalcs,
  applySelection,
  groupPairingOptions,
  incompleteFixedRowIndices,
  isFileRef,
  isMatchingQuestion,
  parsePairingOption,
  resolveAnswerSets,
  selectedOption,
} from '@formai/shared';
import type { RepeatingRowValue } from '@formai/shared';
import { ApiError, uploadAttachment } from '../../lib/data/api-client.js';
import { resolveRepeatingRows } from '../../lib/fixed-rows.js';
import { coerceSpokenValue, isDictatable, useDictation } from '../../lib/voice/index.js';
import { MatchingField } from './MatchingField.js';

export interface FieldInputProps {
  field: FormField;
  value: SubmissionValue;
  onChange: (value: SubmissionValue) => void;
  error?: string;
  disabled?: boolean;
  /**
   * Rows the server reported incomplete on a failed submit — the `incompleteRows`
   * entry for this field in the 400 body (`incompleteRowsByField`). When absent,
   * a repeating group with an error recomputes them locally, so the highlight
   * works even where the caller has no response to hand.
   */
  incompleteRowIndexes?: number[];
  /**
   * Offer a mic on fields that can be answered by speaking.
   *
   * Opt-in rather than opt-out: a surface that only PREVIEWS a field — the
   * builder's live preview, whose `onChange` is a no-op — must never ask for
   * the microphone, and a mic that silently discards what it heard is worse
   * than no mic at all.
   */
  dictation?: boolean;
  /**
   * Where a `file_upload` field POSTs its bytes.
   *
   * - omitted → `/uploads`, the authenticated door. Correct for every
   *   signed-in surface (mobile field app, internal fill).
   * - a path → that endpoint; the public fill page passes
   *   `/fill/:token/uploads`, where the link token is the credential.
   * - `null` → do not persist. The builder's live preview renders a real
   *   control against a throwaway value, so uploading there would litter the
   *   bucket with objects no submission will ever reference.
   *
   * Note the parallel with `dictation` above: both default to the safe
   * behaviour for a preview surface, for the same reason.
   */
  uploadPath?: string | null;
}

/**
 * Types this renderer both draws a control for and can read speech into.
 *
 * `check_cross` is excluded, and the reason has changed. It used to be that the
 * switch below had no case for it, so there was nothing for speech to write
 * into. It has one now — and the exclusion stands on the stronger ground that
 * was always underneath it: this type is a VERDICT on a competency record,
 * where a tick and a cross are opposite findings about whether a person is safe
 * to operate a machine. A transcription confidence of 0.7 is not a basis for
 * either. It is two buttons; an assessor presses one. Exported because Smart
 * Fill has to refuse to write the same fields for the same reason.
 *
 * A MATCHING QUESTION IS EXCLUDED FOR A DIFFERENT REASON, and a stronger one.
 * Its options are pairings, so speech would have to be coerced into a set of
 * "statement -> sign" strings — which at best produces noise, and at worst lets
 * a candidate answer "Match the statement with the appropriate SIGNAGE" by
 * saying the sign's name. That is the visual-recognition bypass the question
 * exists to test for, offered by the form itself.
 */
export function canDictateField(field: FormField): boolean {
  if (!isDictatable(field.type) || field.type === 'check_cross') return false;
  return !isMatchingQuestion(field.options);
}

/** Types whose control is one labelable element that accepts an `id`. */
const LABELABLE_TYPES: ReadonlySet<FormField['type']> = new Set([
  'text',
  'number',
  'textarea',
  'dropdown',
]);

function asString(v: SubmissionValue): string {
  if (v === null || v === undefined || Array.isArray(v)) return '';
  // A file ref is an object; `String(...)` on one yields "[object Object]",
  // which would render as the answer text of any field that received one.
  if (isFileRef(v)) return v.fileName;
  return String(v);
}

export function FieldInput({
  field,
  value,
  onChange,
  error,
  disabled,
  incompleteRowIndexes,
  dictation = false,
  uploadPath,
}: FieldInputProps) {
  if (field.type === 'section_header') {
    return (
      <div className="border-b border-border-subtle pb-2 pt-2">
        <h4 className="text-[15px] font-bold text-text-primary">{field.label}</h4>
        {field.help && <p className="mt-1 text-[12.5px] text-text-tertiary">{field.help}</p>}
      </div>
    );
  }

  // Association wiring. The @formai/ui text controls (Input / Select /
  // Textarea) are labelable and accept an `id`, so those four types get a real
  // <label htmlFor> — a screen reader then announces the question on focus
  // instead of an anonymous input. Option groups have no single labelable
  // element; their container gets a role + `aria-labelledby` pointing at the
  // caption instead. Everything else keeps the caption as a styled div
  // (signature and the time row already label themselves via `aria-label`).
  const controlId = useId();
  const labelId = `${controlId}-label`;
  const labelable = LABELABLE_TYPES.has(field.type);
  const groupRole =
    field.type === 'radio' || field.type === 'boolean_yes_no'
      ? ('radiogroup' as const)
      : field.type === 'checkbox_group'
        ? ('group' as const)
        : null;

  const caption = (
    <>
      {field.label}
      {field.required && <span className="ml-0.5 text-danger">*</span>}
    </>
  );
  const label = labelable ? (
    <label htmlFor={controlId} className="mb-1.5 block text-[13px] font-semibold text-text-primary">
      {caption}
    </label>
  ) : (
    <div id={groupRole ? labelId : undefined} className="mb-1.5 text-[13px] font-semibold text-text-primary">
      {caption}
    </div>
  );
  // The labelable controls render the error themselves (with their own
  // `aria-describedby` wiring), so repeating it here printed every error
  // twice — identical red text, twice, on every fill surface. Their branch
  // only falls back to help; the rest keep the original behaviour.
  const helpErr =
    error && !labelable ? (
      <p className="mt-1 text-xs text-danger-text">{error}</p>
    ) : field.help ? (
      <p className="mt-1 text-xs text-text-tertiary">{field.help}</p>
    ) : null;

  const body = (() => {
    switch (field.type) {
      case 'text':
        return (
          <Input
            id={controlId}
            value={asString(value)}
            placeholder={field.placeholder}
            error={error}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      case 'number':
        return (
          <Input
            id={controlId}
            type="number"
            value={asString(value)}
            placeholder={field.placeholder}
            error={error}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      case 'textarea':
        return (
          <Textarea
            id={controlId}
            value={asString(value)}
            placeholder={field.placeholder}
            error={error}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      case 'date':
        return (
          <DateTimePicker value={asString(value)} onChange={(v) => onChange(v)} disabled={disabled} />
        );
      case 'time':
        // A time-stamp question: "Now" writes the current time, and the value
        // stays an ordinary time input the respondent can adjust afterwards.
        return (
          <div className="flex items-center gap-1.5">
            <Input
              type="time"
              value={asString(value)}
              error={error}
              disabled={disabled}
              aria-label={field.label}
              onChange={(e) => onChange(e.target.value)}
            />
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(currentTimeHHMM())}
              aria-label={`Stamp current time: ${field.label}`}
              className="flex h-9 flex-none items-center gap-1 rounded-md border border-border-strong bg-surface-card px-2.5 text-[12.5px] font-semibold text-text-secondary hover:bg-surface-hover focus-visible:shadow-focus disabled:opacity-40"
            >
              <Icon name="clock" size={14} />
              Now
            </button>
          </div>
        );
      case 'dropdown':
        return (
          <Select
            id={controlId}
            options={field.options ?? []}
            value={asString(value)}
            placeholder="Select an option…"
            error={error}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      case 'radio':
        return (
          <div className="flex flex-col gap-2" role="radiogroup" aria-labelledby={labelId}>
            {(field.options ?? []).map((o) => (
              <Radio
                key={o}
                name={field.id}
                label={o}
                checked={asString(value) === o}
                disabled={disabled}
                onChange={() => onChange(o)}
              />
            ))}
          </div>
        );
      case 'boolean_yes_no':
        return (
          <div className="flex gap-4" role="radiogroup" aria-labelledby={labelId}>
            {['Yes', 'No'].map((o) => (
              <Radio
                key={o}
                name={field.id}
                label={o}
                checked={(value === true && o === 'Yes') || (value === false && o === 'No')}
                disabled={disabled}
                onChange={() => onChange(o === 'Yes')}
              />
            ))}
          </div>
        );
      /*
        AN OUTCOME BOX IS A VERDICT, AND BOTH OF ITS ANSWERS ARE FINDINGS.

        `check_cross` had no case here at all, so it fell through to the
        unsupported-type placeholder below and rendered as a grey chip printing
        the literal string "check_cross". On a competency assessment that is not
        an obscure corner: it is the type of every theory question's outcome
        box, and of the satisfactory / not-yet-competent boxes on every part's
        sign-off — the fields an assessor spends the whole session in.

        THREE STATES, NOT TWO. Unlike `checkbox`, whose false is simply
        unticked, a cross here means "I checked this and it failed" — the
        distinction the exporter draws when it prints a tick for true, a cross
        for false, and NOTHING for null (`round-trip.ts`, SELF_ANSWERING). So
        the control has to offer a way back to unanswered, or an assessor who
        mis-clicks can never restore a box to the one state that means nobody
        has assessed this.

        Clicking the chosen verdict again is that way back, which is also why
        these are buttons rather than radios: a radio group cannot be un-chosen.
      */
      case 'check_cross': {
        const verdicts = [
          { on: true, label: 'Satisfactory', icon: 'check' },
          { on: false, label: 'Not satisfactory', icon: 'x' },
        ] as const;
        return (
          <div className="flex flex-wrap gap-2" role="group" aria-labelledby={labelId}>
            {verdicts.map((v) => {
              const selected = value === v.on;
              return (
                <button
                  key={v.label}
                  type="button"
                  disabled={disabled}
                  aria-pressed={selected}
                  onClick={() => onChange(selected ? null : v.on)}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${
                    selected
                      ? v.on
                        ? 'border-border-accent bg-success-soft text-success-text'
                        : 'border-danger bg-danger-soft text-danger-text'
                      : 'border-border bg-surface-card text-text-secondary'
                  }`}
                >
                  <Icon name={v.icon} size={14} />
                  {v.label}
                </button>
              );
            })}
          </div>
        );
      }
      case 'checkbox':
        return (
          <Checkbox
            label={field.label}
            checked={value === true}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
          />
        );
      case 'checkbox_group': {
        const selected = Array.isArray(value) ? (value as string[]) : [];
        const toggle = (option: string, checked: boolean) =>
          onChange(checked ? [...selected, option] : selected.filter((x) => x !== option));

        /*
          A MATCHING QUESTION IS A CHECKBOX GROUP WEARING A DIFFERENT LAYOUT.

          "Match the statement with the appropriate signage" is stored as every
          possible pairing — three statements against three signs is nine
          options — so a flat list gives the candidate nine lines each
          repeating a whole statement, and asks them to sort the block mentally
          before they can answer.

          Grouped by statement it reads the way the paper does: the statement
          once, then its candidate answers. The VALUE is unchanged — the same
          array of the same pairing strings — so marking, storage and the
          exported evidence see exactly what a flat group would have produced.
          Presentation only.
        */
        if (isMatchingQuestion(field.options)) {
          /*
            AN AUTHORED PRESENTATION WINS; THE GROUPED LIST IS THE FALLBACK.

            `matchPresentation` is set by the pair builder and is render-only by
            type — `markTheory` reads `answerKey` and nothing else — so choosing
            between these two changes what a candidate manipulates and nothing
            about what is stored or how it is marked. A question authored before
            presentations existed has none, and renders exactly as it always
            has.
          */
          if (field.matchPresentation) {
            return (
              <MatchingField
                options={field.options ?? []}
                value={selected}
                presentation={field.matchPresentation}
                disabled={disabled}
                labelId={labelId}
                onChange={onChange}
              />
            );
          }

          return (
            <div className="flex flex-col gap-3.5" role="group" aria-labelledby={labelId}>
              {groupPairingOptions(field.options ?? []).map((group, index) => {
                const groupId = `${labelId}-match-${index}`;
                return (
                  <div key={group.left} role="group" aria-labelledby={groupId}>
                    <div id={groupId} className="mb-1.5 text-[13px] font-semibold text-text-secondary">
                      {group.left}
                    </div>
                    <div className="flex flex-col gap-2 pl-3">
                      {group.options.map((option) => (
                        <Checkbox
                          key={option}
                          /*
                            The RIGHT half only. The left half is the heading
                            directly above it, and repeating it on every choice
                            is what made the flat list unreadable. The stored
                            value is still the whole pairing.
                          */
                          label={parsePairingOption(option)?.right ?? option}
                          checked={selected.includes(option)}
                          disabled={disabled}
                          onChange={(e) => toggle(option, e.target.checked)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        }

        return (
          <div className="flex flex-col gap-2" role="group" aria-labelledby={labelId}>
            {(field.options ?? []).map((o) => (
              <Checkbox
                key={o}
                label={o}
                checked={selected.includes(o)}
                disabled={disabled}
                onChange={(e) => toggle(o, e.target.checked)}
              />
            ))}
          </div>
        );
      }
      case 'signature':
        return (
          <SignaturePad
            value={asString(value)}
            onChange={(v) => onChange(v)}
            aria-label={field.label}
          />
        );
      case 'file_upload':
        return (
          <FileUploadField
            field={field}
            value={value}
            onChange={onChange}
            disabled={disabled}
            uploadPath={uploadPath}
          />
        );
      case 'repeating_group': {
        const rows = resolveRepeatingRows(field, value);
        // Answer-set resolution stays here: @formai/ui is dependency-free, so
        // the component is handed the surviving sets plus a resolved selection.
        const sets = resolveAnswerSets(field).sets;
        // Calc semantics live in @formai/shared for the same reason: the
        // component only knows a column is `computed` (read-only); the value
        // is recomputed and STORED on every row change here, so validation,
        // the detail view and the PDF export all read the same figure.
        const columns = (field.columns ?? []).map((c) => (c.calc ? { ...c, computed: true } : c));
        const withCalcs = (next: readonly RepeatingRow[]) =>
          applyCalcs(field.columns, next as RepeatingRowValue[]) as RepeatingRow[];
        return (
          <RepeatingGroup
            columns={columns}
            rows={rows as RepeatingRow[]}
            onChange={(next) => onChange(withCalcs(next))}
            readOnly={disabled}
            fixedRows={field.fixedRows}
            answerSets={sets}
            answerSelection={(ri, set) => selectedOption(set, rows[ri]).columnKey}
            onAnswerSelect={(ri, set, columnKey) =>
              onChange(
                withCalcs(
                  rows.map((r, i) =>
                    i === ri ? applySelection(set, r as RepeatingRowValue, columnKey) : r,
                  ) as RepeatingRow[],
                ),
              )
            }
            errorRowIndexes={
              incompleteRowIndexes ??
              (error && field.fixedRows?.length
                ? incompleteFixedRowIndices(field, value)
                : undefined)
            }
          />
        );
      }
      default:
        return (
          <div className="flex h-9 items-center gap-2 rounded-md border border-border bg-surface-sunken px-3 text-[13px] text-text-tertiary">
            <Icon name="help-circle" size={15} />
            {field.type}
          </div>
        );
    }
  })();

  // Dictation is layered OVER the rendered control, never in place of it: the
  // input above stays typeable in every state, including while listening.
  const control =
    dictation && !disabled && canDictateField(field) ? (
      <DictationRow field={field} onChange={onChange}>
        {body}
      </DictationRow>
    ) : (
      body
    );

  // Single checkbox already carries its own label.
  if (field.type === 'checkbox') {
    return (
      <div>
        {control}
        {helpErr}
      </div>
    );
  }

  return (
    <div>
      {label}
      {control}
      {helpErr}
    </div>
  );
}

interface DictationRowProps {
  field: FormField;
  onChange: (value: SubmissionValue) => void;
  children: React.ReactNode;
}

/**
 * One field's control with a mic beside it.
 *
 * Each session is judged on its own words — the transcript is dropped after
 * every stop — so a second dictation reads as a correction rather than a
 * continuation. Without that, saying "twelve" and then "no, fifteen" coerces
 * the concatenation while the first answer is already sitting in the field.
 *
 * The heard phrase is shown whenever it produced nothing, because the
 * alternative is a mic that visibly worked and a field that stayed empty for
 * no stated reason.
 */
function DictationRow({ field, onChange, children }: DictationRowProps) {
  const [unread, setUnread] = useState<string | null>(null);
  const resetRef = useRef<() => void>(() => {});

  const dictation = useDictation({
    onResult: (text) => {
      const coerced = coerceSpokenValue(field, text);
      // Cleared either way: a rejected phrase left in the buffer would be
      // re-parsed alongside words the respondent has already moved past.
      resetRef.current();
      if (coerced === null) {
        setUnread(text);
        return;
      }
      setUnread(null);
      onChange(coerced);
    },
  });
  resetRef.current = dictation.reset;

  // No WASM, getUserMedia or AudioContext means no mic at all — a dead control
  // on a form somebody has to complete is worse than no control.
  if (!dictation.supported) return <>{children}</>;

  const listening = dictation.status === 'listening';
  const problem =
    dictation.error?.message ??
    (unread === null
      ? null
      : `Heard “${unread}” — that didn't fill anything in. Say it again, or type your answer.`);
  // Empty while listening: what is being heard is announced by MicButton, and
  // the partial above is deliberately kept out of the accessibility tree.
  const announcement = listening ? '' : (problem ?? '');

  return (
    <div>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">{children}</div>
        <MicButton
          status={dictation.status}
          onStart={() => {
            setUnread(null);
            dictation.start();
          }}
          onStop={dictation.stop}
          label={`Dictate an answer for ${field.label}`}
        />
      </div>
      {listening ? (
        // Hidden from assistive tech: MicButton already announces that
        // recording started, and a live region fed by partial results would
        // re-read the half-heard sentence on every word.
        <p aria-hidden="true" className="mt-1 truncate text-xs text-text-tertiary">
          {dictation.text || 'Listening…'}
        </p>
      ) : null}

      {/* One live region, always mounted (same rule as SmartFillPanel's): a
          `role="status"` node inserted at the moment it gains its text is
          frequently missed by screen readers. MicButton's own region says only
          "Recording stopped.", so without this the respondent hears that the
          mic worked and is never told why the field stayed empty. */}
      <p role="status" className={`text-xs text-warning-text ${announcement ? 'mt-1' : ''}`}>
        {announcement}
      </p>
    </div>
  );
}

/** `accept` attribute covering exactly what the upload routes will store. */
const ATTACHMENT_ACCEPT = Object.keys(ALLOWED_ATTACHMENT_TYPES).join(',');

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A `file_upload` field that actually stores bytes.
 *
 * This previously recorded `files[0].name` and nothing else — the value looked
 * answered, validation passed, the submission saved, and the file never left
 * the browser. A required "Driver's licence image" could be satisfied by
 * picking a file and immediately closing the laptop. So the upload happens on
 * pick, and the field's value only becomes a ref once storage has the bytes.
 *
 * Type and size are checked here too, before the read: rejecting a 40 MB video
 * locally is instant and specific, where letting it through means base64-ing it
 * and waiting for a 413.
 */
function FileUploadField({
  field,
  value,
  onChange,
  disabled,
  uploadPath,
}: {
  field: FormField;
  value: SubmissionValue;
  onChange: (value: SubmissionValue) => void;
  disabled?: boolean;
  uploadPath?: string | null;
}) {
  const ref = isFileRef(value) ? value : null;
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [uploadError, setUploadError] = useState('');
  /**
   * Preview of the file the respondent just picked, from the local `File` —
   * not from the server. The public fill page has no authenticated way to read
   * an attachment back (deliberately: see uploads.ts), and even on an authed
   * surface a local URL avoids a round trip for bytes the browser already has.
   */
  const [localPreview, setLocalPreview] = useState('');
  const previewUrlRef = useRef('');

  // Object URLs are held by the document until explicitly released.
  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    [],
  );

  const uploading = progress !== undefined;

  async function pick(file: File) {
    setUploadError('');

    if (!ALLOWED_ATTACHMENT_TYPES[file.type]) {
      setUploadError('Choose a PNG, JPEG, WebP or PDF file.');
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setUploadError(
        `That file is ${formatBytes(file.size)} — the limit is ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
      );
      return;
    }

    // Show the picked image immediately; the upload runs behind it.
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = file.type.startsWith('image/') ? URL.createObjectURL(file) : '';
    setLocalPreview(previewUrlRef.current);

    // Builder preview: render the interaction, persist nothing.
    if (uploadPath === null) return;

    setProgress(0);
    try {
      const stored = await uploadAttachment<SubmissionFileRef>(
        uploadPath ?? '/uploads',
        file,
        setProgress,
      );
      onChange(stored);
    } catch (err) {
      // The value stays unset on failure — an upload that did not complete must
      // never leave the field looking answered.
      onChange(null);
      setLocalPreview('');
      setUploadError(
        err instanceof ApiError && err.status === 413
          ? 'That file is too large — the limit is 10 MB.'
          : err instanceof ApiError && err.status === 400
            ? "That file's contents don't match its type. Try re-saving or choosing another."
            : err instanceof ApiError && err.status === 401
              ? 'Your session expired. Sign in again, then re-attach the file.'
              : 'Upload failed — check your connection and try again.',
      );
    } finally {
      setProgress(undefined);
    }
  }

  function clear() {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = '';
    setLocalPreview('');
    setUploadError('');
    onChange(null);
  }

  const isImage = ref ? ref.contentType.startsWith('image/') : !!localPreview;
  // Falls back to the authed serving route for a ref loaded from a saved
  // record, where no local File exists (e.g. resuming a draft).
  const previewSrc =
    localPreview || (ref && isImage && uploadPath !== null ? `/api/uploads/file/${ref.key}` : '');

  return (
    <div>
      <FileDropzone
        onFiles={(files) => {
          const file = files[0];
          if (file) void pick(file);
        }}
        accept={ATTACHMENT_ACCEPT}
        progress={progress}
        selectedName={ref?.fileName}
        hint={field.help ?? 'PNG, JPEG, WebP or PDF · up to 10 MB'}
        disabled={disabled || uploading}
      />

      {previewSrc && (
        <img
          src={previewSrc}
          alt={ref ? `Preview of ${ref.fileName}` : 'Preview of the selected file'}
          className="mt-2 h-20 w-20 rounded-md border border-border object-cover"
        />
      )}

      {ref && !uploading && (
        <div className="mt-2 flex items-center gap-2 text-xs text-text-tertiary">
          <Icon name="check" size={13} className="text-success" />
          <span className="truncate">
            {ref.fileName} · {formatBytes(ref.size)}
          </span>
          {/* Padded to a ~44px hit target, negative margins cancelling the
              layout cost — this row renders on the mobile field app too. */}
          {!disabled && (
            <button
              type="button"
              onClick={clear}
              aria-label={`Remove ${ref.fileName}`}
              className="-my-3.5 ml-auto shrink-0 px-2 py-3.5 font-semibold text-text-accent hover:underline"
            >
              Remove
            </button>
          )}
        </div>
      )}

      {uploadError && <p className="mt-1 text-xs text-danger-text">{uploadError}</p>}
    </div>
  );
}
