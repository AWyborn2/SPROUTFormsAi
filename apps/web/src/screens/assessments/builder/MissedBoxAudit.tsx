import { useMemo, useState } from 'react';
import { Icon } from '@formai/ui';
import { useAuditForm } from '../../../lib/data/hooks.js';
import type { BuilderDraftState } from './use-builder-draft.js';

/**
 * The secondary-extraction pass, in the builder — a SECOND read of the source
 * PDF for printed inputs the first pass produced no field for, and a one-click
 * way to add each real gap where it belongs.
 *
 * OPT-IN, AND NOTHING IS ADDED WITHOUT A CLICK. The primary extraction can miss
 * a box — a signature line, a date cell, a stray tick — and that gap is
 * invisible: the form simply has no field there. This surfaces what it missed
 * and lets the author drop any genuine one into a section as a field, rather
 * than re-reading the paper cell by cell or retyping it by hand. The model
 * proposing a box is a prompt to look; the author choosing to add it is the
 * decision.
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
  /** Boxes added this run, by index — so a row shows "Added" and cannot double-add. */
  const [added, setAdded] = useState<Record<number, string>>({});
  /** Which section each box will be added to; defaults to the first real section. */
  const [sectionChoice, setSectionChoice] = useState<Record<number, string>>({});
  const knownLabels = useMemo(() => knownLabelsFor(draft), [draft.fields]);

  // The sections a box can be added to — cover sections are addressed by the
  // manifest, not filled as parts, so they are not add targets.
  const sections = useMemo(
    () => draft.structure.filter((s) => !s.cover).map((s) => ({ key: s.key, label: s.label })),
    [draft.structure],
  );

  // Nothing to re-read without the source page. A from-scratch tool has no PDF;
  // the audit simply does not apply, so the panel stays out of the way.
  if (!draft.assetId) return null;

  const assetId = draft.assetId;
  const missed = audit.data?.missedInputs ?? [];

  const runCheck = () => {
    setRan(true);
    // A fresh run is a fresh list — forget what was added against the old one.
    setAdded({});
    setSectionChoice({});
    audit.mutate({
      fileName: `${draft.title ?? 'assessment'}.pdf`,
      assetId,
      knownLabels,
      documentType: 'assessment',
    });
  };

  const addBox = (index: number, box: (typeof missed)[number]) => {
    const sectionKey = sectionChoice[index] ?? sections[0]?.key;
    if (!sectionKey) return;
    const section = draft.structure.find((s) => s.key === sectionKey);
    // End of the section, so the added field lands after what is already there
    // and the author drags it into its exact place from the structure panel.
    const afterFieldId = section?.fields.at(-1)?.id ?? null;
    draft.fieldOps.add(sectionKey, afterFieldId, box.type, box.label);
    const label = sections.find((s) => s.key === sectionKey)?.label ?? sectionKey;
    setAdded((prev) => ({ ...prev, [index]: label }));
  };

  return (
    <div className="mb-3 rounded-lg border border-border bg-surface-card p-[12px_14px]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2.5">
          <Icon name="search" size={15} className="mt-0.5 flex-none text-accent" />
          <div className="min-w-0">
            <span className="block text-[12.5px] font-semibold">Check for missed boxes</span>
            <span className="block max-w-[52ch] text-[11.5px] leading-snug text-text-tertiary">
              A second read of the PDF for printed inputs — signatures, dates, tick boxes — that no
              field covers yet. Add the real gaps into a section; ignore the rest.
            </span>
          </div>
        </div>
        <button
          type="button"
          disabled={audit.isPending}
          onClick={runCheck}
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
            {missed.length} printed box{missed.length === 1 ? '' : 'es'} may have no field — add the
            real gaps.
          </span>
          {missed.map((box, i) => {
            const addedTo = added[i];
            return (
              <div
                key={`${box.label}-${i}`}
                className={`flex items-start justify-between gap-3 rounded-md border border-border-subtle bg-surface-sunken p-[6px_9px] ${
                  addedTo ? 'opacity-60' : ''
                }`}
              >
                <div className="flex min-w-0 items-start gap-2">
                  <Icon
                    name={addedTo ? 'check' : 'square-dashed'}
                    size={13}
                    className={`mt-0.5 flex-none ${addedTo ? 'text-accent' : 'text-text-tertiary'}`}
                  />
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

                {addedTo ? (
                  <span className="flex-none whitespace-nowrap pt-0.5 text-[10.5px] font-medium text-text-tertiary">
                    Added to {addedTo}
                  </span>
                ) : (
                  <div className="flex flex-none items-center gap-1.5">
                    <select
                      aria-label={`Section to add "${box.label}" to`}
                      value={sectionChoice[i] ?? sections[0]?.key ?? ''}
                      onChange={(e) => setSectionChoice((prev) => ({ ...prev, [i]: e.target.value }))}
                      className="h-[26px] max-w-[150px] rounded-lg border border-border bg-surface-page px-1.5 text-[10.5px] text-text-secondary"
                    >
                      {sections.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => addBox(i, box)}
                      className="inline-flex h-[26px] flex-none items-center gap-1 rounded-lg border border-accent bg-surface-accent-soft px-2 text-[10.5px] font-semibold text-text-accent hover:brightness-105"
                    >
                      <Icon name="plus" size={12} />
                      Add
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          <span className="mt-0.5 text-[10.5px] text-text-tertiary">
            Added as a field at the end of the section you pick — drag it into place, and set its
            columns or type on the left.
          </span>
        </div>
      )}
    </div>
  );
}
