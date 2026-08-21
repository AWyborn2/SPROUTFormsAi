import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Icon, Select } from '@formai/ui';
import { ApiError } from '../../../../lib/data/api-client.js';
import { assessmentsApi } from '../../../../lib/data/assessments.js';
import {
  useCompetencies,
  useCreateAssessmentTool,
  useCreateDraftForm,
  usePublishFormVersion,
  useSaveVersionFields,
} from '../../../../lib/data/hooks.js';
import { useInlineCompetencyCreate } from '../../../../lib/data/use-inline-competency-create.js';
import { store } from '../../../../lib/data/store.js';
import {
  checkPublish,
  composeRevisionManifest,
  extractionQuestionRefs,
  publishSummary,
} from '../builder-publish.js';
import { workflowFromStructure } from '../builder-workflow.js';
import { useStartRevision } from '../use-start-revision.js';
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

/**
 * The refusal, in the SERVER'S OWN WORDS. A 400 from publish or republish
 * carries exactly why — `invalid_manifest` lists validator problems,
 * `invalid_request` names the fields the schema refused — and showing only
 * "API request failed (400)" left an author staring at a green summary and a
 * red box that disagreed with it, with nothing to fix.
 */
function publishFailureText(err: unknown, fallbackSuffix: string): string {
  if (err instanceof ApiError && err.body && typeof err.body === 'object') {
    const body = err.body as {
      error?: string;
      problems?: string[];
      detail?: { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
    };
    if (Array.isArray(body.problems) && body.problems.length > 0) {
      return `Publishing refused: ${body.problems.join(' · ')}`;
    }
    if (body.error === 'invalid_request' && body.detail) {
      const fieldMessages = Object.entries(body.detail.fieldErrors ?? {}).map(
        ([key, messages]) => `${key}: ${messages.join(', ')}`,
      );
      const all = [...(body.detail.formErrors ?? []), ...fieldMessages];
      if (all.length > 0) return `Publishing refused — the request did not match: ${all.join(' · ')}`;
    }
  }
  return err instanceof Error
    ? `Publishing stopped: ${err.message}. ${fallbackSuffix}`
    : `Publishing stopped before it finished. ${fallbackSuffix}`;
}

/**
 * What passing this assessment AWARDS (U5, R1, R2 — AE2).
 *
 * Scoped by ACTION, not by the revision flag: this control is mounted on every
 * path that CREATES a tool — the fresh publish and the deleted-form recovery —
 * and on neither of the paths that update one. Creating requires exactly one
 * awarded competency (U2 400s `invalid_award` without it), while a republish
 * edits a tool whose award already stands; changing THAT is the API's own
 * guarded re-link operation (KTD10), deliberately not a builder afterthought.
 *
 * Mounting this component is also the decision to fetch the register — the
 * republish path never mounts it, so a revision author costs no request.
 */
function AwardControl({
  title,
  value,
  onChange,
}: {
  /** The assessment's name — the inline create's one-step default (AE2). */
  title: string;
  value: string;
  onChange: (competencyId: string) => void;
}) {
  const { data: competencies = [] } = useCompetencies();
  /**
   * Inline create with the created competency kept locally pickable
   * IMMEDIATELY (the shared hook): the register cache refetches in the
   * background, and a picker that cannot see the competency it just created
   * would strand the author at the last step of the flow.
   */
  const inlineCreate = useInlineCompetencyCreate(competencies);
  const [createFailed, setCreateFailed] = useState(false);

  const options = inlineCreate.options;

  /*
    The one-step default (AE2): building "ATO - Grader" with no matching
    competency offers creating it under exactly that name. Offered only while
    NO exact case-insensitive match exists — creating a second "ATO - Grader"
    beside an existing one would seed the duplicate mess the register's own
    create form guards against, and the backfill's suggestion logic matches on.
  */
  const wanted = title.trim().toLowerCase();
  const hasMatch = wanted !== '' && options.some((c) => c.name.trim().toLowerCase() === wanted);

  function onCreateInline() {
    setCreateFailed(false);
    // Perpetual by default (the shared hook creates without validity):
    // validity is the register's decision, made on the Competencies screen
    // where its retroactive reach is explained. This flow's job is the LINK,
    // not the whole record.
    inlineCreate.create(
      title.trim(),
      null,
      (added) => {
        // Creating IS choosing — one step links the competency and the
        // assessment (AE2), rather than create-then-find-it-in-the-picker.
        onChange(added.id);
      },
      () => setCreateFailed(true),
    );
  }

  return (
    <div className="rounded-[14px] border border-border bg-surface-card p-4">
      <span className="block text-[13.5px] font-semibold">What passing this awards</span>
      <p className="mb-2.5 mt-0.5 text-[11.5px] text-text-tertiary">
        Exactly one competency, granted on sign-off with the case as evidence. Role requirements
        and auto-assignment run on this link — an assessment awarding nothing would assess nobody.
      </p>
      <div className="flex flex-wrap items-end gap-2.5">
        <div className="w-[260px]">
          <Select
            label="This assessment awards"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            options={[
              { value: '', label: '— pick a competency —' },
              ...options.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
        </div>
        {!hasMatch && wanted !== '' && (
          <Button
            size="sm"
            variant="outline"
            leadingIcon="plus"
            disabled={inlineCreate.isPending}
            onClick={onCreateInline}
          >
            {`Create competency: ${title}`}
          </Button>
        )}
      </div>
      {createFailed && (
        <p className="mt-2 text-[11.5px] text-warning-text">
          Could not create the competency — pick one from the register instead, or add it on the
          Competencies screen.
        </p>
      )}
    </div>
  );
}

export function WorkflowStep({ draft }: WorkflowStepProps) {
  const { fields, keys, manifest, structure, parts, formId, versionId, title } = draft;
  const isRevision = Boolean(draft.revisionOfToolId);
  const [done, setDone] = useState<{ toolId: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [stale, setStale] = useState<{
    currentVersionLabel: string | null;
    publishedAt: string | null;
    publishedByName: string | null;
  } | null>(null);
  const [openCases, setOpenCases] = useState<Array<{ id: string }> | null>(null);
  const [formGone, setFormGone] = useState(false);
  /**
   * The one competency this assessment awards (U5, R1). Required on every
   * path that CREATES a tool — the API 400s `invalid_award` without exactly
   * one — so both create arms (fresh publish, formGone recovery) gate on it.
   * Lives here rather than in AwardControl because the publish functions
   * send it; the control is mounted in two mutually exclusive places and
   * must not lose the pick if the author moves between them.
   */
  const [awardCompetencyId, setAwardCompetencyId] = useState('');
  /** The structured republish refusal — rendered as a fix, not a dead end. */
  const [refusal, setRefusal] = useState<{
    danglingRules: Array<{ locationName: string; partLabel: string }>;
    attemptedParts: Array<{ key: string; label: string }>;
  } | null>(null);
  const restart = useStartRevision();

  const saveFields = useSaveVersionFields(formId ?? '', versionId ?? '');
  const publishVersion = usePublishFormVersion();
  const createTool = useCreateAssessmentTool();
  const createDraft = useCreateDraftForm();

  // The STRUCTURE carries the order. Without it publish writes extraction
  // order and the whole of step 2 is cosmetic. The REFS carry the printed
  // question references — without them the link tier resolves nothing and
  // every outcome box is an adjacency guess.
  const questionRefs = useMemo(() => extractionQuestionRefs(draft.extraction), [draft.extraction]);
  const check = useMemo(
    () => checkPublish(fields, keys, manifest, structure, draft.carriedGeometry, questionRefs),
    [fields, keys, manifest, structure, draft.carriedGeometry, questionRefs],
  );
  const summary = useMemo(() => publishSummary(fields, keys, manifest), [fields, keys, manifest]);

  const busy =
    saveFields.isPending ||
    publishVersion.isPending ||
    createTool.isPending ||
    createDraft.isPending;
  const ready = !!formId && !!versionId && check.problems.length === 0;

  /*
    A REVISION REPUBLISHES — one server transaction that freezes the revised
    version and updates the EXISTING tool together. The fresh-build sequence
    below cannot run here: its `createTool` would trip the one-tool-per-template
    unique index after the version already published, which is exactly the
    live-form-with-a-stale-tool state the header warns about.
  */
  const republish = async (opts?: { dropDanglingLocationRules?: boolean }) => {
    if (!formId || !versionId || !manifest || !draft.revisionOfToolId || !draft.seededFromVersionId)
      return;
    setFailure(null);
    setStale(null);
    setOpenCases(null);
    setFormGone(false);
    setRefusal(null);
    try {
      try {
        await saveFields.mutateAsync(check.fields);
      } catch (err) {
        /*
          The form is gone. NEVER the silent re-create the fresh build uses —
          that would convert "revise tool X" into "create unrelated tool Y"
          while the real tool lives on. The author gets an explicit choice.
        */
        if (err instanceof ApiError && err.status === 404) {
          setFormGone(true);
          return;
        }
        throw err;
      }

      const result = await assessmentsApi.republishTool({
        toolId: draft.revisionOfToolId,
        versionId,
        seededFromVersionId: draft.seededFromVersionId,
        fields: check.fields,
        ...(opts?.dropDanglingLocationRules ? { dropDanglingLocationRules: true } : {}),
        // The seeded manifest carries the workflow-editor extras the builder
        // does not model; the builder's derivation overlays it — except the
        // summary wiring, where a seeded entry that still resolves against
        // the revision's fields beats the fresh label-guess.
        manifest: composeRevisionManifest(
          draft.revisionToolManifest ?? manifest,
          {
            ...manifest,
            workflow: workflowFromStructure(structure, parts, manifest, check.fields),
          },
          check.fields,
        ),
        ...(draft.revisionIdentity ? { revisionIdentity: draft.revisionIdentity } : {}),
      });
      setDone({ toolId: result.id });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as {
          error?: string;
          currentVersionLabel?: string | null;
          publishedAt?: string | null;
          publishedByName?: string | null;
          cases?: Array<{ id: string }>;
        };
        if (body?.error === 'stale_revision') {
          setStale({
            currentVersionLabel: body.currentVersionLabel ?? null,
            publishedAt: body.publishedAt ?? null,
            publishedByName: body.publishedByName ?? null,
          });
          return;
        }
        if (body?.error === 'open_cases_incompatible') {
          setOpenCases(body.cases ?? []);
          return;
        }
      }
      /*
        A STRUCTURED refusal becomes an OFFER. Dangling Location rules are
        one click to resolve — the author unticks them with the publish —
        while a part with recorded evidence has no click: it must stay, and
        the panel says so instead of narrating a dead end.
      */
      if (err instanceof ApiError && err.status === 400) {
        const body = err.body as {
          error?: string;
          danglingRules?: Array<{ locationName: string; partLabel: string }>;
          attemptedParts?: Array<{ key: string; label: string }>;
        };
        if (
          body?.error === 'invalid_manifest' &&
          ((body.danglingRules?.length ?? 0) > 0 || (body.attemptedParts?.length ?? 0) > 0)
        ) {
          setRefusal({
            danglingRules: body.danglingRules ?? [],
            attemptedParts: body.attemptedParts ?? [],
          });
          return;
        }
      }
      setFailure(
        publishFailureText(err, 'Nothing was partially applied — the revision is intact; retry when ready.'),
      );
    }
  };

  /**
   * The EXPLICIT arm of the deleted-form recovery: mint a fresh form and a
   * fresh tool from this revision's content. Never run silently — the author
   * chose it from the formGone dialog, knowing it creates rather than revises.
   */
  const publishAsNewTool = async () => {
    // This arm CREATES a tool, whatever the revision flag says — so it needs
    // the award like any create (U5): without it the createTool below would
    // 400 `invalid_award` at the very end of an already-broken recovery.
    if (!manifest || !awardCompetencyId) return;
    setFailure(null);
    setFormGone(false);
    try {
      const fresh = await createDraft.mutateAsync({
        name: title || 'Assessment',
        fields: check.fields,
        ...(draft.assetId ? { sourcePdfAssetId: draft.assetId } : {}),
      });
      draft.setVersionIds(fresh.formId, fresh.versionId);
      await store.publishFormVersion({ formId: fresh.formId, versionId: fresh.versionId });
      const tool = await createTool.mutateAsync({
        templateId: fresh.formId,
        name: title || 'Assessment',
        manifest: {
          ...manifest,
          workflow: workflowFromStructure(structure, parts, manifest, check.fields),
        },
        awardedCompetencyIds: [awardCompetencyId],
      });
      setDone({ toolId: tool.id });
    } catch (err) {
      setFailure(publishFailureText(err, 'Publishing as a new tool did not finish.'));
    }
  };

  /** Stale recovery: discard this revision and re-seed from the new current version. */
  const discardAndRestart = async () => {
    const toolId = draft.revisionOfToolId;
    if (!toolId) return;
    const drafts = await store.listBuilderDrafts();
    const mine = drafts.find((d) => d.revisionOfToolId === toolId);
    if (mine) await store.discardBuilderDraft(mine.id);
    await restart.start(toolId);
  };

  const publish = async () => {
    if (isRevision) return republish();
    // The award gates a FRESH publish only (U5): the button below is already
    // disabled without one, and this guard keeps a programmatic call honest.
    if (!formId || !versionId || !manifest || !awardCompetencyId) return;
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
        // The one competency passing this awards (U5, R1) — required at
        // create, so the tool is competency machinery from its first second.
        awardedCompetencyIds: [awardCompetencyId],
      });
      setDone({ toolId: tool.id });
    } catch (err) {
      setFailure(
        publishFailureText(
          err,
          'The form version may already have published; check Assessments before retrying.',
        ),
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

      {/*
        THE AWARD, ON THE CREATE PATH ONLY (U5). A republish updates a tool
        whose award already stands — re-pointing that is the API's own guarded
        re-link (KTD10), never a builder side-effect — so `isRevision` hides
        the control here; the formGone recovery below re-mounts it because
        that arm creates.
      */}
      {!isRevision && (
        <AwardControl
          title={title ?? ''}
          value={awardCompetencyId}
          onChange={setAwardCompetencyId}
        />
      )}

      {!formId && (
        <p className="rounded-[10px] border border-warning bg-warning-soft p-[8px_10px] text-[11.5px] text-warning-text">
          Open <strong>PDF mapping</strong> first — that is where the draft version this publishes
          gets created.
        </p>
      )}

      {/*
        The paper document's own identity (R9). Optional on purpose — a
        webform-only tweak has no new paper to cite — but empty is warned
        below, because the change note is the severity signal assessors read.
      */}
      {isRevision && (
        <div className="rounded-[14px] border border-border bg-surface-card p-4">
          <span className="block text-[13.5px] font-semibold">Document revision identity</span>
          <p className="mb-2.5 mt-0.5 text-[11.5px] text-text-tertiary">
            As printed on the reviewed document — shown in version history and on every evidence
            export from this version.
          </p>
          <div className="flex flex-wrap gap-2.5">
            <label className="flex flex-col gap-1 text-[11px] font-semibold text-text-secondary">
              Revision code
              <input
                value={draft.revisionIdentity?.code ?? ''}
                maxLength={64}
                placeholder="Rev 3"
                onChange={(e) => draft.setRevisionIdentity({ code: e.target.value })}
                className="h-8 w-[120px] rounded-lg border border-border bg-surface-card px-2.5 text-[12.5px] font-normal"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-semibold text-text-secondary">
              Reviewed
              <input
                value={draft.revisionIdentity?.reviewedOn ?? ''}
                maxLength={32}
                placeholder="08/2026"
                onChange={(e) => draft.setRevisionIdentity({ reviewedOn: e.target.value })}
                className="h-8 w-[110px] rounded-lg border border-border bg-surface-card px-2.5 text-[12.5px] font-normal"
              />
            </label>
            <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-[11px] font-semibold text-text-secondary">
              What changed
              <input
                value={draft.revisionIdentity?.note ?? ''}
                maxLength={2000}
                placeholder="Annual review — no content change"
                onChange={(e) => draft.setRevisionIdentity({ note: e.target.value })}
                className="h-8 rounded-lg border border-border bg-surface-card px-2.5 text-[12.5px] font-normal"
              />
            </label>
          </div>
          {!draft.revisionIdentity?.code && !draft.revisionIdentity?.note && (
            <p className="mt-2 text-[11.5px] text-warning-text">
              No identity recorded — the new version will publish without one, and auditors will
              only see the internal version label.
            </p>
          )}
        </div>
      )}

      {/*
        CARRIED BOXES NOBODY RE-CONFIRMED (R8/AE2). A warning, never a gate —
        the field prints nowhere until placed, which is the safe failure, and
        this is where that silence gets said out loud, field by field.
      */}
      {isRevision && check.carried.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-[14px] border border-warning bg-warning-soft p-3">
          <span className="text-[11.5px] font-semibold text-warning-text">
            {check.carried.length} carried box{check.carried.length === 1 ? '' : 'es'} never
            re-confirmed against the new document
          </span>
          {check.carried.map((label) => (
            <p key={label} className="text-[11.5px] text-warning-text">
              “{label}” — pre-placed from the old layout, unconfirmed. It prints nowhere until
              confirmed or re-placed in PDF mapping.
            </p>
          ))}
        </div>
      )}

      {stale && (
        <div className="flex flex-col gap-2 rounded-[14px] border border-danger bg-danger-soft p-3">
          <span className="text-[12.5px] font-semibold text-danger-text">
            Somebody published {stale.currentVersionLabel ?? 'a newer version'} after this revision
            was started
            {stale.publishedByName ? ` — ${stale.publishedByName}` : ''}
            {stale.publishedAt ? `, ${stale.publishedAt.slice(0, 10)}` : ''}
          </span>
          <p className="text-[11.5px] leading-relaxed text-danger-text">
            This revision was seeded from a version that is no longer current, so publishing it
            would silently discard theirs. It cannot publish — start a new revision from the
            current version instead.
          </p>
          <Button
            size="sm"
            variant="outline"
            leadingIcon="git-branch"
            onClick={() => void discardAndRestart()}
          >
            Discard this draft and start a new revision from {stale.currentVersionLabel ?? 'the current version'}
          </Button>
        </div>
      )}

      {openCases && (
        <div className="flex flex-col gap-1.5 rounded-[14px] border border-danger bg-danger-soft p-3">
          <span className="text-[12.5px] font-semibold text-danger-text">
            {openCases.length} open case{openCases.length === 1 ? '' : 's'} would break under the
            revised structure
          </span>
          <p className="text-[11.5px] leading-relaxed text-danger-text">
            An open case finishes on the version it started on, and this tool has ONE part
            structure — the revised one no longer fits what those candidates are mid-way through.
            Publishing waits until they settle (finish or close), or revise without removing the
            parts they are on.
          </p>
          {openCases.map((c) => (
            <Link
              key={c.id}
              to={`/app/assessments/${c.id}`}
              className="text-[11.5px] font-medium text-danger-text underline"
            >
              View case {c.id.slice(0, 8)}
            </Link>
          ))}
        </div>
      )}

      {formGone && (
        <div className="flex flex-col gap-2 rounded-[14px] border border-danger bg-danger-soft p-3">
          <span className="text-[12.5px] font-semibold text-danger-text">
            The tool’s form no longer exists
          </span>
          <p className="text-[11.5px] leading-relaxed text-danger-text">
            The form this revision publishes into was deleted. The revision cannot update the
            original tool any more — you can publish this work as a NEW tool instead, which
            creates a fresh form and tool rather than revising the old one.
          </p>
          {/*
            A NEW tool needs its award like any other create (U5): this is the
            one revision arm that calls createTool, and without the control it
            would 400 `invalid_award` after the author already lost the form.
          */}
          <AwardControl
            title={title ?? ''}
            value={awardCompetencyId}
            onChange={setAwardCompetencyId}
          />
          <Button
            size="sm"
            variant="outline"
            leadingIcon="plus"
            disabled={!awardCompetencyId || busy}
            onClick={() => void publishAsNewTool()}
          >
            Publish as a new tool
          </Button>
        </div>
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

      {/*
        MARKS THAT WOULD PRINT NOWHERE. The exporter skips a field with no box
        silently — the safe failure on a competency record — so the one place
        the silence can be seen is before publish. Warning, not gate: the tool
        still assesses and certifies correctly, and the boxes can be placed in
        PDF mapping and re-published.
      */}
      {check.unplaced.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-[14px] border border-warning bg-warning-soft p-3">
          <span className="text-[11.5px] font-semibold text-warning-text">
            {check.unplaced.length} mark{check.unplaced.length === 1 ? '' : 's'} would not print —
            no box placed
          </span>
          {check.unplaced.map((message, i) => (
            <p key={i} className="text-[11.5px] text-warning-text">
              {message}
            </p>
          ))}
          <p className="text-[11.5px] text-warning-text">
            Place these in <strong>PDF mapping</strong> before publishing, or the marks will
            compute and the printed record will not show them.
          </p>
        </div>
      )}

      {failure && (
        <p role="alert" className="rounded-[10px] border border-danger bg-danger-soft p-[8px_10px] text-[11.5px] text-danger-text">
          {failure}
        </p>
      )}

      {/*
        THE REFUSAL, AS A FIX. Dangling Location rules resolve with one
        labelled click — the untick happens in the same transaction as the
        publish. A part with recorded evidence has no click: it must stay,
        and the panel says exactly which and why.
      */}
      {refusal && (
        <div className="flex flex-col gap-2 rounded-[14px] border border-warning bg-warning-soft p-3">
          {refusal.attemptedParts.length > 0 && (
            <>
              <span className="text-[11.5px] font-semibold text-warning-text">
                {refusal.attemptedParts.length === 1 ? 'A part' : 'Parts'} with recorded evidence
                cannot be removed
              </span>
              {refusal.attemptedParts.map((part) => (
                <p key={part.key} className="text-[11.5px] text-warning-text">
                  <strong>{part.label}</strong> has evidence on completed cases — removing it
                  would leave that evidence unable to print. Go back to{' '}
                  <strong>Generate</strong> and keep its section in this revision (it can stop
                  being required at any Location instead).
                </p>
              ))}
            </>
          )}
          {refusal.danglingRules.length > 0 && (
            <>
              <span className="text-[11.5px] font-semibold text-warning-text">
                Location rules still require parts this revision removes
              </span>
              {refusal.danglingRules.map((rule, i) => (
                <p key={i} className="text-[11.5px] text-warning-text">
                  <strong>{rule.locationName}</strong> requires <strong>{rule.partLabel}</strong>
                </p>
              ))}
              {refusal.attemptedParts.length === 0 ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void republish({ dropDanglingLocationRules: true })}
                  className="inline-flex h-[30px] w-fit items-center gap-1.5 rounded-lg bg-warning px-3 text-[11.5px] font-semibold text-white"
                >
                  <Icon name="check" size={13} />
                  Untick these at the Locations and publish
                </button>
              ) : (
                <p className="text-[11.5px] text-warning-text">
                  Keep the parts above first — rules naming a kept part stop dangling by
                  themselves, and any that still name a removed part can be unticked with the
                  publish then.
                </p>
              )}
            </>
          )}
        </div>
      )}

      <button
        type="button"
        // A fresh publish additionally waits on the award (U5, R1): letting
        // the click through would 400 `invalid_award` on the last step of a
        // seven-step flow. A republish never needs one — its award stands.
        disabled={!ready || busy || (!isRevision && !awardCompetencyId)}
        onClick={() => void publish()}
        className="inline-flex h-[34px] items-center justify-center gap-1.5 self-start rounded-lg bg-accent px-4 text-[12.5px] font-semibold text-accent-contrast disabled:opacity-50"
      >
        <Icon name="rocket" size={14} />
        {busy ? 'Publishing…' : 'Publish assessment tool'}
      </button>
    </div>
  );
}
