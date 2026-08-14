import { useMemo, useState } from 'react';
import { Icon } from '@formai/ui';
import {
  hasAnyMatchSide,
  hasBothMatchSides,
  isChoiceField,
  isMatchingQuestion,
  isSelfAnswering,
  type DraftAnswerKey,
  type FormField,
  type FormFieldType,
} from '@formai/shared';
import { PairBuilder } from '../PairBuilder.js';
import { KeySourceChooser } from '../KeySourceChooser.js';
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
    Every box a derived ✓/✗ could land in.

    `isSelfAnswering` is the EXPORTER'S list, not one written here. A target
    outside it passes `validateAnswerKeys` — which only checks the field exists
    — and then draws nothing, so the mark computes, validates, publishes, and
    never reaches the page. Offering only what the exporter marks is what makes
    that state unreachable from this screen.
  */
  const outcomeBoxes = useMemo(
    () => fields.filter((f) => isSelfAnswering(f.type) && !excluded.has(f.id)),
    [fields, excluded],
  );

  /** The extracted counterpart, which is where the matching sides live. */
  const extractedById = useMemo(
    () => new Map((extraction?.fields ?? []).map((f) => [f.id, f])),
    [extraction],
  );

  /*
    A question is anything with options — OR a matching question the extraction
    found, which by contract has NONE.

    THE SECOND HALF IS NOT AN EXTRA CASE, IT IS THE FEATURE. The extraction tool
    schema tells the model, for a matching question, to "leave options empty:
    the pairings are derived from the two sides" — so `matchLeft`/`matchRight`
    arrive and `options` does not. Filtering on options alone therefore dropped
    every matching question from the only step that can configure one: step 1
    counted them (`matchesComplete` / `matchesIncomplete`) and step 5 offered
    nowhere to open a single one. The pair builder — and the picture upload
    inside it — was reachable only from ordinary multiple-choice questions,
    which is to say from every question except the ones it exists for.

    EITHER side is enough. A one-sided read is exactly what the author is here
    to finish, and it is what step 1 already counts as `matchesIncomplete`.

    Excluded questions are deliberately absent rather than shown greyed: the
    author already said this one is off the digital form, and a key for a
    question nobody answers is work that produces nothing.
  */
  const questions = useMemo(
    () =>
      fields.filter((f) => {
        if (excluded.has(f.id)) return false;
        if (isChoiceField(f.type) && (f.options?.length ?? 0) > 0) return true;
        const extracted = extractedById.get(f.id);
        return !!extracted && hasAnyMatchSide(extracted);
      }),
    [fields, excluded, extractedById],
  );

  const keyById = useMemo(() => new Map(keys.map((k) => [k.fieldId, k])), [keys]);
  /*
    A VERDICT IS NOT PART OF THE DENOMINATOR.

    "Assessment Result", "More coaching required?", "The Candidate's responses
    were:" — an assessment paper is full of choices the ASSESSOR makes, and
    extraction reads each as an ordinary question because on the page that is
    what it looks like. Counting them means "N of 33 keyed" can never complete
    and a genuinely unkeyed question hides among a dozen that were never
    keyable.
  */
  const keyable = questions.filter((q) => !q.assessorVerdict);
  const keyed = keyable.filter((q) => keyById.has(q.id)).length;
  const verified = keyable.filter((q) => keyById.get(q.id)?.verifiedAt).length;

  if (questions.length === 0) {
    return (
      <p className="rounded-[14px] border border-border bg-surface-card p-4 text-[12.5px] text-text-secondary">
        No keyable questions were found. A question needs printed options, or a matching
        question&rsquo;s two printed sides, before it can be keyed — correct a field&rsquo;s type
        in <strong>Generate</strong> if one was read as something else.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 rounded-[14px] border border-border bg-surface-card p-4">
        <span className="min-w-0 flex-1">
          <span className="block text-[14.5px] font-semibold">Answer key</span>
          <span className="mt-0.5 block text-[11.5px] text-text-tertiary">
            {keyed} of {keyable.length} keyed · {verified} verified · marking is an exact set —
            the candidate must select every listed answer and nothing else
          </span>
        </span>
        <span
          className="h-1.5 w-32 flex-none overflow-hidden rounded-full bg-surface-sunken"
          role="progressbar"
          aria-valuenow={keyed}
          aria-valuemin={0}
          aria-valuemax={keyable.length}
          aria-label="Questions keyed"
        >
          <span
            className="block h-full rounded-full bg-accent"
            style={{ width: `${Math.round((keyed / questions.length) * 100)}%` }}
          />
        </span>
      </div>

      <KeySourceChooser
        sections={draft.structure}
        fields={fields}
        excluded={excluded}
        onSeed={keyOps.seedKeys}
      />

      {questions.map((question, i) => {
        const key = keyById.get(question.id);
        const extracted = extractedById.get(question.id);
        /*
          Matching by EITHER route: pairings already built into options by a
          previous save, or the two printed sides the extraction read. Reading
          only the first left a freshly-extracted matching question labelled as
          a one-answer question and offered a type dropdown that cannot express
          it.
        */
        const matching = isMatchingQuestion(question.options) || (!!extracted && hasAnyMatchSide(extracted));
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

              {/*
                THE ESCAPE HATCH FOR A MIS-READ FIELD. An assessor's verdict
                looks exactly like a question on the page, so extraction cannot
                tell them apart — the author can, in one click, and until they
                could these sat in the list unkeyable and uncleared.
              */}
              {!matching && (
                <label className="flex flex-none items-center gap-1.5 text-[11px] text-text-secondary">
                  <input
                    type="checkbox"
                    checked={!!question.assessorVerdict}
                    aria-label={`${question.label} is an assessor verdict`}
                    onChange={(e) => keyOps.setAssessorVerdict(question.id, e.target.checked)}
                  />
                  Assessor verdict
                </label>
              )}
              {!matching && !question.assessorVerdict && (
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

              {!question.assessorVerdict && (
              <button
                type="button"
                onClick={() => setPairingFor(open ? null : question.id)}
                className="inline-flex h-[28px] flex-none items-center gap-1.5 rounded-lg border border-border px-2.5 text-[11px] font-semibold text-text-secondary hover:bg-surface-hover"
              >
                <Icon name="git-compare" size={12} />
                {/*
                  Three states, not two. A matching question the extraction just
                  read HAS no pairs yet, and "Edit pairs" invites the author to
                  look for something that is not there — on the button that is
                  the only way into the pair builder.
                */}
                {open
                  ? 'Close pairs'
                  : !matching
                    ? 'Make matching'
                    : (question.options?.length ?? 0) === 0
                      ? 'Build pairs'
                      : 'Edit pairs'}
              </button>
              )}
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
            ) : question.assessorVerdict ? (
              /*
                Shown, but not asked for a key. The printed options stay visible
                because they are what the assessor picks on the day — this says
                nothing is gradeable here, not that the field is unimportant.
              */
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                {(question.options ?? []).map((option) => (
                  <span
                    key={option}
                    className="rounded-lg border border-border-subtle bg-surface-sunken px-2.5 py-1 text-[11.5px] text-text-tertiary"
                  >
                    {option}
                  </span>
                ))}
                <span className="text-[11.5px] text-text-tertiary">
                  — the assessor chooses on the day. Nothing to key.
                </span>
              </div>
            ) : matching && (question.options?.length ?? 0) === 0 ? (
              /*
                A matching question the extraction read but nobody has paired
                yet has no options to show, and an empty chip row reads as "this
                question has no answers" rather than "the pairs are not built".
                Say which sides were found, so the author knows whether they are
                finishing a one-sided read or confirming a complete one.
              */
              <p className="mt-2.5 text-[11.5px] text-text-tertiary">
                {extracted && hasBothMatchSides(extracted)
                  ? `Both sides were read — ${extracted.matchLeft?.length ?? 0} prompts and ${extracted.matchRight?.length ?? 0} answers. Open the pairs to set which goes with which.`
                  : 'Only one side of this matching question was read. Open the pairs to type the other.'}
              </p>
            ) : (
              <OptionKeys question={question} draftKey={key} onToggle={keyOps.toggleOption} />
            )}

            {/*
              WHERE THE MARK LANDS, on the step that decides what the mark IS.

              The automatic route pairs a question with its outcome box by the
              printed reference both carry — right by default, and blind to a
              box the extraction MISSED, because nothing read a reference off a
              box nobody read. That case ends at publish as "has an answer key
              but no outcome box to write its mark into", with no control
              anywhere that could answer it. This is that control.

              Hidden when the document has no ✓/✗ boxes at all: a select whose
              only entry is "Automatic" asks the author to choose between one
              thing and nothing, and the publish gate already says what is
              actually wrong.
            */}
            {!question.assessorVerdict && outcomeBoxes.length > 0 && (
              <label className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px] text-text-tertiary">
                Mark lands in
                <select
                  aria-label={`Outcome box for ${question.label}`}
                  value={question.outcomeTarget?.fieldId ?? ''}
                  onChange={(e) =>
                    draft.fieldOps.setOutcomeTarget(question.id, e.target.value || null)
                  }
                  className="h-[26px] max-w-[260px] rounded-lg border border-border bg-surface-page px-2 text-[11px] text-text-secondary"
                >
                  {/*
                    NAMED FOR WHAT IT ACTUALLY DOES. It used to read "from the
                    printed reference", which in this builder resolved nothing
                    at all — the reference lives on the extracted field and
                    never reaches a `FormField`. The fallback that does the work
                    is document order, and the label has to say so or an author
                    cannot tell an inferred link from a read one.
                  */}
                  <option value="">Automatic — the ✓/✗ box printed after it</option>
                  {outcomeBoxes.map((box) => (
                    <option key={box.id} value={box.id}>
                      {box.label || box.id}
                    </option>
                  ))}
                </select>
              </label>
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

            {!question.assessorVerdict && key && (
              <div className="mt-2.5">
                <label className="text-[11px] text-text-tertiary">
                  Hint when incorrect
                  <span className="ml-1 text-text-quaternary">(optional — shown in interactive quiz mode)</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. Review Module 5: Safety Data Sheets"
                  value={question.answerHint ?? ''}
                  onChange={(e) =>
                    draft.fieldOps.patch(question.id, {
                      answerHint: e.target.value || undefined,
                    })
                  }
                  className="mt-1 h-[30px] w-full rounded-lg border border-border bg-surface-page px-2.5 text-[11.5px] text-text-primary placeholder:text-text-quaternary"
                />
              </div>
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
