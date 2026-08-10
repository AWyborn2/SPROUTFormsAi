import { useMemo } from 'react';
import { Button, FileDropzone, Icon } from '@formai/ui';
import {
  ASSESSMENT_PATHWAYS,
  isChoiceField,
  hasAnyMatchSide,
  hasBothMatchSides,
  type AssessmentPathway,
  type ExtractedField,
} from '@formai/shared';
import { validateUploadFile } from '../../../import/upload-validation.js';
import { BUILDER_PHASES, type BuilderDraftState } from '../use-builder-draft.js';

/**
 * Step 1 — read the document, then ask the few questions its shape leaves open.
 *
 * THE SETUP QUESTIONS ARE NOT PREFERENCES. Each one seeds a decision a later
 * step has to make anyway: which pathways the manifest declares, what gates the
 * theory outcome, how the fill surface renders, and what a logbook threshold
 * does when it is reached. Asking here — while the document is fresh and the
 * counts are on screen — is what makes steps 4 and 7 mostly confirmation.
 *
 * THE BANK IS SHOWN BEFORE ANYTHING IS BUILT, because the one thing that
 * reliably goes wrong on this document class is a question read as the wrong
 * shape. Seeing thirty-one questions with their types is how an author catches
 * that in ten seconds rather than at the answer-key step.
 */

const PATHWAY_LABELS: Record<AssessmentPathway, string> = {
  new: 'New / inexperienced',
  experienced: 'Experienced',
  rpl: 'Recognition of prior learning',
};

const PATHWAY_HINTS: Record<AssessmentPathway, string> = {
  new: 'The full programme, every part.',
  experienced: 'A reduced set for a re-assessment.',
  rpl: 'Evidence-based; logged hours waived with a justification.',
};

/** What kind of question this is, in the words the answer-key step will use. */
function questionType(field: ExtractedField): { label: string; tone: string } {
  if (hasAnyMatchSide(field)) {
    return hasBothMatchSides(field)
      ? { label: 'Matching', tone: 'bg-warning-soft text-warning-text' }
      : { label: 'Matching — one side', tone: 'bg-danger-soft text-danger-text' };
  }
  const options = field.options ?? [];
  const isTrueFalse =
    options.length === 2 && options.every((o) => /^(true|false)$/i.test(o.trim()));
  if (isTrueFalse) return { label: 'True / False', tone: 'bg-info-soft text-info-text' };
  if (field.selectionType === 'multiple') {
    return { label: 'Multiple answers', tone: 'bg-success-soft text-success-text' };
  }
  return { label: 'Multiple choice', tone: 'bg-surface-sunken text-text-secondary' };
}

