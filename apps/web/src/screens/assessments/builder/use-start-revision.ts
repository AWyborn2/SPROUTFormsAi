/**
 * "Start revision" — from a published tool to a seeded builder draft.
 *
 * The seed composes from three reads: the tool (manifest, template), the
 * template's CURRENT published version (fields, geometry, keys, source PDF —
 * the canonical record), and the surviving build draft when one exists (the
 * working state a version cannot reconstruct: structure grouping, part edits,
 * and who verified each answer key). Then one write creates the revision
 * draft row, which the server refuses with `revision_draft_exists` when the
 * tool already has one — the resume-or-discard dialog reads that refusal's
 * summary rather than silently overwriting a colleague's work (R13/AE5).
 */
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { FormField, RevisionIdentity } from '@formai/shared';
import { apiClient, ApiError } from '../../../lib/data/api-client.js';
import { assessmentsApi } from '../../../lib/data/assessments.js';
import { store } from '../../../lib/data/store.js';
import { toDraftState } from './builder-draft-state.js';
import { revisionDraftName, seedRevisionSnapshot } from './revision-seed.js';

/** The 409 body's summary of the draft already occupying the tool's slot. */
export interface ExistingRevisionDraft {
  id: string;
  name: string;
  updatedAt: string;
  savedByName: string | null;
}

interface VersionDetail {
  id: string;
  label: string;
  fields: FormField[];
  sourcePdfAssetId: string | null;
  revisionIdentity: RevisionIdentity | null;
}

export interface StartRevision {
  /** Seed and open the revision draft for this tool. */
  start: (toolId: string) => Promise<void>;
  /** Which tool a start is composing for, while it is. */
  pendingToolId: string | null;
  /** The existing draft a second start ran into — the resume/discard dialog's data. */
  existing: ExistingRevisionDraft | null;
  /** Clear the dialog. */
  dismissExisting: () => void;
  /** Resume the existing revision draft instead. */
  resumeExisting: () => void;
  /** Discard the existing draft and start fresh — the confirmed destructive arm. */
  discardAndRestart: (toolId: string) => Promise<void>;
  error: string | null;
}

export function useStartRevision(): StartRevision {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [pendingToolId, setPendingToolId] = useState<string | null>(null);
  const [existing, setExisting] = useState<ExistingRevisionDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(
    async (toolId: string) => {
      setError(null);
      setPendingToolId(toolId);
      try {
        const tool = await assessmentsApi.getTool(toolId);
        const form = await store.getForm(tool.templateId);
        if (!form?.currentVersionId) {
          setError('This tool has no published version to revise.');
          return;
        }
        const version = await apiClient.get<VersionDetail>(
          `/forms/${tool.templateId}/versions/${form.currentVersionId}`,
        );

        /*
          The surviving build draft, when one exists for this form. Its state
          carries the key attestations and the structure grouping the version
          cannot reconstruct (KTD5) — worth one extra read on a path that runs
          once a year per tool.
        */
        const drafts = await store.listBuilderDrafts();
        const buildDraft = drafts.find((d) => d.formId === tool.templateId && !d.revisionOfToolId);
        const priorDraftState = buildDraft
          ? (await store.getBuilderDraft(buildDraft.id)).state
          : undefined;

        const snapshot = seedRevisionSnapshot({
          tool: { id: tool.id, templateId: tool.templateId, name: tool.name, manifest: tool.manifest },
          version: {
            id: version.id,
            label: version.label,
            fields: version.fields,
            sourcePdfAssetId: version.sourcePdfAssetId,
          },
          priorDraftState,
        });

        const row = await store.saveBuilderDraft({
          name: revisionDraftName(
            { id: tool.id, templateId: tool.templateId, name: tool.name, manifest: tool.manifest },
            { id: version.id, label: version.label, fields: version.fields, sourcePdfAssetId: version.sourcePdfAssetId },
          ),
          assetId: snapshot.assetId ?? '',
          step: 'upload',
          state: toDraftState(snapshot) as Record<string, unknown>,
          formId: tool.templateId,
          versionId: null,
          revisionOfToolId: tool.id,
        });
        void qc.invalidateQueries();
        navigate(`/app/assessments/builder/${row.id}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          const body = err.body as { error?: string; existing?: ExistingRevisionDraft };
          if (body?.error === 'revision_draft_exists' && body.existing) {
            setExisting(body.existing);
            return;
          }
        }
        setError('Could not start the revision — nothing was created. Try again.');
      } finally {
        setPendingToolId(null);
      }
    },
    [navigate, qc],
  );

  const discardAndRestart = useCallback(
    async (toolId: string) => {
      if (!existing) return;
      const discarded = existing;
      setExisting(null);
      await store.discardBuilderDraft(discarded.id);
      await start(toolId);
    },
    [existing, start],
  );

  return {
    start,
    pendingToolId,
    existing,
    dismissExisting: () => setExisting(null),
    resumeExisting: () => {
      if (existing) navigate(`/app/assessments/builder/${existing.id}`);
    },
    discardAndRestart,
    error,
  };
}
