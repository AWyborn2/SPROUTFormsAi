import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Icon, Input, useToast } from '@formai/ui';
import { useCreateVersionFromImport, useForm, usePublishImport } from '../../lib/data/hooks.js';
import { reviewedToFields, useImportSession } from '../../lib/data/import-session.js';
import { canExportSubmission } from '../../lib/data/store.js';
import { stripFileExtension } from './upload-validation.js';
import { ImportStepper } from './ImportStepper.js';

/**
 * Import step 3 — confirm and publish the reviewed template. In re-extract
 * mode (session.targetFormId set) the result lands as a new VERSION of that
 * existing form instead of a new form: saved as a draft to publish later from
 * version history, or published now (flipping live fill links immediately).
 */
export function ImportPublishScreen() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const publish = usePublishImport();
  const createVersion = useCreateVersionFromImport();
  const session = useImportSession();
  const { data: targetForm } = useForm(session.targetFormId ?? undefined);
  /** File name minus its extension — the default title for the published form. */
  const [name, setName] = useState(() => stripFileExtension(session.fileName));
  /** Which re-extract action fired — so only that button shows its spinner. */
  const [versionMode, setVersionMode] = useState<'draft' | 'publish' | null>(null);

  // Guard direct navigation — publishing needs a completed extraction to publish.
  const ready = session.status === 'ready' && session.total > 0;
  useEffect(() => {
    if (!ready) navigate('/app/import', { replace: true });
  }, [ready, navigate]);

  if (!ready) return null;

  const isReExtract = !!session.targetFormId;
  const targetArchived = targetForm?.status === 'archived';
  const tableCount = session.fields.filter((f) => f.type === 'repeating_group').length;
  const trimmedName = name.trim();
  const pending = publish.isPending || createVersion.isPending;

  // Whether anything on this form can be PLACED on the original page — either a
  // legacy AcroForm `sourcePosition` or geometry a reviewer confirmed in step 2.
  // It is not a question about the extraction path: an AI-extracted PDF whose
  // grid has been confirmed round-trips just as well. The fields publish either
  // way. (The prose below already says this; the comment did not.)
  const canRoundTrip = canExportSubmission(reviewedToFields(session.fields));

  function doPublish() {
    publish.mutate(
      {
        name: trimmedName,
        fields: reviewedToFields(session.fields),
        sourcePdfAssetId: session.assetId,
      },
      {
        onSuccess: () => {
          toast({
            message: `${trimmedName} is live${
              tableCount > 0
                ? ` — with its ${tableCount === 1 ? 'repeating table' : `${tableCount} repeating tables`} intact`
                : ''
            }.`,
            variant: 'success',
          });
          navigate('/app/forms');
        },
        onError: () => {
          toast({ message: 'Could not publish — try again.', variant: 'danger' });
        },
      },
    );
  }

  function doCreateVersion(publishNow: boolean) {
    if (!session.targetFormId) return;
    setVersionMode(publishNow ? 'publish' : 'draft');
    createVersion.mutate(
      {
        formId: session.targetFormId,
        fields: reviewedToFields(session.fields),
        ...(session.assetId ? { sourcePdfAssetId: session.assetId } : {}),
        publish: publishNow,
      },
      {
        onSuccess: (summary) => {
          toast({
            variant: 'success',
            message: publishNow
              ? `${summary.name} is updated — fill links serve the new version immediately.`
              : `Draft version saved — publish it from ${summary.name}'s version history when ready.`,
          });
          navigate('/app/forms');
        },
        onError: () => {
          toast({ message: 'Could not save the new version — try again.', variant: 'danger' });
        },
      },
    );
  }

  return (
    <div className="fai-rise p-[30px_28px_60px]">
      <ImportStepper currentStep={2} />

      <div className="mx-auto max-w-[620px]">
        <div className="mb-6 text-center">
          <span className="mb-3.5 inline-grid h-14 w-14 place-items-center rounded-[14px] bg-surface-accent-soft">
            <Icon name="badge-check" size={27} className="text-accent" />
          </span>
          <h3 className="mb-1.5 text-[22px]">{isReExtract ? 'Ready to update' : 'Ready to publish'}</h3>
          <p className="text-sm text-text-secondary">
            {canRoundTrip
              ? `All ${session.total} fields are mapped and the layout is preserved for a faithful PDF round-trip.`
              : `All ${session.total} fields are mapped. No field has a confirmed position on the page yet, so submissions export as data rather than as a filled copy of this PDF. Confirm a field's position in review to change that — the form publishes and collects responses either way.`}
          </p>
        </div>

        <div className="mb-4 rounded-lg border border-border bg-surface-card p-5 shadow-xs">
          <div className="flex flex-col gap-[13px]">
            {isReExtract ? (
              <div className="flex items-center gap-3">
                <span className="w-[120px] flex-none text-[12.5px] text-text-tertiary">Updates form</span>
                <span className="flex items-center gap-[7px] text-sm font-semibold">
                  <Icon name="refresh-cw" size={15} className="text-text-tertiary" />
                  {targetForm?.name ?? 'Form'}
                  {targetForm ? ` · currently ${targetForm.version}` : ''}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <span className="w-[120px] flex-none text-[12.5px] text-text-tertiary">Form name</span>
                <div className="flex-1">
                  <Input
                    aria-label="Form name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Give this form a name"
                  />
                </div>
              </div>
            )}
            <div className="h-px bg-border-subtle" />
            <div className="flex items-center gap-3">
              <span className="w-[120px] flex-none text-[12.5px] text-text-tertiary">Fields mapped</span>
              <span className="text-sm font-semibold">
                {session.total}
                {tableCount > 0
                  ? ` · incl. ${tableCount} repeating ${tableCount === 1 ? 'table' : 'tables'}`
                  : ''}
              </span>
            </div>
            <div className="h-px bg-border-subtle" />
            {!isReExtract && (
              <>
                <div className="flex items-center gap-3">
                  <span className="w-[120px] flex-none text-[12.5px] text-text-tertiary">Destination</span>
                  <span className="flex items-center gap-[7px] text-sm font-semibold">
                    <Icon name="folder" size={15} className="text-text-tertiary" />
                    Form library
                  </span>
                </div>
                <div className="h-px bg-border-subtle" />
              </>
            )}
            <div className="flex items-center gap-3">
              <span className="w-[120px] flex-none text-[12.5px] text-text-tertiary">Round-trip PDF</span>
              {canRoundTrip ? (
                <span className="flex items-center gap-[7px] text-[13px] font-semibold text-success-text">
                  <Icon name="check-circle-2" size={15} />
                  Layout preserved
                </span>
              ) : (
                <span className="flex items-center gap-[7px] text-[13px] font-semibold text-text-secondary">
                  <Icon name="info" size={15} className="text-text-tertiary" />
                  No confirmed positions — exports as data
                </span>
              )}
            </div>
          </div>
        </div>

        {isReExtract && (
          <p className="mb-4 text-[13px] text-text-secondary">
            {targetArchived
              ? 'This form is archived — publishing now will restore it and put it back in circulation, and live fill links will serve the new version immediately. Saving as a draft leaves it archived.'
              : '"Publish now" switches live fill links to the new version immediately. "Save as draft version" keeps the current version live until you publish from version history.'}
          </p>
        )}

        <div className="flex items-center justify-between">
          <button
            onClick={() => navigate('/app/import/review')}
            className="inline-flex items-center gap-1 text-[13.5px] text-text-tertiary"
          >
            <Icon name="arrow-left" size={14} />
            Review
          </button>
          {isReExtract ? (
            <div className="flex items-center gap-2.5">
              <Button
                variant="outline"
                leadingIcon="save"
                onClick={() => doCreateVersion(false)}
                loading={createVersion.isPending && versionMode === 'draft'}
                disabled={pending}
              >
                Save as draft version
              </Button>
              <Button
                leadingIcon="rocket"
                onClick={() => doCreateVersion(true)}
                loading={createVersion.isPending && versionMode === 'publish'}
                disabled={pending}
              >
                {targetArchived ? 'Publish & restore' : 'Publish now'}
              </Button>
            </div>
          ) : (
            <Button leadingIcon="rocket" onClick={doPublish} loading={publish.isPending} disabled={!trimmedName}>
              Publish form
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
