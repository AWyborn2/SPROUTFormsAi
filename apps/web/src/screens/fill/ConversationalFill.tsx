import { useRef, useState } from 'react';
import { Icon, MicButton } from '@formai/ui';
import type { FormField, SmartFillResult, SubmissionValue } from '@formai/shared';
import { FieldInput, canDictateField } from '../fields/FieldRenderer.js';
import {
  buildSteps,
  canAdvance,
  progressAt,
  stepIndexForField,
  totalScreens,
  unansweredRequired,
} from '../../lib/fill-steps.js';
import { useDictation } from '../../lib/voice/index.js';
import {
  applyMappings,
  partitionByConfidence,
  smartFillSummary,
} from '../../lib/voice/smart-fill.js';

interface ConversationalFillProps {
  fields: FormField[];
  values: Record<string, SubmissionValue>;
  errors: Record<string, string>;
  setValue: (id: string, value: SubmissionValue) => void;
  /**
   * Apply a whole set of answers as one change, returning false if the screen
   * refused it (the respondent declined its discard warning). Smart Fill lands
   * many answers at once and must go through here rather than through
   * `setValue` per field — see the note on `runSmartFill` below.
   */
  applyValues: (patch: Record<string, SubmissionValue>) => boolean;
  onSubmit: () => void;
  submitting: boolean;
  /** Rendered on the first screen so identity is captured before questions. */
  header: React.ReactNode;
  /** Offer a per-field mic (free at every tier). Off unless the surface opts in. */
  dictation?: boolean;
  /**
   * Smart Fill (paid tiers): posts one whole-utterance transcript and resolves
   * the API's proposals, or `null` when the request failed and the caller has
   * already said why. Absent means no entry point is rendered at all — that
   * absence IS the plan gate on this screen, not a disabled button.
   */
  smartFill?: (transcript: string) => Promise<SmartFillResult | null>;
}

/** What the last Smart Fill run touched, so the respondent can see it and check it. */
interface SmartFillOutcome {
  /** Fields whose value the run changed. */
  filled: string[];
  /** The subset of those the model was unsure about — flagged harder. */
  uncertain: string[];
  /** Heard but placed on no question; shown so nothing spoken is silently lost. */
  unmapped: string[];
  summary: string;
}

const VOICE_TONE = {
  filled: {
    box: 'border-border-accent bg-surface-accent-soft',
    text: 'text-text-accent',
    icon: 'sparkles',
    note: 'Filled from what you said — check it reads right.',
    badge: 'From voice',
  },
  uncertain: {
    box: 'border-warning bg-warning-soft',
    text: 'text-warning-text',
    icon: 'triangle-alert',
    note: 'Heard, but not clearly — check this one before you submit.',
    badge: 'Check this',
  },
} as const;

/**
 * One question group per screen, with progress, next/back and a review step.
 *
 * All sequencing decisions live in `lib/fill-steps.ts` — and every decision
 * about what a spoken answer MEANS lives in `lib/voice/` — this component only
 * renders them. That split exists because components cannot be rendered in
 * this workspace's test environment, and "can the respondent advance past a
 * required field" is a silent data-loss bug when it is wrong, not a cosmetic
 * one.
 *
 * The submitted payload is identical to the single-page layout's: same fields,
 * same values, same endpoint. Only the pacing differs. Voice changes neither:
 * it writes through the screen's own setters — `setValue` per dictated field,
 * `applyValues` for a whole Smart Fill result — and the review step below is
 * still the only way to submit.
 */
