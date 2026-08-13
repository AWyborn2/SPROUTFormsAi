import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { GenerateStep } from './steps/GenerateStep.js';
import { UnitsStep } from './steps/UnitsStep.js';
import { AnswerKeyStep } from './steps/AnswerKeyStep.js';
import { PlacementStep } from './steps/PlacementStep.js';
import { WorkflowStep } from './steps/WorkflowStep.js';
import { StepPlaceholder } from './steps/StepPlaceholder.js';
import { useBuilderDraftState } from './use-builder-draft.js';
import { useBuilderAutosave, useBuilderResume } from './use-builder-persistence.js';

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
  const [step, setStep] = useState<BuilderStep>('upload');
  /*
    THE LOAD AND THE SAVE LIVE OUTSIDE THE STATE HOOK, which keeps
    `useBuilderDraftState` free of requests and providers. The composition runs
    load → state → save: the snapshot the persistence hook writes is the one the
    state hook just produced, and the snapshot it read is handed back in.
  */
  const resume = useBuilderResume(draftId);
  const draft = useBuilderDraftState({ hydrateFrom: resume.hydrateFrom ?? null });
  const persisted = useBuilderAutosave(draft.snapshot, step, resume.ready, draftId);
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

  /*
    OPEN A RESUMED DRAFT WHERE IT WAS LEFT.

    Once — a ref rather than a comparison, because the author is free to
    navigate away from the resumed step immediately, and re-applying it would
    drag them back every time the draft object changed identity.
  */
  const restoredStep = useRef(false);
  useEffect(() => {
    if (restoredStep.current || !resume.resumedStep) return;
    restoredStep.current = true;
    setStep(resume.resumedStep);
  }, [resume.resumedStep]);

  /*
    UNDO / REDO, ON EVERY STEP. Ctrl/⌘+Z undoes, Ctrl/⌘+Shift+Z or Ctrl+Y
    redoes. Typing surfaces are left alone — a text box's own undo belongs to
    the browser, and stealing the stroke mid-word would revert a structural
    edit while the author is looking at a rename.
  */
  const { undo, redo } = draft.history;
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      if (key === 'y' || (key === 'z' && e.shiftKey)) redo();
      else undo();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo]);

  /** ⌘ on Mac platforms, Ctrl elsewhere — for the button tooltips. */
  const modKey = /mac|iphone|ipad/i.test(navigator.platform) ? '⌘' : 'Ctrl+';
  const undoRedoControls = draft.hasDocument && (
    <div className="flex flex-none items-center gap-1">
      <button
        type="button"
        onClick={draft.history.undo}
        disabled={!draft.history.canUndo}
        aria-label="Undo"
        title={`Undo (${modKey}Z)`}
        className="grid h-7 w-7 place-items-center rounded-lg border border-border text-text-secondary hover:bg-surface-hover disabled:opacity-35"
      >
        <Icon name="undo-2" size={14} />
      </button>
      <button
        type="button"
        onClick={draft.history.redo}
        disabled={!draft.history.canRedo}
        aria-label="Redo"
        title={`Redo (${modKey}Shift+Z)`}
        className="grid h-7 w-7 place-items-center rounded-lg border border-border text-text-secondary hover:bg-surface-hover disabled:opacity-35"
      >
        <Icon name="redo-2" size={14} />
      </button>
    </div>
  );

  /*
    PUT THE DRAFT'S ID IN THE URL AS SOON AS ONE EXISTS.

    This is what makes the CURRENT tab survivable. Autosave alone protects the
    work but not the session: refresh a builder sitting on `/builder` and it
    opens empty, with the saved draft reachable only by going back to the upload
    step and finding it in the resume list — which is not where anyone looks
    after an accidental reload.

    `replace` so the browser's Back button still leaves the builder rather than
    stepping through a URL the author never navigated to.
  */
  useEffect(() => {
    if (!persisted.savedDraftId || draftId === persisted.savedDraftId) return;
    navigate(`/app/assessments/builder/${persisted.savedDraftId}`, { replace: true });
  }, [persisted.savedDraftId, draftId, navigate]);

  const at = stepIndex(step);
  const canAdvance = draft.hasDocument;
  /*
    Steps 2 and 6 own the full width: their left column is a full-height panel
    flush against the app sidebar, so the page header and the wide stepper are
    replaced by the compact rail — and the page itself stops scrolling, each
    column scrolling internally instead.
  */
  const compactChrome = step === 'generate' || step === 'placement';

  const body = (() => {
    /*
      A RESUME IN FLIGHT IS NOT AN EMPTY BUILDER. Without this the upload step
      renders while the draft loads, so an author who reopens their work is
      shown a dropzone — and the obvious reaction to that is to upload the PDF
      again, which starts a second draft under the same name and overwrites the
      one that was loading.
    */
    if (resume.resuming) {
      return (
        <div className="mx-auto max-w-[1080px] rounded-[14px] border border-border bg-surface-card p-4">
          <span className="block text-[14.5px] font-semibold">Reopening your draft…</span>
          <p className="mt-1 text-[12.5px] leading-relaxed text-text-secondary">
            Loading the document, the fields and the answer key you saved.
          </p>
        </div>
      );
    }
    switch (step) {
      case 'upload':
        return <UploadStep draft={draft} />;
      case 'generate':
        return <GenerateStep draft={draft} />;
      case 'units':
        return <UnitsStep draft={draft} />;
      case 'workflow':
        return <WorkflowStep draft={draft} />;
      case 'placement':
        return <PlacementStep draft={draft} />;
      case 'answer_key':
        return <AnswerKeyStep draft={draft} />;
      default:
        return <StepPlaceholder step={step} />;
    }
  })();

  return (
    /*
      THE GENERATE STEP DOES NOT SCROLL THE PAGE. Its columns scroll
      themselves — the structure list in its panel, the preview in its column —
      so the app bar, the builder chrome and the selection toolbar hold still
      while an author works a 24-section document. Every other step keeps the
      ordinary scrolling page.
    */
    <div
      className={
        compactChrome
          ? 'fai-rise flex h-[calc(100vh-56px)] min-h-0 flex-col overflow-hidden p-[12px_28px_0]'
          : 'fai-rise p-[26px_28px_60px]'
      }
    >
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
                {undoRedoControls}
                {/*
                  THE HINT ABOVE PROMISES "your work saves as you go", which was
                  untrue until autosave existed. Showing when the last write
                  landed is what makes the promise checkable rather than
                  something an author has to take on faith — and it is the only
                  signal that a save is failing, since a failed autosave is
                  deliberately silent so it cannot interrupt authoring.
                */}
                {persisted.savedAt && (
                  <span className="rounded-full bg-surface-sunken px-2.5 py-1 text-[12px] font-medium text-text-tertiary">
                    Saved{' '}
                    {persisted.savedAt.toLocaleTimeString(undefined, {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                )}
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
          {undoRedoControls}
          <BuilderMiniSteps current={step} onGo={go} disabled={blocked} />
        </div>
      )}

      {compactChrome ? <div className="min-h-0 flex-1">{body}</div> : body}

      <div
        className={`relative z-[1] mx-auto flex max-w-[1000px] items-center justify-between ${
          compactChrome ? 'w-full flex-none py-2.5' : 'mt-[26px]'
        }`}
      >
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
