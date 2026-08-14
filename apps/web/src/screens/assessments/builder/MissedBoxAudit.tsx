import { useMemo, useState } from 'react';
import { Icon } from '@formai/ui';
import { useAuditForm } from '../../../lib/data/hooks.js';
import type { BuilderDraftState } from './use-builder-draft.js';

/**
 * The secondary-extraction pass, in the builder — a SECOND read of the source
 * PDF for printed inputs the first pass produced no field for.
 *
 * OPT-IN, AND NEVER APPLIED ON ITS OWN. The primary extraction can miss a box —
 * a signature line, a date cell, a stray tick — and that gap is invisible: the
 * form simply has no field there. This is the author's way to catch it without
 * re-reading the paper cell by cell. It lists what it finds and stops; the
 * author adds any genuine gap as a field on the left, because "the model thinks
 * this is fillable" is a prompt to look, not a decision to publish.
 */

/**
 * Everything the draft has ALREADY captured, so the audit is not handed back
 * its own form. Field labels, plus the column and fixed-row labels of a
 * repeating table — a "Date" or "Hours" column is exactly the kind of thing a
 * second read re-lists as missed if it is not told the table already has it.
 */
function knownLabelsFor(draft: BuilderDraftState): string[] {
  const labels: string[] = [];
  for (const f of draft.fields) {
    if (f.label) labels.push(f.label);
    for (const c of f.columns ?? []) if (c.label) labels.push(c.label);
    for (const r of f.fixedRows ?? []) if (r) labels.push(r);
  }
  return labels;
}

export function MissedBoxAudit({ draft }: { draft: BuilderDraftState }) {
  const audit = useAuditForm();
  const [ran, setRan] = useState(false);
  const knownLabels = useMemo(() => knownLabelsFor(draft), [draft.fields]);

  // Nothing to re-read without the source page. A from-scratch tool has no PDF;
  // the audit simply does not apply, so the panel stays out of the way.
  if (!draft.assetId) return null;

  const assetId = draft.assetId;
  const missed = audit.data?.missedInputs ?? [];

  return (
    <div className="mb-3 rounded-lg border border-border bg-surface-card p-[12px_14px]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2.5">
          <Icon name="search" size={15} className="mt-0.5 flex-none text-accent" />
          <div className="min-w-0">
            <span className="block text-[12.5px] font-semibold">Check for missed boxes</span>
            <span className="block max-w-[52ch] text-[11.5px] leading-snug text-text-tertiary">
              A second read of the PDF for printed inputs — signatures, dates, tick boxes — that no
              field covers yet. Nothing is added for you; it just points out gaps to look at.
            </span>
          </div>
        </div>
        <button
          type="button"
          disabled={audit.isPending}
          onClick={() => {
            setRan(true);
            audit.mutate({
              fileName: `${draft.title ?? 'assessment'}.pdf`,
              assetId,
              knownLabels,
              documentType: 'assessment',
            });
          }}
          className="inline-flex h-[30px] flex-none items-center gap-1.5 rounded-lg border border-border px-3 text-[11.5px] font-semibold text-text-secondary hover:bg-surface-hover disabled:opacity-50"
        >
          <Icon
            name={audit.isPending ? 'loader-circle' : 'search'}
            size={13}
            className={audit.isPending ? 'animate-spin' : ''}
          />
          {audit.isPending ? 'Checking…' : ran ? 'Check again' : 'Check the PDF'}
        </button>
      </div>

      {audit.isError && (
        <p className="mt-2 text-[11.5px] text-warning-text">
          Could not check the document — try again in a moment.
        </p>
      )}

      {audit.isSuccess && missed.length === 0 && (
        <p className="mt-2 flex items-center gap-1.5 text-[11.5px] font-medium text-success-text">
          <Icon name="check" size={13} className="flex-none" />
          No missed boxes — every printed input already has a field.
        </p>
      )}

      {missed.length > 0 && (
        <div className="mt-2.5 flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-[11.5px] font-semibold text-warning-text">
            <Icon name="alert-triangle" size={13} className="flex-none" />
            {missed.length} printed box{missed.length === 1 ? '' : 'es'} may have no field — add any
            real gaps on the left.
          </span>
          {missed.map((box, i) => (
            <div
              key={`${box.label}-${i}`}
              className="flex items-start gap-2 rounded-md border border-border-subtle bg-surface-sunken p-[6px_9px]"
            >
              <Icon name="square-dashed" size={13} className="mt-0.5 flex-none text-text-tertiary" />
              <div className="min-w-0 text-[11.5px] leading-snug">
                <span className="font-medium text-text-primary">{box.label}</span>
                <span className="ml-1.5 rounded bg-surface-card px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
                  {box.type.replace(/_/g, ' ')}
                </span>
                {box.page !== undefined && (
                  <span className="ml-1.5 text-text-tertiary">p.{box.page}</span>
                )}
                {box.note && <span className="mt-0.5 block text-text-tertiary">{box.note}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
