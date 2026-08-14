import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, FileDropzone, Icon } from '@formai/ui';
import { apiClient } from '../../../../lib/data/api-client.js';
import { fileToBase64, IMPORT_REQUEST_TIMEOUT_MS } from '../../../../lib/data/import-session.js';
import {
  ASSESSMENT_PATHWAYS,
  BUILDER_STEP_LABELS,
  resolveBuilderStep,
  isChoiceField,
  hasAnyMatchSide,
  hasBothMatchSides,
  type AssessmentPathway,
  type ExtractedField,
} from '@formai/shared';
import { validateUploadFile } from '../../../import/upload-validation.js';
import { useBuilderDrafts, useDiscardBuilderDraft } from '../../../../lib/data/hooks.js';
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

  // A revision never re-extracts (KTD7) — its step 1 is the PDF decision, not
  // a dropzone into extraction.
  if (draft.revisionOfToolId) return <RevisionUploadStep draft={draft} />;

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

        <ResumeDrafts />

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
              <div className="mt-2 flex items-center gap-2">
                <label className="text-[11.5px] text-text-secondary">Pass threshold</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={setup.passPercentage ?? 100}
                  onChange={(e) =>
                    draft.setSetup({
                      passPercentage: Math.max(1, Math.min(100, Number(e.target.value) || 100)),
                    })
                  }
                  className="h-[28px] w-16 rounded-lg border border-border bg-surface-page px-2 text-center text-[12px]"
                />
                <span className="text-[11.5px] text-text-tertiary">%</span>
              </div>
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
            {setup.theoryRendering === 'one_per_screen' && (
              <label className="mt-2 inline-flex items-center gap-1.5 text-[11.5px] text-text-secondary">
                <input
                  type="checkbox"
                  checked={!!setup.theoryAllowRetry}
                  onChange={(e) => draft.setSetup({ theoryAllowRetry: e.target.checked })}
                />
                Allow candidates to retry incorrect questions before moving on
              </label>
            )}
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

/**
 * Step 1 of a REVISION — keep the current document, or replace it.
 *
 * Nothing here extracts. The fields, keys, gating and workflow were seeded
 * from the published version; this step only decides which paper document the
 * revision maps to. Replacing moves every confirmed box into the carried
 * stash for re-confirmation in the mapping step (a box confirmed against the
 * old layout was not confirmed against the new one), and a mis-upload reverts
 * without costing any of that confirmation.
 */
