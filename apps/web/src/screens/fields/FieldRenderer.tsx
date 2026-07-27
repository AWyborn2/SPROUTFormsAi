/**
 * Renders a FormField as an interactive input. Shared by the builder's live
 * preview and the external fill flow, so a field looks and behaves identically
 * wherever it appears. Values use the shared SubmissionValue union.
 */
import { useRef, useState } from 'react';
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
  type RepeatingRow,
} from '@formai/ui';
import type { FormField, SubmissionValue } from '@formai/shared';
import {
  applySelection,
  incompleteFixedRowIndices,
  resolveAnswerSets,
  selectedOption,
} from '@formai/shared';
import type { RepeatingRowValue } from '@formai/shared';
import { resolveRepeatingRows } from '../../lib/fixed-rows.js';
import { coerceSpokenValue, isDictatable, useDictation } from '../../lib/voice/index.js';

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
}

/**
 * Types this renderer both draws a control for and can read speech into.
 *
 * `check_cross` is dictatable in principle but has no case in the switch below
 * yet, so it falls through to the unsupported-type placeholder. A mic beside a
 * field with nothing to type into would make speaking the only way to answer
 * it, which voice is never allowed to be. Exported because Smart Fill has to
 * refuse to write the same fields for the same reason.
 */
export function canDictateField(field: FormField): boolean {
  return isDictatable(field.type) && field.type !== 'check_cross';
}

function asString(v: SubmissionValue): string {
  return v === null || v === undefined || Array.isArray(v) ? '' : String(v);
}

export function FieldInput({
  field,
  value,
  onChange,
  error,
  disabled,
  incompleteRowIndexes,
  dictation = false,
}: FieldInputProps) {
  if (field.type === 'section_header') {
    return (
      <div className="border-b border-border-subtle pb-2 pt-2">
        <h4 className="text-[15px] font-bold text-text-primary">{field.label}</h4>
        {field.help && <p className="mt-1 text-[12.5px] text-text-tertiary">{field.help}</p>}
      </div>
    );
  }

  const label = (
    <div className="mb-1.5 text-[13px] font-semibold text-text-primary">
      {field.label}
      {field.required && <span className="ml-0.5 text-danger">*</span>}
    </div>
  );
  const helpErr = error ? (
    <p className="mt-1 text-xs text-danger-text">{error}</p>
  ) : field.help ? (
    <p className="mt-1 text-xs text-text-tertiary">{field.help}</p>
  ) : null;

  const body = (() => {
    switch (field.type) {
      case 'text':
        return (
          <Input
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
      case 'dropdown':
        return (
          <Select
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
          <div className="flex flex-col gap-2">
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
          <div className="flex gap-4">
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
        return (
          <div className="flex flex-col gap-2">
            {(field.options ?? []).map((o) => (
              <Checkbox
                key={o}
                label={o}
                checked={selected.includes(o)}
                disabled={disabled}
                onChange={(e) =>
                  onChange(
                    e.target.checked ? [...selected, o] : selected.filter((x) => x !== o),
                  )
                }
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
          <FileDropzone
            onFiles={(files) => onChange(files[0]?.name ?? '')}
            selectedName={asString(value) || undefined}
            hint="PDF, image or document"
          />
        );
      case 'repeating_group': {
        const rows = resolveRepeatingRows(field, value);
        // Answer-set resolution stays here: @formai/ui is dependency-free, so
        // the component is handed the surviving sets plus a resolved selection.
        const sets = resolveAnswerSets(field).sets;
        return (
          <RepeatingGroup
            columns={field.columns ?? []}
            rows={rows as RepeatingRow[]}
            onChange={(next) => onChange(next)}
            readOnly={disabled}
            fixedRows={field.fixedRows}
            answerSets={sets}
            answerSelection={(ri, set) => selectedOption(set, rows[ri]).columnKey}
            onAnswerSelect={(ri, set, columnKey) =>
              onChange(
                rows.map((r, i) =>
                  i === ri ? applySelection(set, r as RepeatingRowValue, columnKey) : r,
                ) as RepeatingRow[],
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
