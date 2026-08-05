import { useMemo, useState } from 'react';
import { Icon } from '@formai/ui';
import {
  isChoiceField,
  isMatchingQuestion,
  type DraftAnswerKey,
  type FormField,
  type FormFieldType,
} from '@formai/shared';
import { PairBuilder } from '../PairBuilder.js';
import { seedFromField } from '../matching-authoring.js';
import type { BuilderDraftState } from '../use-builder-draft.js';

/**
 * Step 5 — the answer key.
 *
 * THIS IS THE STEP THAT RETIRES A FILE. Today a tool's answers live in
 * `docs/assessment-tools/track-dozer.answer-key.json`, keyed by section and
 * question NUMBER — a number no published field carries — so the authoring
 * script consumes them positionally and refuses outright on an off-by-one.
 * Keyed here, an answer is attached to the field id it belongs to and the
 * alignment problem stops existing.
 *
 * MARKING IS AN EXACT SET, AND THE UI SAYS SO. `markTheory` compares the
 * candidate's selection against `answerKey` as a set: every listed option and
 * nothing else. That is one rule for both printed shapes — a single-answer
 * question is a one-element key — but it means an extra option on a
 * single-answer question fails everyone who answers it correctly, so which
 * questions accumulate and which replace is a correctness matter and is driven
 * off the field's own `selectionType`.
 *
 * A KEY IS NEVER SERVED TO A FILL SURFACE. `stripMarkingSecrets` is what
 * enforces that on the way out; nothing here weakens it. The keys live on the
 * draft until publish, and the draft is an authoring surface behind
 * `requirePlanFeature('assessments')`.
 *
 * VERIFICATION IS AN ATTESTATION, NOT A GATE. An unverified key still marks —
 * refusing to would leave the assessment unusable — but who confirmed it and
 * when is recorded, because on a safety-critical assessment "an AI read it off
 * a guide" and "the training authority checked it against the source manuals"
 * are different claims.
 */

/** The question types this step can key, and what to call them. */
const KEYABLE_TYPES: { type: FormFieldType; label: string }[] = [
  { type: 'radio', label: 'One answer' },
  { type: 'checkbox_group', label: 'Several answers' },
  { type: 'dropdown', label: 'Dropdown' },
  { type: 'boolean_yes_no', label: 'Yes / No' },
];

export interface AnswerKeyStepProps {
  draft: BuilderDraftState;
  /** Who an attestation is recorded against. */
  actor?: string;
}

