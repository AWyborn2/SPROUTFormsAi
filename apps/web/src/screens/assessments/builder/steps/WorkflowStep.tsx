import { useMemo, useState } from 'react';
import { Icon } from '@formai/ui';
import {
  useCreateAssessmentTool,
  usePublishFormVersion,
  useSaveVersionFields,
} from '../../../../lib/data/hooks.js';
import { checkPublish, publishSummary } from '../builder-publish.js';
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
  const { fields, keys, manifest, formId, versionId, title } = draft;
  const [done, setDone] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const saveFields = useSaveVersionFields(formId ?? '', versionId ?? '');
  const publishVersion = usePublishFormVersion();
  const createTool = useCreateAssessmentTool();

  const check = useMemo(() => checkPublish(fields, keys, manifest), [fields, keys, manifest]);
  const summary = useMemo(() => publishSummary(fields, keys, manifest), [fields, keys, manifest]);

  const busy = saveFields.isPending || publishVersion.isPending || createTool.isPending;
  const ready = !!formId && !!versionId && check.problems.length === 0;

  const publish = async () => {
    if (!formId || !versionId || !manifest) return;
    setFailure(null);
    try {
      /*
        THE RESOLVED FIELDS ARE WHAT IS SAVED — the same list `checkPublish`
        validated. Validating one field list and writing another is how a gate
        passes and the stored record still fails.
      */
      await saveFields.mutateAsync(check.fields);
      await publishVersion.mutateAsync({ formId, versionId });
      await createTool.mutateAsync({
        templateId: formId,
        name: title || 'Assessment',
        manifest,
      });
      setDone(formId);
    } catch (err) {
      /*
        Named plainly, and the step stays where it is. Some of the sequence may
        have landed — the version can be published with no tool attached — and
        saying "something went wrong" would leave an author guessing which half
        to undo.
      */
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
