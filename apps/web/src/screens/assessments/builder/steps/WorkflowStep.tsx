import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@formai/ui';
import { ApiError } from '../../../../lib/data/api-client.js';
import {
  useCreateAssessmentTool,
  useCreateDraftForm,
  usePublishFormVersion,
  useSaveVersionFields,
} from '../../../../lib/data/hooks.js';
import { store } from '../../../../lib/data/store.js';
import { checkPublish, publishSummary } from '../builder-publish.js';
import { workflowFromStructure } from '../builder-workflow.js';
import type { BuilderDraftState } from '../use-builder-draft.js';

/**
 * Step 7 — publish.
 *
 * WHAT THIS RETIRES. `packages/db/scripts/author-track-dozer-tool.mjs` does this
 * job today: it reads an answer key off disk, re-pairs every question with the
 * next `check_cross` in document order, derives outcome targets from that guess,
 * and upserts the tool row against a `DATABASE_URL`. It refuses to write unless
 * it finds exactly 31 question/outcome pairs and 6 part anchors, because its
 * alignment is positional and one missing pair shifts every later entry. None of
 * that is needed once keys are attached to field IDS and links come from the
 * printed references the model read off the page.
 *
 * VALIDATE FIRST, WRITE SECOND, and that order is not negotiable. The server
 * validates the manifest against the template's CURRENT version, which is only
 * set when a version publishes — so a tool that fails validation after its
 * version published leaves a live form with no tool attached, which is a worse
 * state than either end of the operation. `checkPublish` runs the same two
 * shared validators the API runs, before anything is written.
 *
 * The workflow editor itself (U18) is not here; a tool with no workflow behaves
 * exactly as every tool did before workflows existed — `workflowOf` synthesises
 * a section per part in document order — so publishing without one is a
 * complete tool, not a broken one.
 */
export interface WorkflowStepProps {
  draft: BuilderDraftState;
}

