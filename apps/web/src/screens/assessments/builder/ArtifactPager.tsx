import { useMemo, useState } from 'react';
import { Icon } from '@formai/ui';
import { resolveSpan, type BuilderStructure, type FormField } from '@formai/shared';
import { FieldInput } from '../../fields/FieldRenderer.js';
import { previewSpanClass } from '../../../lib/fill-layout.js';
import { colSpanFor } from './builder-structure.js';
import { clampPage, previewLabel, previewPages, type PageKind } from './builder-pages.js';

/**
 * The live artifact — every section of the form being built, one page at a
 * time.
 *
 * IT RENDERS THROUGH THE REAL `FieldInput`, not a drawing of one. The design
 * prototype hand-drew each page shape, and a hand-drawn preview is a second
 * renderer: it agrees with the real one until somebody changes one of them, and
 * then it lies — most damagingly about the questions, which is the one thing an
 * author is checking here. Reusing the renderer means the preview is wrong only
 * when the form is wrong.
 *
 * NOTHING IS PERSISTED AND NOTHING IS ASKED FOR. Values live in local state and
 * are thrown away; `dictation` stays off so a preview never asks for the
 * microphone; `uploadPath` is null so a file control never litters the bucket
 * with objects no submission will reference. All three are the contract
 * `FieldInput` already documents for a preview surface — this surface simply
 * honours it.
 */

const KIND_META: Record<PageKind, { icon: string; note: string }> = {
  cover: {
    icon: 'file-text',
    note: 'Printed on one sheet — identity, eligibility and the assessor’s verdict.',
  },
  theory: {
    icon: 'list-checks',
    note: 'Auto-marked against the answer key you set in Step 5.',
  },
  practical: {
    icon: 'clipboard-check',
    note: 'Observed and marked by the assessor, one row per criterion.',
  },
  logbook: {
    icon: 'timer',
    note: 'Entries added over weeks; hours total against the part’s minimum.',
  },
  fields: { icon: 'layers', note: '' },
};

export interface ArtifactPagerProps {
  structure: BuilderStructure;
  fields: readonly FormField[];
  /** Fields the author excluded from the digital form, by id. */
  excluded?: ReadonlySet<string>;
}

export function ArtifactPager({ structure, fields, excluded }: ArtifactPagerProps) {
  const [at, setAt] = useState(0);
  /**
   * Answers typed into the preview.
   *
   * Real state, deliberately: a control an author cannot operate tells them
   * nothing about whether the question works. It is thrown away when they
   * leave, and no surface ever reads it.
   */
  const [values, setValues] = useState<Record<string, unknown>>({});

  const byId = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields]);
  const pages = useMemo(() => previewPages(structure, fields), [structure, fields]);
  const index = clampPage(at, pages.length);
  const page = pages[index];

  if (!page) {
    return (
      <div className="rounded-[14px] border border-dashed border-border bg-surface-sunken p-8 text-center">
        <Icon name="file-question" size={22} className="text-text-tertiary" />
        <p className="mx-auto mt-2.5 max-w-[46ch] text-[12.5px] leading-relaxed text-text-secondary">
          Nothing to preview yet — every section is empty. Drag fields into one on the left.
        </p>
      </div>
    );
  }

  const meta = KIND_META[page.kind];
  const sections = page.sectionKeys
    .map((key) => structure.find((s) => s.key === key))
    .filter((s): s is NonNullable<typeof s> => !!s);

  return (
    <div className="mx-auto max-w-[720px] overflow-hidden rounded-[14px] border border-border bg-surface-card shadow-md">
      <div className="h-[5px] bg-gradient-to-r from-accent-hover to-accent" />

      <div className="flex items-center gap-2.5 border-b border-border-subtle bg-surface-sunken p-[9px_14px]">
        <button
          type="button"
          onClick={() => setAt(index - 1)}
          disabled={index === 0}
          aria-label="Previous section"
          className="grid h-[26px] w-[26px] flex-none place-items-center rounded-md border border-border text-text-secondary disabled:pointer-events-none disabled:opacity-35"
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <span className="min-w-0 flex-1 text-center">
          <span className="block truncate text-[12.5px] font-semibold">{page.label}</span>
          <span className="mt-px block font-mono text-[9px] text-text-tertiary">
            Section {index + 1} of {pages.length}
          </span>
        </span>
        <button
          type="button"
          onClick={() => setAt(index + 1)}
          disabled={index >= pages.length - 1}
          aria-label="Next section"
          className="grid h-[26px] w-[26px] flex-none place-items-center rounded-md border border-border text-text-secondary disabled:pointer-events-none disabled:opacity-35"
        >
          <Icon name="chevron-right" size={14} />
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5 border-b border-border-subtle p-[9px_14px]">
        {pages.map((p, i) => (
          <button
            key={p.key}
            type="button"
            onClick={() => setAt(i)}
            title={p.label}
            aria-current={i === index ? 'true' : undefined}
            className={`max-w-full truncate rounded-full border px-2.5 py-1 text-[10px] font-semibold ${
              i === index
                ? 'border-text-primary bg-text-primary text-surface-card'
                : 'border-border bg-surface-card text-text-secondary'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {meta.note && (
        <div className="flex items-start gap-2 border-b border-border-subtle p-[10px_20px] text-[11px] leading-relaxed text-text-tertiary">
          <Icon name={meta.icon} size={13} className="mt-px flex-none" />
          {meta.note}
        </div>
      )}

      <div className="flex flex-col gap-5 p-[18px_22px_24px]">
        {sections.map((section) => {
          const rows = section.fields
            .map((entry) => ({ entry, field: byId.get(entry.id) }))
            .filter((r): r is { entry: typeof r.entry; field: FormField } => !!r.field)
            .filter((r) => !excluded?.has(r.field.id));

          return (
            <section key={section.key}>
              {sections.length > 1 && (
                <div className="mb-2 font-mono text-[9.5px] uppercase tracking-[0.08em] text-text-tertiary">
                  {section.label}
                </div>
              )}
              <div className="grid grid-cols-12 gap-4">
                {rows.map(({ entry, field }) => (
                  <div
                    key={field.id}
                    className={previewSpanClass(
                      colSpanFor(resolveSpan(entry, section.cols), section.cols),
                    )}
                  >
                    <FieldInput
                      field={{ ...field, label: previewLabel(field) }}
                      value={(values[field.id] as never) ?? null}
                      onChange={(v) => setValues((p) => ({ ...p, [field.id]: v }))}
                      // A preview never asks for the microphone and never
                      // persists an upload — the contract FieldInput documents
                      // for exactly this surface.
                      dictation={false}
                      uploadPath={null}
                    />
                  </div>
                ))}
                {rows.length === 0 && (
                  <p className="col-span-12 py-3 text-center text-[12px] text-text-tertiary">
                    Every field in this section is excluded from the digital form.
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