export function AnswerKeyStep({ draft, actor = 'You' }: AnswerKeyStepProps) {
  const { fields, keys, excluded, keyOps, extraction } = draft;
  const [pairingFor, setPairingFor] = useState<string | null>(null);

  /*
    A question is anything with options that is not excluded.

    Excluded questions are deliberately absent rather than shown greyed: the
    author already said this one is off the digital form, and a key for a
    question nobody answers is work that produces nothing.
  */
  const questions = useMemo(
    () =>
      fields.filter(
        (f) => isChoiceField(f.type) && (f.options?.length ?? 0) > 0 && !excluded.has(f.id),
      ),
    [fields, excluded],
  );

  const keyById = useMemo(() => new Map(keys.map((k) => [k.fieldId, k])), [keys]);
  const keyed = questions.filter((q) => keyById.has(q.id)).length;
  const verified = questions.filter((q) => keyById.get(q.id)?.verifiedAt).length;

  /** The extracted counterpart, which is where the matching sides live. */
  const extractedById = useMemo(
    () => new Map((extraction?.fields ?? []).map((f) => [f.id, f])),
    [extraction],
  );

  if (questions.length === 0) {
    return (
      <p className="rounded-[14px] border border-border bg-surface-card p-4 text-[12.5px] text-text-secondary">
        No keyable questions were found. A question needs printed options before it can be keyed —
        correct a field&rsquo;s type in <strong>Generate</strong> if one was read as something else.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 rounded-[14px] border border-border bg-surface-card p-4">
        <span className="min-w-0 flex-1">
          <span className="block text-[14.5px] font-semibold">Answer key</span>
          <span className="mt-0.5 block text-[11.5px] text-text-tertiary">
            {keyed} of {questions.length} keyed · {verified} verified · marking is an exact set —
            the candidate must select every listed answer and nothing else
          </span>
        </span>
        <span
          className="h-1.5 w-32 flex-none overflow-hidden rounded-full bg-surface-sunken"
          role="progressbar"
          aria-valuenow={keyed}
          aria-valuemin={0}
          aria-valuemax={questions.length}
          aria-label="Questions keyed"
        >
          <span
            className="block h-full rounded-full bg-accent"
            style={{ width: `${Math.round((keyed / questions.length) * 100)}%` }}
          />
        </span>
      </div>

      {questions.map((question, i) => {
        const key = keyById.get(question.id);
        const matching = isMatchingQuestion(question.options);
        const open = pairingFor === question.id;

        return (
          <div key={question.id} className="rounded-[14px] border border-border bg-surface-card p-4">
            <div className="flex items-start gap-2">
              {/*
                The printed reference where extraction read one, and the
                position otherwise. `questionRef` lives on the EXTRACTED field —
                it is what pairs a question with its outcome box, and showing it
                here is what lets an author check a key against the paper.
              */}
              <span className="mt-[3px] w-8 flex-none text-[11.5px] font-semibold text-text-tertiary">
                {extractedById.get(question.id)?.questionRef ?? i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-semibold">{question.label}</span>
                <span className="mt-0.5 block text-[11px] text-text-tertiary">
                  {matching ? 'Matching' : (question.selectionType === 'multiple' ? 'Several answers' : 'One answer')}
                  {' · '}
                  {question.options?.length ?? 0} option
                  {(question.options?.length ?? 0) === 1 ? '' : 's'}
                  {key ? ` · ${key.answerKey.length} keyed` : ' · not keyed'}
                </span>
              </span>

              {!matching && (
                <select
                  aria-label={`Question type for ${question.label}`}
                  value={question.type}
                  onChange={(e) => draft.structureOps.setFieldType(question.id, e.target.value as FormFieldType)}
                  className="h-[28px] flex-none rounded-lg border border-border bg-surface-page px-2 text-[11px]"
                >
                  {KEYABLE_TYPES.map((t) => (
                    <option key={t.type} value={t.type}>
                      {t.label}
                    </option>
                  ))}
                </select>
              )}

              <button
                type="button"
                onClick={() => setPairingFor(open ? null : question.id)}
                className="inline-flex h-[28px] flex-none items-center gap-1.5 rounded-lg border border-border px-2.5 text-[11px] font-semibold text-text-secondary hover:bg-surface-hover"
              >
                <Icon name="git-compare" size={12} />
                {open ? 'Close pairs' : matching ? 'Edit pairs' : 'Make matching'}
              </button>
            </div>

            {open ? (
              <div className="mt-3">
                <PairBuilder
                  seed={seedFromField({
                    options: question.options,
                    answerKey: key?.answerKey,
                    // The sides live on the EXTRACTED field: `FormField` does not
                    // carry them, and the builder's editable copy is seeded
                    // without them.
                    matchLeft: extractedById.get(question.id)?.matchLeft,
                    matchRight: extractedById.get(question.id)?.matchRight,
                  })}
                  presentation={question.matchPresentation}
                  onSave={(built, presentation) => {
                    keyOps.saveMatching(question.id, built, presentation);
                    setPairingFor(null);
                  }}
                  onCancel={() => setPairingFor(null)}
                />
              </div>
            ) : (
              <OptionKeys question={question} draftKey={key} onToggle={keyOps.toggleOption} />
            )}

            {key && (
              <label className="mt-2.5 inline-flex items-center gap-1.5 text-[11.5px] text-text-secondary">
                <input
                  type="checkbox"
                  checked={!!key.verifiedAt}
                  onChange={(e) => keyOps.setVerified(question.id, e.target.checked, actor)}
                />
                Verified by the training authority
                {key.verifiedAt && (
                  <span className="text-text-tertiary">
                    {' — '}
                    {key.verifiedBy} on {key.verifiedAt.slice(0, 10)}
                  </span>
                )}
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface OptionKeysProps {
  question: FormField;
  draftKey?: DraftAnswerKey;
  onToggle: (fieldId: string, option: string, multiple: boolean) => void;
}

function OptionKeys({ question, draftKey, onToggle }: OptionKeysProps) {
  /*
    WHICH QUESTIONS ACCUMULATE IS THE FIELD'S OWN `selectionType`, not a guess
    from how many options it has. `retypeField` maintains it, and marking's
    exact-set rule makes getting it wrong decisive rather than cosmetic.
  */
  const multiple = question.selectionType === 'multiple';
  const selected = new Set(draftKey?.answerKey ?? []);

  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5">
      {(question.options ?? []).map((option) => {
        const on = selected.has(option);
        return (
          <button
            key={option}
            type="button"
            role="checkbox"
            aria-checked={on}
            aria-label={`${option} is correct`}
            onClick={() => onToggle(question.id, option, multiple)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11.5px] ${
              on
                ? 'border-accent bg-surface-accent-soft font-semibold text-text-accent'
                : 'border-border text-text-secondary hover:bg-surface-hover'
            }`}
          >
            {on && <Icon name="check" size={12} />}
            {option}
          </button>
        );
      })}
    </div>
  );
}