export function WorkflowStep({ draft }: WorkflowStepProps) {
  const { fields, keys, manifest, structure, parts, formId, versionId, title } = draft;
  const [done, setDone] = useState<{ toolId: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const saveFields = useSaveVersionFields(formId ?? '', versionId ?? '');
  const publishVersion = usePublishFormVersion();
  const createTool = useCreateAssessmentTool();
  const createDraft = useCreateDraftForm();

  // The STRUCTURE carries the order. Without it publish writes extraction
  // order and the whole of step 2 is cosmetic.
  const check = useMemo(
    () => checkPublish(fields, keys, manifest, structure),
    [fields, keys, manifest, structure],
  );
  const summary = useMemo(() => publishSummary(fields, keys, manifest), [fields, keys, manifest]);

  const busy =
    saveFields.isPending ||
    publishVersion.isPending ||
    createTool.isPending ||
    createDraft.isPending;
  const ready = !!formId && !!versionId && check.problems.length === 0;

  const publish = async () => {
    if (!formId || !versionId || !manifest) return;
    setFailure(null);
    try {
      let activeFormId = formId;
      let activeVersionId = versionId;

      try {
        await saveFields.mutateAsync(check.fields);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) throw err;
        /*
          The form or version the snapshot remembered no longer exists — the
          author deleted it from Assessments and came back to the builder.
          Re-create the draft so the work is not lost.
        */
        const fresh = await createDraft.mutateAsync({
          name: title || 'Assessment',
          fields: check.fields,
          sourcePdfAssetId: draft.assetId,
        });
        activeFormId = fresh.formId;
        activeVersionId = fresh.versionId;
        draft.setVersionIds(activeFormId, activeVersionId);
      }

      await (activeFormId === formId
        ? publishVersion.mutateAsync({ formId: activeFormId, versionId: activeVersionId })
        : store.publishFormVersion({ formId: activeFormId, versionId: activeVersionId }));

      const tool = await createTool.mutateAsync({
        templateId: activeFormId,
        name: title || 'Assessment',
        manifest: {
          ...manifest,
          workflow: workflowFromStructure(structure, parts, manifest, check.fields),
        },
      });
      setDone({ toolId: tool.id });
    } catch (err) {
      setFailure(
        err instanceof Error
          ? `Publishing stopped: ${err.message}. The form version may already have published; check Assessments before retrying.`
          : 'Publishing stopped before it finished. Check Assessments before retrying.',
      );
    }
  };

  if (done) {
    return (
      <div className="rounded-[14px] border border-success bg-success-soft p-4">
        <span className="block text-[14.5px] font-semibold text-success-text">Published</span>
        <p className="mt-1 text-[12.5px] text-success-text">
          {summary.parts} part{summary.parts === 1 ? '' : 's'} · {summary.questionsKeyed} question
          {summary.questionsKeyed === 1 ? '' : 's'} keyed ({summary.questionsVerified} verified) ·{' '}
          {summary.boxesPlaced} box{summary.boxesPlaced === 1 ? '' : 'es'} placed. The tool is
          enrollable from Assessments.
        </p>
        {/*
          WHO FILLS WHAT IS CONFIGURED ON THE PUBLISHED TOOL, not before it.

          The workflow editor edits a tool that exists — it reads the server's
          own `problems`, `warnings` and `workflowIsDefault`, none of which can
          be computed for a tool that has not been created yet. A tool with no
          workflow is not broken: `workflowOf` synthesises one section per
          printed part and every role able to fill everything, which is exactly
          what every tool did before workflows existed. So this is a next step,
          offered, rather than a gate that was skipped.
        */}
        <p className="mt-2 text-[12.5px] text-success-text">
          Nobody has set up <strong>who fills what</strong> yet — until you do, every role can fill
          every part, which is the default this product has always used.
        </p>
        <Link
          to={`/app/assessments/tools/${done.toolId}/workflow`}
          className="mt-2 inline-flex h-[30px] items-center gap-1.5 rounded-lg border border-success px-3 text-[11.5px] font-semibold text-success-text"
        >
          <Icon name="workflow" size={13} />
          Configure the workflow
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-[14px] border border-border bg-surface-card p-4">
        <span className="block text-[14.5px] font-semibold">Publish</span>
        <p className="mt-0.5 text-[11.5px] text-text-tertiary">
          {summary.parts} part{summary.parts === 1 ? '' : 's'} · {summary.questionsKeyed} keyed ·{' '}
          {summary.questionsVerified} verified · {summary.boxesPlaced} placed
        </p>
        {summary.questionsKeyed > summary.questionsVerified && (
          <p className="mt-2 text-[11.5px] text-text-secondary">
            {summary.questionsKeyed - summary.questionsVerified} answer
            {summary.questionsKeyed - summary.questionsVerified === 1 ? '' : 's'} have not been
            verified by the training authority. They will still mark — verification is recorded, not
            required.
          </p>
        )}
      </div>

      {!formId && (
        <p className="rounded-[10px] border border-warning bg-warning-soft p-[8px_10px] text-[11.5px] text-warning-text">
          Open <strong>PDF mapping</strong> first — that is where the draft version this publishes
          gets created.
        </p>
      )}

      {check.problems.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-[14px] border border-warning bg-warning-soft p-3">
          <span className="text-[11.5px] font-semibold text-warning-text">
            {check.problems.length} problem{check.problems.length === 1 ? '' : 's'} to fix before
            publishing
          </span>
          {/*
            Every problem at once, in the validators' own words. An author who
            fixes one and is handed the next has to re-run the gate once per
            mistake — which is what the authoring script's all-or-nothing
            refusal feels like from the outside.
          */}
          {check.problems.map((problem, i) => (
            <p key={i} className="text-[11.5px] text-warning-text">
              {problem}
            </p>
          ))}
        </div>
      )}

      {/*
        INFERRED LINKS ARE NOT A PROBLEM, AND NOT SILENT EITHER.

        Where a question named no outcome box, the one printed immediately after
        it is used. That is right on every paper of this shape — and it is a
        guess: one question whose box the extraction missed re-pairs every
        question after it, and the result still looks like a complete mapping.
        Saying how many were inferred is what gives an author something to
        spot-check before a mark lands on the wrong certificate.
      */}
      {check.inferred.length > 0 && (
        <div className="rounded-[14px] border border-border bg-surface-sunken p-3">
          <span className="text-[11.5px] font-semibold">
            {check.inferred.length} mark{check.inferred.length === 1 ? '' : 's'} will land in the
            ✓/✗ box printed straight after the question
          </span>
          <p className="mt-1 text-[11.5px] leading-snug text-text-secondary">
            Read from document order, because those questions name no box themselves. Correct on a
            paper that prints each question above its own cell — spot-check two or three against
            the document, and set any exception from the dropdown on the answer-key step.
          </p>
        </div>
      )}

      {failure && (
        <p role="alert" className="rounded-[10px] border border-danger bg-danger-soft p-[8px_10px] text-[11.5px] text-danger-text">
          {failure}
        </p>
      )}

      <button
        type="button"
        disabled={!ready || busy}
        onClick={() => void publish()}
        className="inline-flex h-[34px] items-center justify-center gap-1.5 self-start rounded-lg bg-accent px-4 text-[12.5px] font-semibold text-accent-contrast disabled:opacity-50"
      >
        <Icon name="rocket" size={14} />
        {busy ? 'Publishing…' : 'Publish assessment tool'}
      </button>
    </div>
  );
}
