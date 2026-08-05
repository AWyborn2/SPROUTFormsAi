import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, Icon } from '@formai/ui';
import {
  BUILDER_NEXT_LABELS,
  BUILDER_STEPS,
  stepIndex,
  type BuilderStep,
} from '@formai/shared';
import { BuilderMiniSteps, BuilderStepper } from './BuilderStepper.js';
import { UploadStep } from './steps/UploadStep.js';
import { StepPlaceholder } from './steps/StepPlaceholder.js';
import { useBuilderDraftState } from './use-builder-draft.js';

/**
 * The assessment builder — seven steps from a printed competency PDF to a
 * published, enrollable assessment tool.
 *
 * WHY A SEPARATE SURFACE FROM THE IMPORT WIZARD. The import wizard's job ends
 * at a published template version, and for most document classes that is the
 * whole job. An assessment tool needs three more things a template version has
 * no room for — a part manifest, an answer key per question, and a workflow —
 * and today all three are authored outside the product: by a node script, from
 * a JSON file, against a database URL. This is that work, in the app.
 *
 * IT REUSES THE PIPELINE RATHER THAN REPLACING IT. Extraction is the same
 * server-side `/pdf/extract` with the same tuned assessment profile; placement
 * is the same geometry model; marking is the same exact-set rule. What is new
 * here is the authoring, not the machinery.
 *
 * NAVIGATION IS FREE, NOT WIZARD-LOCKED. An author keying answers will jump
 * back to correct a question's type, and forward to check where its box sits.
 * The only step that gates the rest is the first: until a document has been
 * read there is nothing for any other step to act on.
 */
export function BuilderScreen() {
  const navigate = useNavigate();
  const { draftId } = useParams<{ draftId?: string }>();
  const draft = useBuilderDraftState(draftId);
  const [step, setStep] = useState<BuilderStep>('upload');
  const [hintDismissed, setHintDismissed] = useState(false);

  /*
    Everything past Upload needs a document. Blocking is what the stepper shows
    rather than what a click discovers — a step that opens onto an empty screen
    reads as a broken product.
  */
  const blocked = useMemo<BuilderStep[]>(
    () => (draft.hasDocument ? [] : BUILDER_STEPS.filter((s) => s !== 'upload')),
    [draft.hasDocument],
  );

  const go = useCallback(
    (next: BuilderStep) => {
      if (blocked.includes(next)) return;
      setStep(next);
    },
    [blocked],
  );

  const at = stepIndex(step);
  const canAdvance = draft.hasDocument;
  /*
    Steps 2 and 3 own the full width: their left column is a full-height panel
    flush against the app sidebar, so the page header and the wide stepper are
    replaced by the compact rail that sits inside the artifact column.
  */
  const compactChrome = step === 'generate' || step === 'design';

  const body = (() => {
    switch (step) {
      case 'upload':
        return <UploadStep draft={draft} />;
      default:
        return <StepPlaceholder step={step} />;
    }
  })();

  return (
    <div className="fai-rise p-[26px_28px_60px]">
      {!compactChrome && (
        <>
          {!hintDismissed && (
            <div className="mx-auto mb-[18px] flex max-w-[1080px] items-start gap-2.5 rounded-lg border border-border-accent bg-surface-accent-soft p-[10px_14px] text-[12.5px] text-text-secondary">
              <Icon name="sparkles" size={15} className="mt-px flex-none text-accent" />
              <span className="flex-1">
                <strong className="text-text-primary">Assessment builder</strong> — seven steps from
                a printed competency tool to a published assessment. Your work saves as you go; you
                can leave and come back.
              </span>
              <button
                type="button"
                onClick={() => setHintDismissed(true)}
                aria-label="Dismiss"
                className="flex-none text-text-tertiary hover:text-text-secondary"
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          )}

          <div className="mx-auto mb-5 flex max-w-[1080px] flex-wrap items-end gap-3.5">
            <div className="min-w-0 flex-1">
              <Link
                to="/app/assessments"
                className="mb-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-text-tertiary hover:text-text-accent"
              >
                <Icon name="arrow-left" size={13} />
                Assessments
              </Link>
              <div className="font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
                New assessment tool
              </div>
              <h1 className="font-heading text-[24px] font-bold leading-tight">
                {draft.title ?? 'Untitled assessment'}
              </h1>
            </div>
            {draft.hasDocument && (
              <div className="flex flex-none items-center gap-2 pb-0.5">
                <span className="rounded-full bg-surface-sunken px-2.5 py-1 text-[12px] font-medium text-text-secondary">
                  {draft.pageCount} pages
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-soft px-2.5 py-1 text-[12px] font-semibold text-warning-text">
                  <span className="h-1.5 w-1.5 rounded-full bg-warning" />
                  Draft
                </span>
              </div>
            )}
          </div>

          <BuilderStepper current={step} onGo={go} disabled={blocked} />
        </>
      )}

      {compactChrome && (
        <div className="mb-4 flex flex-wrap items-center gap-3 border-b border-border-subtle px-1 pb-3">
          <button
            type="button"
            onClick={() => navigate('/app/assessments')}
            aria-label="Back to assessments"
            className="grid h-7 w-7 flex-none place-items-center rounded-lg border border-border text-text-tertiary hover:bg-surface-hover"
          >
            <Icon name="arrow-left" size={14} />
          </button>
          <span className="max-w-[280px] flex-none truncate font-heading text-[15px] font-bold">
            {draft.title ?? 'Untitled assessment'}
          </span>
          <span className="inline-flex flex-none items-center gap-1.5 rounded-full bg-warning-soft px-2.5 py-[3px] text-[10.5px] font-semibold text-warning-text">
            <span className="h-[5px] w-[5px] rounded-full bg-warning" />
            Draft
          </span>
          <BuilderMiniSteps current={step} onGo={go} disabled={blocked} />
        </div>
      )}

      {body}

      <div className="relative z-[1] mx-auto mt-[26px] flex max-w-[1000px] items-center justify-between">
        {at > 0 ? (
          <button
            type="button"
            onClick={() => go(BUILDER_STEPS[at - 1]!)}
            className="inline-flex items-center gap-1.5 rounded-[10px] px-2.5 py-2 text-[13.5px] text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
          >
            <Icon name="arrow-left" size={15} />
            Back
          </button>
        ) : (
          <span />
        )}
        <Button
          disabled={!canAdvance}
          trailingIcon={step === 'workflow' ? 'rocket' : 'arrow-right'}
          onClick={() => {
            if (step === 'workflow') return;
            go(BUILDER_STEPS[at + 1]!);
          }}
        >
          {BUILDER_NEXT_LABELS[step]}
        </Button>
      </div>
    </div>
  );
}