function RevisionUploadStep({ draft }: { draft: BuilderDraftState }) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const carriedCount = Object.keys(draft.carriedGeometry).length;

  const replace = async (file: File) => {
    setUploadError(null);
    setUploading(true);
    try {
      const base64 = await fileToBase64(file);
      const { assetId } = await apiClient.post<{ assetId: string }>(
        '/pdf/upload',
        { pdfBase64: base64 },
        { timeoutMs: IMPORT_REQUEST_TIMEOUT_MS },
      );
      draft.replacePdf(assetId, file.name);
    } catch {
      setUploadError('Uploading the replacement failed — nothing changed. Try again.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="mx-auto max-w-[780px]">
      <h2 className="mb-1.5 font-heading text-[23px] font-bold">The paper document</h2>
      <p className="mb-6 max-w-[62ch] text-[14.5px] leading-relaxed text-text-secondary">
        This revision was seeded from the published tool — every field, answer key, unit and
        workflow carried over. Keep the current document if only the digital side changes, or
        upload the reviewed revision of the paper.
      </p>

      <div className="mb-4 flex items-center gap-3 rounded-lg border border-border bg-surface-card p-[12px_14px]">
        <span className="grid h-[38px] w-8 flex-none place-items-center rounded-[5px] bg-danger-soft">
          <Icon name="file-text" size={17} className="text-danger" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">{draft.fileName}</div>
          <div className="text-[11.5px] text-text-tertiary">
            {draft.pdfReplaced
              ? 'Replacement uploaded — mapped boxes carried over, awaiting re-confirmation'
              : 'Current document kept — mapping stays confirmed exactly as published'}
          </div>
        </div>
        {draft.pdfReplaced ? (
          <Button size="sm" variant="ghost" leadingIcon="undo-2" onClick={draft.revertPdf}>
            Revert to original
          </Button>
        ) : (
          <Icon name="check-circle-2" size={17} className="flex-none text-accent" />
        )}
      </div>

      {draft.pdfReplaced && carriedCount > 0 && (
        <div className="mb-3 flex items-start gap-2.5 rounded-lg border border-warning bg-warning-soft p-[10px_14px] text-[12.5px] leading-relaxed text-warning-text">
          <Icon name="map-pin" size={15} className="mt-0.5 flex-none" />
          <span>
            {carriedCount} mapped field{carriedCount === 1 ? '' : 's'} carried over as proposals.
            They are pre-placed at their old positions but count as unconfirmed until you review
            them in the PDF mapping step — a box confirmed against the old layout was not confirmed
            against this one.
          </span>
        </div>
      )}

      {uploadError && (
        <div
          role="alert"
          className="mb-3 flex items-start gap-2 rounded-lg border border-danger bg-danger-soft p-[10px_14px] text-[12.5px] text-danger-text"
        >
          <Icon name="alert-triangle" size={14} className="mt-0.5 flex-none" />
          {uploadError}
        </div>
      )}

      {uploading ? (
        <div className="flex items-center gap-2.5 rounded-lg border border-border-accent bg-surface-card p-[12px_14px] text-[13px]">
          <Icon name="loader-circle" size={16} className="animate-spin text-accent" />
          Uploading the replacement…
        </div>
      ) : (
        <FileDropzone
          accept="application/pdf"
          hint={
            draft.pdfReplaced
              ? 'Upload a different replacement · the carried boxes stay stashed'
              : 'Upload the reviewed PDF · the webform, keys and workflow are untouched'
          }
          onFiles={(files) => {
            const file = files[0];
            if (!file) return;
            const problem = validateUploadFile(file);
            if (problem) return;
            void replace(file);
          }}
        />
      )}
    </div>
  );
}

/**
 * Saved drafts, and the way back into one.
 *
 * WHAT THIS UNBLOCKS. `/app/assessments/builder/:draftId` resumes a draft, and
 * the list, load and discard routes have all existed since the draft table did.
 * What never existed was anything that LINKED to them — so an author who left
 * the builder half-way had no route back in, and had to start from the PDF
 * again. Every abandoned run also leaves a draft FORM behind (the placement
 * step creates its version up front, because geometry lives on a version's
 * fields), which is why the form library fills with them.
 *
 * Shown only before an upload, and only when there is something to resume: on
 * the first run of a fresh workspace this renders nothing at all, and it must
 * never sit between an author and the dropzone they came here for.
 *
 * DISCARDING A DRAFT IS NOT DELETING ITS FORM. The two are separate records and
 * the form library owns the second — saying so here stops "discard" reading as
 * a cleanup it is not.
 */
function ResumeDrafts() {
  const navigate = useNavigate();
  const drafts = useBuilderDrafts();
  const discard = useDiscardBuilderDraft();

  const rows = drafts.data ?? [];
  if (rows.length === 0) return null;

  return (
    <div className="mb-5 rounded-[14px] border border-border bg-surface-card p-4">
      <div className="mb-2.5">
        <span className="block text-[14px] font-semibold">Pick up where you left off</span>
        <span className="mt-0.5 block text-[11.5px] text-text-tertiary">
          {rows.length} saved draft{rows.length === 1 ? '' : 's'} · discarding one leaves any form
          it already created in the form library, where it can be deleted
        </span>
      </div>

      <ul className="flex flex-col gap-1.5">
        {rows.map((d) => (
          <li
            key={d.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-border-subtle p-[8px_10px]"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-semibold">
                {d.name || 'Untitled assessment'}
              </span>
              <span className="mt-0.5 block text-[11px] text-text-tertiary">
                {/*
                  The step is resolved, not printed raw: a draft parked on a
                  RETIRED step would otherwise show a name no screen answers to.
                */}
                Stopped at {BUILDER_STEP_LABELS[resolveBuilderStep(d.step)]} ·{' '}
                {d.updatedAt.slice(0, 10)}
              </span>
            </span>
            <Button
              size="sm"
              variant="outline"
              leadingIcon="play"
              onClick={() => navigate(`/app/assessments/builder/${d.id}`)}
            >
              Resume
            </Button>
            <Button
              size="sm"
              variant="ghost"
              leadingIcon="trash-2"
              disabled={discard.isPending}
              onClick={() => discard.mutate(d.id)}
            >
              Discard
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