function Chip({
  on,
  onClick,
  children,
  recommended,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
  recommended?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors ${
        on
          ? 'border-border-accent bg-surface-accent-soft text-text-accent'
          : 'border-border bg-surface-card text-text-secondary hover:bg-surface-hover'
      }`}
    >
      {on && <Icon name="check" size={13} />}
      {children}
      {recommended && (
        <span className="rounded-full bg-success-soft px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.06em] text-success-text">
          Rec
        </span>
      )}
    </button>
  );
}

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="rounded-[14px] border border-border bg-surface-card p-[14px_16px]">
      <div className="font-heading text-[20px] font-bold">{value}</div>
      <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-text-tertiary">
        {label}
      </div>
    </div>
  );
}

export function UploadStep({ draft }: { draft: BuilderDraftState }) {
  const { phase, stats, extraction, setup } = draft;

  const questions = useMemo(
    () =>
      (extraction?.fields ?? []).filter(
        (f) => hasAnyMatchSide(f) || (isChoiceField(f.type) && (f.options?.length ?? 0) > 0),
      ),
    [extraction],
  );

  if (phase === 'idle' || phase === 'error') {
    return (
      <div className="mx-auto max-w-[780px]">
        <h2 className="mb-1.5 font-heading text-[23px] font-bold">Convert an assessment PDF</h2>
        <p className="mb-6 max-w-[60ch] text-[14.5px] leading-relaxed text-text-secondary">
          Upload the printed competency tool. It is read for its parts, its theory questions and
          every field somebody fills in — then you answer a short set of questions that shape the
          assessment it becomes.
        </p>

        {draft.error && (
          <div
            role="alert"
            className="mb-3.5 flex items-start gap-2 rounded-lg border border-danger bg-danger-soft p-[10px_14px] text-[12.5px] text-danger-text"
          >
            <Icon name="alert-triangle" size={14} className="mt-0.5 flex-none" />
            {draft.error}
          </div>
        )}

        <FileDropzone
          accept="application/pdf"
          hint="PDF up to 25 MB · multi-page supported · any assessment tool"
          onFiles={(files) => {
            const file = files[0];
            if (!file) return;
            const problem = validateUploadFile(file);
            if (problem) return;
            void draft.ingest(file);
          }}
        />
      </div>
    );
  }

  if (phase !== 'ready') {
    const activeIndex = BUILDER_PHASES.findIndex((p) => p.key === phase);
    return (
      <div className="mx-auto max-w-[780px]">
        <div className="mb-3.5 flex items-center gap-3 rounded-lg border border-border-accent bg-surface-card p-[12px_14px]">
          <span className="grid h-11 w-[38px] flex-none place-items-center rounded-[5px] bg-danger-soft">
            <Icon name="file-text" size={20} className="text-danger" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-semibold">{draft.fileName}</div>
            <div className="text-[12px] text-text-tertiary">
              A long assessment takes a few minutes to read.
            </div>
          </div>
          <Icon name="loader-circle" size={18} className="animate-spin text-accent" />
        </div>

        <div className="rounded-[14px] border border-border bg-surface-card p-[20px_22px]">
          <div className="mb-3.5 flex items-center gap-2.5">
            <span className="grid h-[30px] w-[30px] place-items-center rounded-lg bg-surface-accent-soft">
              <Icon name="sparkles" size={16} className="text-accent" />
            </span>
            <span className="text-[14.5px] font-semibold">Reading the document</span>
          </div>
          <div className="flex flex-col gap-2.5">
            {BUILDER_PHASES.map((row, i) => {
              const done = i < activeIndex;
              const active = i === activeIndex;
              return (
                <div
                  key={row.key}
                  className={`flex items-center gap-2.5 text-[13px] ${
                    done
                      ? 'text-text-secondary'
                      : active
                        ? 'text-text-primary'
                        : 'text-text-tertiary'
                  }`}
                >
                  {done ? (
                    <Icon name="check-circle-2" size={15} className="text-accent" />
                  ) : active ? (
                    <Icon name="loader-circle" size={15} className="animate-spin text-accent" />
                  ) : (
                    <Icon name="circle" size={15} className="text-border" />
                  )}
                  {row.label}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[780px]">
      <div className="mb-4 flex items-center gap-3 rounded-lg border border-border bg-surface-card p-[10px_14px]">
        <span className="grid h-[38px] w-8 flex-none place-items-center rounded-[5px] bg-danger-soft">
          <Icon name="file-text" size={17} className="text-danger" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">{draft.fileName}</div>
          <div className="text-[11.5px] text-text-tertiary">
            {stats?.pages} pages · read by {extraction?.path === 'acroform' ? 'the form reader' : 'AI extraction'}
          </div>
        </div>
        <Icon name="check-circle-2" size={17} className="flex-none text-accent" />
        <Button size="sm" variant="ghost" onClick={draft.reset}>
          Re-upload
        </Button>
      </div>

      <div className="mb-4 grid grid-cols-4 gap-2.5">
        <Stat value={stats?.pages ?? 0} label="Pages" />
        <Stat value={stats?.parts ?? 0} label="Parts detected" />
        <Stat value={stats?.fields ?? 0} label="Fields" />
        <Stat value={stats?.questions ?? 0} label="Theory questions" />
      </div>

      {/*
        The two things this document class gets wrong are worth saying out loud
        rather than leaving to be discovered at step 5: a matching question read
        one-sided cannot be keyed until somebody types the other side, and a
        prerequisite row that was not found is a gating fact the tool will not
        carry.
      */}
      {(stats?.matchesIncomplete ?? 0) > 0 && (
        <div className="mb-3 flex items-start gap-2.5 rounded-lg border border-warning bg-warning-soft p-[10px_14px] text-[12.5px] leading-relaxed text-warning-text">
          <Icon name="git-compare-arrows" size={15} className="mt-0.5 flex-none" />
          <span>
            {stats?.matchesIncomplete} matching question
            {stats?.matchesIncomplete === 1 ? '' : 's'} came back with only one side. You will type
            the other side in the answer-key step before {stats?.matchesIncomplete === 1 ? 'it' : 'they'} can be
            keyed.
          </span>
        </div>
      )}
      {stats?.prerequisites === 0 && (
        <div className="mb-3 flex items-start gap-2.5 rounded-lg border border-warning bg-warning-soft p-[10px_14px] text-[12.5px] leading-relaxed text-warning-text">
          <Icon name="alert-triangle" size={15} className="mt-0.5 flex-none" />
          <span>
            No prerequisite rows were found on the cover page. If this assessment requires a licence,
            permit or ticket, add it in the units step — nothing downstream can infer one.
          </span>
        </div>
      )}

      <div className="mb-4 rounded-[14px] border border-border bg-surface-card p-[20px_22px]">
        <div className="mb-1 flex items-center gap-2.5">
          <span className="grid h-[30px] w-[30px] place-items-center rounded-lg bg-surface-accent-soft">
            <Icon name="sparkles" size={16} className="text-accent" />
          </span>
          <span className="text-[15px] font-semibold">Setup questions</span>
        </div>
        <p className="mb-4 text-[12.5px] text-text-tertiary">
          Drafted from what the document says — your answers shape the parts, the marking and the
          fill surface.
        </p>

        <div className="flex flex-col gap-4">
          <div>
            <div className="text-[13.5px] font-semibold">Which pathways should this tool offer?</div>
            <div className="mb-2 mt-0.5 text-[11.5px] text-text-tertiary">
              A pathway decides which parts a candidate’s case requires.
            </div>
            <div className="flex flex-wrap gap-2">
              {ASSESSMENT_PATHWAYS.map((p) => (
                <Chip
                  key={p}
                  on={setup.pathways.includes(p)}
                  onClick={() =>
                    draft.setSetup({
                      pathways: setup.pathways.includes(p)
                        ? setup.pathways.filter((x) => x !== p)
                        : [...setup.pathways, p],
                    })
                  }
                >
                  <span title={PATHWAY_HINTS[p]}>{PATHWAY_LABELS[p]}</span>
                </Chip>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[13.5px] font-semibold">What makes the theory satisfactory?</div>
            <div className="mb-2 mt-0.5 text-[11.5px] text-text-tertiary">
              Marking is exact-set match either way — this decides what gates the part’s outcome.
            </div>
            <div className="flex flex-wrap gap-2">
              <Chip
                on={setup.passRule === 'mandatory_all_correct'}
                onClick={() => draft.setSetup({ passRule: 'mandatory_all_correct' })}
                recommended
              >
                Every question in the must-pass set
              </Chip>
              <Chip
                on={setup.passRule === 'overall_percentage'}
                onClick={() => draft.setSetup({ passRule: 'overall_percentage' })}
              >
                An overall percentage
              </Chip>
            </div>
            {setup.passRule === 'overall_percentage' && (
              <p className="mt-2 text-[11.5px] text-warning-text">
                Recorded, but not yet applied: marking gates on the must-pass set today. The tool
                will behave as if the first option were chosen until that lands.
              </p>
            )}
          </div>

          <div>
            <div className="text-[13.5px] font-semibold">How should theory be presented?</div>
            <div className="mb-2 mt-0.5 text-[11.5px] text-text-tertiary">
              Matching questions become interactives either way.
            </div>
            <div className="flex flex-wrap gap-2">
              <Chip
                on={setup.theoryRendering === 'one_per_screen'}
                onClick={() => draft.setSetup({ theoryRendering: 'one_per_screen' })}
                recommended
              >
                One question per screen
              </Chip>
              <Chip
                on={setup.theoryRendering === 'stacked'}
                onClick={() => draft.setSetup({ theoryRendering: 'stacked' })}
              >
                A single stacked form
              </Chip>
            </div>
          </div>

          <div>
            <div className="text-[13.5px] font-semibold">
              What happens when a logbook reaches its minimum hours?
            </div>
            <div className="mb-2 mt-0.5 text-[11.5px] text-text-tertiary">
              Applies to every logbook part this tool declares.
            </div>
            <div className="flex flex-wrap gap-2">
              <Chip
                on={setup.thresholdBehaviour === 'notify'}
                onClick={() => draft.setSetup({ thresholdBehaviour: 'notify' })}
                recommended
              >
                Notify the assessor — never block
              </Chip>
              <Chip
                on={setup.thresholdBehaviour === 'block'}
                onClick={() => draft.setSetup({ thresholdBehaviour: 'block' })}
              >
                Block the next part until reached
              </Chip>
            </div>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-[14px] border border-border bg-surface-card">
        <div className="p-[18px_22px_0]">
          <div className="mb-1 flex items-center gap-2.5">
            <span className="grid h-[30px] w-[30px] place-items-center rounded-lg bg-info-soft">
              <Icon name="list-checks" size={16} className="text-info" />
            </span>
            <span className="text-[15px] font-semibold">Extracted question bank</span>
          </div>
          <p className="mb-3 text-[12.5px] text-text-tertiary">
            {questions.length} theory question{questions.length === 1 ? '' : 's'} found. Untick any
            to leave it off the digital version — the printed PDF keeps it either way.
          </p>
        </div>
        <div className="max-h-[420px] overflow-auto p-[8px_10px_10px]">
          {questions.map((q, i) => {
            const type = questionType(q);
            const on = !draft.excluded.has(q.id);
            return (
              <div
                key={q.id}
                className="flex items-center gap-2.5 rounded-lg p-[9px_12px] hover:bg-surface-hover"
              >
                <button
                  type="button"
                  onClick={() => draft.toggleExcluded(q.id)}
                  aria-label={on ? `Exclude ${q.label}` : `Include ${q.label}`}
                  aria-pressed={on}
                  className={`grid h-[17px] w-[17px] flex-none place-items-center rounded ${
                    on
                      ? 'border border-accent bg-accent text-accent-contrast'
                      : 'border-[1.5px] border-border bg-surface-card text-transparent'
                  }`}
                >
                  <Icon name="check" size={12} />
                </button>
                <span className="w-[30px] flex-none font-mono text-[10.5px] text-text-tertiary">
                  {q.questionRef ?? `Q${i + 1}`}
                </span>
                <span
                  className={`min-w-0 flex-1 truncate text-[13px] ${
                    on ? 'text-text-primary' : 'text-text-tertiary'
                  }`}
                >
                  {q.label}
                </span>
                <span
                  className={`flex-none rounded-full px-2.5 py-[3px] text-[10.5px] font-semibold ${type.tone}`}
                >
                  {type.label}
                </span>
                <span className="w-[74px] flex-none text-right font-mono text-[10px] text-text-tertiary">
                  {hasAnyMatchSide(q)
                    ? `${q.matchLeft?.length ?? q.matchRight?.length ?? 0} pairs`
                    : `${q.options?.length ?? 0} options`}
                </span>
              </div>
            );
          })}
        </div>
        <div className="border-t border-border-subtle bg-surface-sunken p-[10px_22px] text-[12px] text-text-tertiary">
          {questions.length - draft.excluded.size} of {questions.length} included · a question’s type
          can be corrected in the answer-key step
        </div>
      </div>
    </div>
  );
}