export function ConversationalFill({
  fields,
  values,
  errors,
  setValue,
  applyValues,
  onSubmit,
  submitting,
  header,
  dictation = false,
  smartFill,
}: ConversationalFillProps) {
  const steps = buildSteps(fields);
  const [index, setIndex] = useState(0);
  const [touched, setTouched] = useState(false);
  const [smartFillPending, setSmartFillPending] = useState(false);
  const [outcome, setOutcome] = useState<SmartFillOutcome | null>(null);

  /**
   * Mirrors what a Smart Fill reply gets merged against, so the merge uses the
   * form as it stands when the reply LANDS rather than when the respondent
   * stopped speaking. The model round-trip takes seconds, and anything typed
   * during the wait — including an answer that changes which fields are
   * visible — would otherwise be judged against, and overwritten from, a
   * snapshot that has since moved on.
   */
  const latest = useRef({ values, fields });
  latest.current = { values, fields };

  const onReview = index >= steps.length;
  const step = steps[index];
  const blocking = onReview ? [] : unansweredRequired(step, values);
  const progress = progressAt(index, steps);

  const filledByVoice = new Set(outcome?.filled ?? []);
  const uncertainByVoice = new Set(outcome?.uncertain ?? []);
  const toneFor = (fieldId: string): keyof typeof VOICE_TONE | null =>
    uncertainByVoice.has(fieldId) ? 'uncertain' : filledByVoice.has(fieldId) ? 'filled' : null;

  const runSmartFill = (transcript: string) => {
    if (!smartFill) return;
    setSmartFillPending(true);
    void smartFill(transcript)
      .then((result) => {
        if (!result) return;
        // Smart Fill may only write fields this screen actually renders a
        // control for: an answer nobody can see or correct by hand would make
        // speaking the only way to give it.
        const { changes } = applyMappings(
          latest.current.values,
          result.mappings,
          latest.current.fields.filter(canDictateField),
        );
        const changed = new Set(changes.map((c) => c.fieldId));
        const uncertain = partitionByConfidence(result.mappings)
          .uncertain.map((m) => m.fieldId)
          .filter((id) => changed.has(id));

        // One merge through the caller, not a `setValue` per mapping: a spoken
        // answer still passes every guard a typed one does (R22's
        // hide-a-section warning among them), but it is asked ONCE and about
        // the form as it will actually stand — N prompts computed against a
        // pre-merge snapshot were both unanswerable and wrong.
        const patch: Record<string, SubmissionValue> = {};
        for (const change of changes) patch[change.fieldId] = change.next;
        // Declining that warning means nothing was applied, so there is
        // nothing to announce or highlight — the form is as they left it.
        if (!applyValues(patch)) return;

        setOutcome({
          filled: changes.map((c) => c.fieldId),
          uncertain,
          unmapped: result.unmapped ?? [],
          summary: smartFillSummary(changes.length, uncertain.length),
        });
      })
      .finally(() => setSmartFillPending(false));
  };

  // A submit-time failure must return the respondent to the screen that owns
  // the field, not strand them on review with an off-screen cause.
  const jumpToFirstError = () => {
    const firstErrorId = Object.keys(errors)[0];
    if (!firstErrorId) return false;
    const target = stepIndexForField(steps, firstErrorId);
    if (target >= 0) {
      setIndex(target);
      setTouched(true);
      return true;
    }
    return false;
  };

  if (steps.length === 0) {
    return <div className="py-4 text-center text-[13px] text-text-tertiary">This form has no fields.</div>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="mb-1.5 flex items-center justify-between text-[11.5px] text-text-tertiary">
          <span>
            {onReview ? 'Review' : `Question ${index + 1} of ${steps.length}`}
          </span>
          <span>{Math.round(progress * 100)}%</span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-border-subtle">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${progress * 100}%`, background: 'var(--org-accent)' }}
          />
        </div>
      </div>

      {/* Offered up front, where "describe the whole job" still saves the
          respondent something. It stays reachable afterwards via Back, and the
          outcome banner below travels with them through every question. */}
      {smartFill && index === 0 && (
        <SmartFillPanel
          onTranscript={runSmartFill}
          pending={smartFillPending}
          outcome={outcome}
        />
      )}

      {index === 0 && header}

      {onReview ? (
        <div>
          <div className="mb-3 text-sm font-bold text-text-primary">Check your answers</div>
          <ul className="flex flex-col divide-y divide-border-subtle">
            {steps.flatMap((s, si) =>
              s.fields.map((f) => {
                const tone = toneFor(f.id);
                return (
                  <li key={f.id} className="flex items-start justify-between gap-3 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12px] text-text-tertiary">{f.label}</span>
                      <span className="block text-[13px] text-text-primary">
                        {formatAnswer(values[f.id])}
                      </span>
                      {tone && (
                        // The badge survives to the last screen on purpose: the
                        // review step is where a mis-heard answer is meant to
                        // be caught, so it must still be marked when it gets here.
                        <span
                          className={`mt-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${VOICE_TONE[tone].box} ${VOICE_TONE[tone].text}`}
                        >
                          <Icon name={VOICE_TONE[tone].icon} size={11} />
                          {VOICE_TONE[tone].badge}
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => setIndex(si)}
                      className="flex-none text-[12px] font-semibold text-accent"
                    >
                      Edit
                    </button>
                  </li>
                );
              }),
            )}
          </ul>
        </div>
      ) : (
        <div>
          {step?.title && (
            <div
              className="mb-3"
              style={{
                fontSize: 'var(--org-heading-size)',
                fontWeight: 'var(--org-heading-weight)' as unknown as number,
              }}
            >
              {step.title}
            </div>
          )}
          <div className="flex flex-col gap-5">
            {step?.fields.map((f) => {
              const tone = toneFor(f.id);
              return (
                <div
                  key={f.id}
                  className={tone ? `-mx-2 rounded-md border-l-2 px-2 py-2 ${VOICE_TONE[tone].box}` : undefined}
                >
                  {tone && (
                    <p
                      className={`mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold ${VOICE_TONE[tone].text}`}
                    >
                      <Icon name={VOICE_TONE[tone].icon} size={12} />
                      {VOICE_TONE[tone].note}
                    </p>
                  )}
                  <FieldInput
                    field={f}
                    value={(values[f.id] ?? null) as never}
                    dictation={dictation}
                    error={
                      errors[f.id] ||
                      (touched && blocking.includes(f.id) ? 'This question is required.' : undefined)
                    }
                    onChange={(v) => setValue(f.id, v)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => {
            setTouched(false);
            setIndex((i) => Math.max(0, i - 1));
          }}
          disabled={index === 0}
          className="fai-chip-btn rounded-md border border-border px-3.5 py-2 text-[13px] font-semibold text-text-secondary disabled:opacity-40"
        >
          Back
        </button>

        {onReview ? (
          <button
            type="button"
            onClick={() => {
              if (!jumpToFirstError()) onSubmit();
            }}
            disabled={submitting}
            className="fai-lift flex items-center gap-2 px-5 py-2.5 text-[15px] font-bold disabled:opacity-60"
            style={{
              background: 'var(--org-accent)',
              color: 'var(--org-accent-text)',
              borderRadius: 'var(--org-button-radius)',
              fontFamily: 'var(--org-font)',
            }}
          >
            {submitting ? 'Submitting…' : 'Submit'}
            <Icon name="arrow-right" size={16} />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (!canAdvance(steps, index, values)) {
                setTouched(true);
                return;
              }
              setTouched(false);
              setIndex((i) => Math.min(totalScreens(steps) - 1, i + 1));
            }}
            className="fai-lift flex items-center gap-2 px-5 py-2.5 text-[15px] font-bold"
            style={{
              background: 'var(--org-accent)',
              color: 'var(--org-accent-text)',
              borderRadius: 'var(--org-button-radius)',
              fontFamily: 'var(--org-font)',
            }}
          >
            Next
            <Icon name="arrow-right" size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

interface SmartFillPanelProps {
  onTranscript: (transcript: string) => void;
  pending: boolean;
  outcome: SmartFillOutcome | null;
}

/**
 * The Smart Fill entry point: one mic for the whole form.
 *
 * It captures a transcript and hands it up — the request, the merge and the
 * highlighting all belong to the screen, which outlives this panel. A
 * respondent who presses Next while the model is still thinking would
 * otherwise lose every answer they just spoke.
 *
 * The panel cannot submit and says so. Everything it produces is a proposal
 * that has to survive the review step, because a mis-heard word on a
 * compliance form is a wrong answer with someone's name against it.
 */
function SmartFillPanel({ onTranscript, pending, outcome }: SmartFillPanelProps) {
  const resetRef = useRef<() => void>(() => {});
  const dictation = useDictation({
    onResult: (text) => {
      // Dropped as it is sent: the next utterance is a fresh description of the
      // form, not a continuation of the one already being mapped.
      resetRef.current();
      onTranscript(text);
    },
  });
  resetRef.current = dictation.reset;

  if (!dictation.supported) return null;

  const listening = dictation.status === 'listening';
  // One live region, always mounted: a `role="status"` node that appears only
  // when it has something to say is frequently missed by screen readers.
  const status = pending
    ? 'Matching what you said to the questions…'
    : (dictation.error?.message ?? outcome?.summary ?? '');

  return (
    <div className="rounded-lg border border-border bg-surface-sunken p-3.5">
      <div className="flex items-start gap-3">
        <MicButton
          status={dictation.status}
          disabled={pending}
          onStart={dictation.start}
          onStop={dictation.stop}
          label="Fill this form by voice"
          size="lg"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[13px] font-bold text-text-primary">
            <Icon name="sparkles" size={13} />
            Fill by voice
          </div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-text-secondary">
            Describe the job in your own words and your answers are placed on the questions they
            match. Nothing is sent anywhere until you review them and press Submit.
          </p>

          {listening ? (
            // Hidden from assistive tech: MicButton announces that recording
            // started, and a live region fed by partial results would re-read
            // the half-heard sentence on every word.
            <p aria-hidden="true" className="mt-2 text-[12px] italic text-text-tertiary">
              {dictation.text || 'Listening…'}
            </p>
          ) : null}

          <p
            role="status"
            className={`text-[12px] leading-relaxed text-text-secondary ${status ? 'mt-2' : ''}`}
          >
            {status}
          </p>

          {outcome && outcome.unmapped.length > 0 && (
            <p className="mt-1.5 text-[12px] leading-relaxed text-text-tertiary">
              Not matched to a question: {outcome.unmapped.join('; ')}. Add it by hand if it belongs
              on this form.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Human-readable echo of an answer on the review screen. */
function formatAnswer(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return 'Provided';
  return String(value);
}
