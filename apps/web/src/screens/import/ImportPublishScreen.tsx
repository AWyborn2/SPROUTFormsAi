import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Icon, Input, useToast } from '@formai/ui';
import { usePublishImport } from '../../lib/data/hooks.js';
import { reviewedToFields, useImportSession } from '../../lib/data/import-session.js';
import { canExportSubmission } from '../../lib/data/store.js';
import { stripFileExtension } from './upload-validation.js';
import { ImportStepper } from './ImportStepper.js';

/** Import step 3 — confirm and publish the reviewed template. */
export function ImportPublishScreen() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const publish = usePublishImport();
  const session = useImportSession();
  /** File name minus its extension — the default title for the published form. */
  const [name, setName] = useState(() => stripFileExtension(session.fileName));

  // Guard direct navigation — publishing needs a completed extraction to publish.
  const ready = session.status === 'ready' && session.total > 0;
  useEffect(() => {
    if (!ready) navigate('/app/import', { replace: true });
  }, [ready, navigate]);

  if (!ready) return null;

  const tableCount = session.fields.filter((f) => f.type === 'repeating_group').length;
  const trimmedName = name.trim();

  // Only AcroForm-imported PDFs carry per-field positions; AI-extracted (flat /
  // scanned) PDFs read the fields but not their pixel anchors, so they can't be
  // rendered back into a filled PDF. The fields still publish either way.
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

  return (
    <div className="fai-rise p-[30px_28px_60px]">
      <ImportStepper currentStep={2} />

      <div className="mx-auto max-w-[620px]">
        <div className="mb-6 text-center">
          <span className="mb-3.5 inline-grid h-14 w-14 place-items-center rounded-[14px] bg-surface-accent-soft">
            <Icon name="badge-check" size={27} className="text-accent" />
          </span>
          <h3 className="mb-1.5 text-[22px]">Ready to publish</h3>
          <p className="text-sm text-text-secondary">
            {canRoundTrip
              ? `All ${session.total} fields are mapped and the layout is preserved for a faithful PDF round-trip.`
              : `All ${session.total} fields are mapped. This PDF was extracted by AI, so it won't round-trip to a filled PDF — the fields publish and collect responses either way.`}
          </p>
        </div>

        <div className="mb-4 rounded-lg border border-border bg-surface-card p-5 shadow-xs">
          <div className="flex flex-col gap-[13px]">
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
            <div className="flex items-center gap-3">
              <span className="w-[120px] flex-none text-[12.5px] text-text-tertiary">Destination</span>
              <span className="flex items-center gap-[7px] text-sm font-semibold">
                <Icon name="folder" size={15} className="text-text-tertiary" />
                Form library
              </span>
            </div>
            <div className="h-px bg-border-subtle" />
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
                  AI-extracted — won't round-trip
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <button
            onClick={() => navigate('/app/import/review')}
            className="inline-flex items-center gap-1 text-[13.5px] text-text-tertiary"
          >
            <Icon name="arrow-left" size={14} />
            Review
          </button>
          <Button
            leadingIcon="rocket"
            onClick={doPublish}
            loading={publish.isPending}
            disabled={!trimmedName}
          >
            Publish form
          </Button>
        </div>
      </div>
    </div>
  );
}
