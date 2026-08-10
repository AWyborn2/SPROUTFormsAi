import { Icon } from '@formai/ui';
import { BUILDER_STEP_LABELS, type BuilderStep } from '@formai/shared';

/**
 * A step whose screen has not been built yet.
 *
 * NAMED, NOT BLANK, and honest about what is missing. The builder's steps land
 * in phases, and a step that renders nothing reads as a broken product — while
 * one that renders a convincing mock reads as a working feature and is worse.
 * This says which step it is, what it will do, and where that work is done
 * today, so somebody who reaches it is not stuck.
 */

const WHAT: Record<BuilderStep, { does: string; today: string }> = {
  upload: {
    does: 'Reads the document and drafts the setup questions.',
    today: '',
  },
  generate: {
    does: 'Arrange the form’s sections and fields, and page through a live preview of every part.',
    today: 'Field order and grouping are reviewed in the import wizard’s review step.',
  },
  units: {
    does: 'Declare the parts, their pathways, prerequisites and logbook thresholds.',
    today: 'The part manifest is authored by packages/db/scripts/author-track-dozer-tool.mjs.',
  },
  answer_key: {
    does: 'Key every theory question — upload a guide, or set the answers and matching pairs by hand.',
    today: 'The answer key is a JSON file read by the same authoring script.',
  },
  placement: {
    does: 'Place each field on the printed page and choose the mark it prints.',
    today: 'Placement runs in the import review step and the standalone placement screen.',
  },
  workflow: {
    does: 'Decide who fills what, in what order, and which values autofill — then publish.',
    today: 'The workflow builder is at Assessments → a tool → Workflow.',
  },
};

export function StepPlaceholder({ step }: { step: BuilderStep }) {
  const what = WHAT[step];
  return (
    <div className="mx-auto max-w-[640px] rounded-[14px] border border-dashed border-border bg-surface-sunken p-[28px_26px] text-center">
      <span className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-surface-card">
        <Icon name="hammer" size={20} className="text-text-tertiary" />
      </span>
      <h2 className="mt-3 font-heading text-[16px] font-bold">
        {BUILDER_STEP_LABELS[step]} — not built yet
      </h2>
      <p className="mx-auto mt-1.5 max-w-[52ch] text-[13px] leading-relaxed text-text-secondary">
        {what.does}
      </p>
      {what.today && (
        <p className="mx-auto mt-2.5 max-w-[52ch] text-[12px] leading-relaxed text-text-tertiary">
          Until it lands: {what.today}
        </p>
      )}
    </div>
  );
}
