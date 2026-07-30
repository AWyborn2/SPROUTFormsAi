import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Icon, useToast } from '@formai/ui';
import { geometrySegments, isChoiceField, type FormField, type PageBox } from '@formai/shared';
import { useFormVersion, usePublishFormVersion, useSaveVersionFields } from '../../lib/data/hooks.js';
import type { TextPage } from '../../lib/pdf-geometry.js';
import { markSentence } from '../../lib/mark-description.js';
import { PdfViewer } from './PdfViewer.js';
import {
  deriveAcrossPages,
  deriveOptionCellsAcrossPages,
} from './inspector/geometry-actions.js';

/**
 * Placing field geometry on an EXISTING form, without re-importing it.
 *
 * Why this screen exists at all: geometry could previously only be drawn during
 * import review, and re-importing re-extracts, which re-assigns every field id.
 * An assessment tool's manifest, answer keys and outcome targets are all keyed
 * to those ids, so re-importing a form to fix its placement silently invalidated
 * the tool built on it. Forking the published version into a draft keeps every
 * id; only the placement changes.
 *
 * It edits a DRAFT and never a published version. Submissions pin to a version,
 * so rewriting one rewrites what already-signed records render against — the API
 * refuses it, and this screen does not offer it.
 *
 * Two gates before anything is persisted: an automatic proposal has to be
 * APPLIED, and the draft has to be SAVED. A proposal a reviewer never looked at
 * would otherwise put marks on a competency record against boxes nobody checked.
 */
export function GeometryEditorScreen() {
  const { id: formId, versionId } = useParams<{ id: string; versionId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: version, isLoading } = useFormVersion(formId, versionId);
  const save = useSaveVersionFields(formId ?? '', versionId ?? '');
  const publish = usePublishFormVersion();

  /**
   * The working copy. Seeded from the fetched version and then owned here —
   * every draw and every applied proposal lands in this array, and nothing
   * reaches the server until Save.
   */
  const [edited, setEdited] = useState<FormField[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [textPages, setTextPages] = useState<readonly TextPage[]>([]);
  /** Which box the next drag fills, or null when drawing is not armed. */
  const [drawTarget, setDrawTarget] = useState<DrawTarget | null>(null);
  const [dirty, setDirty] = useState(false);

  const fields = edited ?? version?.fields ?? [];
  const selected = fields.find((f) => f.id === selectedId) ?? null;

  const onTextLayer = useCallback((pages: TextPage[]) => setTextPages(pages), []);

  function mutate(fieldId: string, change: (f: FormField) => FormField) {
    setEdited(fields.map((f) => (f.id === fieldId ? change(f) : f)));
    setDirty(true);
  }

  /** Replace one option's box, keyed by `optionKey`, leaving siblings alone. */
  function setOptionBox(fieldId: string, optionKey: string, box: PageBox | null) {
    mutate(fieldId, (f) => {
      const kept = (f.geometry?.segments ?? []).filter((s) => s.optionKey !== optionKey);
      const next = box ? [...kept, { ...box, optionKey }] : kept;
      return next.length > 0 ? { ...f, geometry: { segments: next } } : stripGeometry(f);
    });
  }

  function setScalarBox(fieldId: string, box: PageBox | null) {
    mutate(fieldId, (f) => (box ? { ...f, geometry: { segments: [box] } } : stripGeometry(f)));
  }

  if (isLoading) {
    return <div className="p-[30px_28px] text-sm text-text-tertiary">Loading version…</div>;
  }

  if (!version) {
    return (
      <div className="fai-rise mx-auto max-w-[720px] p-[30px_28px_60px] text-center">
        <Icon name="file-question" size={30} className="text-text-tertiary" />
        <h1 className="mt-3 font-heading text-lg font-semibold">This version isn't available</h1>
        <Button variant="outline" className="mt-3" onClick={() => navigate('/app/forms')}>
          Back to forms
        </Button>
      </div>
    );
  }

  // A published version is frozen. Say so rather than presenting controls whose
  // every save would 409.
  if (version.state === 'published') {
    return (
      <div className="fai-rise mx-auto max-w-[720px] p-[30px_28px_60px]">
        <h1 className="font-heading text-xl font-semibold">{version.label} is published</h1>
        <p className="mt-2 text-[13.5px] text-text-secondary">
          A published version is frozen — submissions pin to it, so changing its fields would change
          what already-recorded results render against. Fork a draft from the form's version list and
          place geometry on that instead; publishing it keeps every field id, so any assessment tool
          built on this form stays valid.
        </p>
        <Button variant="outline" className="mt-4" onClick={() => navigate(`/app/forms`)}>
          Back to forms
        </Button>
      </div>
    );
  }

  if (!version.sourcePdfAssetId) {
    return (
      <div className="fai-rise mx-auto max-w-[720px] p-[30px_28px_60px]">
        <h1 className="font-heading text-xl font-semibold">No original PDF</h1>
        <p className="mt-2 text-[13.5px] text-text-secondary">
          Geometry describes where an answer sits on the original document, so there is nothing to
          place boxes against on a form that was built rather than imported.
        </p>
      </div>
    );
  }

  /**
   * Every box on every field, so a reviewer can see what they have already
   * placed instead of only the field they happen to have selected.
   *
   * Saved geometry is shown as confirmed: it is already persisted, or staged for
   * the next Save, and either way a human put it there.
   */
  const placements = fields.flatMap((f) =>
    geometrySegments(f).map((box, i) => ({
      slot: `${f.id}#${box.optionKey ?? i}`,
      box,
      confirmed: true,
      active: f.id === selectedId,
    })),
  );

  const placedCount = fields.filter((f) => geometrySegments(f).length > 0).length;
  const placeable = fields.filter((f) => f.type !== 'section_header');

  return (
    <div className="fai-rise flex h-[calc(100vh-56px)] flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-[22px] py-3">
        <div className="min-w-0">
          <h1 className="truncate font-heading text-[16px] font-bold">Placement · {version.label}</h1>
          <p className="text-[12.5px] text-text-secondary">
            {placedCount} of {placeable.length} answerable fields placed
            {dirty && <span className="ml-2 text-warning-text">· unsaved changes</span>}
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Button
            variant="outline"
            leadingIcon="save"
            disabled={!dirty || save.isPending}
            onClick={() =>
              save.mutate(fields, {
                onSuccess: () => {
                  setDirty(false);
                  toast({ variant: 'success', message: 'Placement saved to the draft.' });
                },
                onError: () => toast({ variant: 'danger', message: "Couldn't save — try again." }),
              })
            }
          >
            {save.isPending ? 'Saving…' : 'Save draft'}
          </Button>
          <Button
            leadingIcon="upload"
            disabled={dirty || publish.isPending}
            title={dirty ? 'Save the draft first' : undefined}
            onClick={() => {
              if (!formId || !versionId) return;
              publish.mutate(
                { formId, versionId },
                {
                  onSuccess: () => {
                    toast({ variant: 'success', message: `${version.label} published.` });
                    navigate('/app/forms');
                  },
                  onError: () => toast({ variant: 'danger', message: "Couldn't publish — try again." }),
                },
              );
            }}
          >
            Publish version
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-[340px] shrink-0 overflow-y-auto border-r border-border">
          {placeable.map((f) => (
            <FieldRow
              key={f.id}
              field={f}
              selected={f.id === selectedId}
              onSelect={() => {
                setSelectedId(f.id);
                setDrawTarget(null);
              }}
            />
          ))}
        </aside>

        <div className="min-w-0 flex-1">
          <PdfViewer
            assetId={version.sourcePdfAssetId}
            selectedFieldId={selectedId}
            onSelectField={setSelectedId}
            onTextLayer={onTextLayer}
            placements={placements}
            drawArmed={drawTarget !== null}
            onDrawBox={(box) => {
              if (!drawTarget) return;
              const { fieldId, optionKey } = drawTarget;
              if (optionKey === null) setScalarBox(fieldId, box);
              else setOptionBox(fieldId, optionKey, box);
              setDrawTarget(null);
            }}
            className="h-full"
          />
        </div>

        <aside className="w-[320px] shrink-0 overflow-y-auto border-l border-border p-[14px_16px]">
          {selected ? (
            <PlacementPanel
              field={selected}
              textPages={textPages}
              drawTarget={drawTarget}
              onToggleDraw={(target) =>
                setDrawTarget((cur) => (sameTarget(cur, target) ? null : target))
              }
              onSetOptionBox={(optionKey, box) => setOptionBox(selected.id, optionKey, box)}
              onSetScalarBox={(box) => setScalarBox(selected.id, box)}
            />
          ) : (
            <p className="text-[12.5px] text-text-tertiary">
              Pick a field on the left, then draw its box on the page — or let the page propose one.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Removing geometry entirely rather than leaving an empty segment list. */
function stripGeometry(field: FormField): FormField {
  const { geometry: _drop, ...rest } = field;
  return rest;
}

/**
 * Which box the next drag fills: a field's own, or one option's.
 *
 * A STRUCTURED pair rather than a joined string. The import session encodes
 * the same thing as `fieldId + separator + optionKey`, which only holds while
 * the separator cannot occur in either half — and option values here are prose
 * ("All the above"), so any visible separator risks parsing a multi-word option
 * as a different slot and dropping the box on the wrong option. Two fields
 * cannot be mis-split.
 */
interface DrawTarget {
  fieldId: string;
  /** Null for a scalar field, which has one box for the field as a whole. */
  optionKey: string | null;
}

function sameTarget(a: DrawTarget | null, b: DrawTarget): boolean {
  return a !== null && a.fieldId === b.fieldId && a.optionKey === b.optionKey;
}

function FieldRow({
  field,
  selected,
  onSelect,
}: {
  field: FormField;
  selected: boolean;
  onSelect: () => void;
}) {
  const placed = geometrySegments(field).length;
  const wanted = expectedBoxes(field);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-2 border-b border-border-subtle px-[14px] py-2 text-left ${
        selected ? 'bg-[var(--accent-soft)]' : 'hover:bg-surface-hover'
      }`}
    >
      <Icon
        name={placed >= wanted ? 'circle-check' : 'square-dashed'}
        size={14}
        className={placed >= wanted ? 'flex-none text-success-text' : 'flex-none text-text-tertiary'}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-semibold">{field.label || field.id}</span>
        <span className="block text-[11px] text-text-tertiary">
          {field.type} · {placed}/{wanted} placed
        </span>
      </span>
    </button>
  );
}

/** How many boxes this field needs: one per option for a ticking choice field. */
function expectedBoxes(field: FormField): number {
  return isChoiceField(field.type) && !field.printSelectedValue && (field.options?.length ?? 0) > 0
    ? field.options!.length
    : 1;
}

function PlacementPanel({
  field,
  textPages,
  drawTarget,
  onToggleDraw,
  onSetOptionBox,
  onSetScalarBox,
}: {
  field: FormField;
  textPages: readonly TextPage[];
  drawTarget: DrawTarget | null;
  onToggleDraw: (target: DrawTarget) => void;
  onSetOptionBox: (optionKey: string, box: PageBox | null) => void;
  onSetScalarBox: (box: PageBox | null) => void;
}) {
  const perOption =
    isChoiceField(field.type) && !field.printSelectedValue && (field.options?.length ?? 0) > 0;

  /**
   * The automatic proposal, if the page settles one.
   *
   * Recomputed from the field and the text layer rather than cached across
   * selections — the derivation scans every page, but a reviewer changes field
   * far less often than this component re-renders.
   */
  const proposal = useMemo(() => {
    if (textPages.length === 0) return null;
    if (perOption) return deriveOptionCellsAcrossPages(field as { label: string; options?: string[] }, textPages);
    return null;
  }, [field, textPages, perOption]);

  const tableProposal = useMemo(() => {
    if (textPages.length === 0 || field.type !== 'repeating_group') return null;
    return deriveAcrossPages(field, textPages);
  }, [field, textPages]);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-[12.5px] font-bold">{field.label || field.id}</div>
        <div className="text-[11px] text-text-tertiary">{field.type}</div>
      </div>

      {proposal && (
        <div className="rounded-sm border border-border-subtle bg-surface-sunken p-[9px_10px]">
          <p className="text-[11.5px] leading-snug text-text-secondary">
            Found this field on page {(proposal.segments[0]?.page ?? 0) + 1} with{' '}
            {proposal.segments.length} box(es).
            {proposal.confidence < 1 && ' Check it against the page before saving.'}
          </p>
          {proposal.notes.map((note) => (
            <p key={note} className="mt-1 text-[11px] leading-snug text-text-tertiary">
              {note}
            </p>
          ))}
          <Button
            variant="outline"
            leadingIcon="wand-sparkles"
            className="mt-1.5 w-full justify-center"
            onClick={() => {
              for (const segment of proposal.segments) {
                if (segment.optionKey === undefined) continue;
                onSetOptionBox(segment.optionKey, segment);
              }
            }}
          >
            Place all {proposal.segments.length}
          </Button>
        </div>
      )}

      {tableProposal && (
        <div className="rounded-sm border border-border-subtle bg-surface-sunken p-[9px_10px]">
          <p className="text-[11.5px] leading-snug text-text-secondary">
            A grid was detected on page {tableProposal.segment.page + 1}.
          </p>
          <Button
            variant="outline"
            leadingIcon="wand-sparkles"
            className="mt-1.5 w-full justify-center"
            onClick={() => onSetScalarBox(tableProposal.segment)}
          >
            Place this grid
          </Button>
        </div>
      )}

      {perOption ? (
        <div className="flex flex-col gap-1.5">
          {field.options!.map((option) => {
            const target: DrawTarget = { fieldId: field.id, optionKey: option };
            const box = (field.geometry?.segments ?? []).find((s) => s.optionKey === option);
            return (
              <BoxRow
                key={option}
                label={option}
                box={box}
                armed={sameTarget(drawTarget, target)}
                onToggleDraw={() => onToggleDraw(target)}
                onClear={() => onSetOptionBox(option, null)}
              />
            );
          })}
        </div>
      ) : (
        <BoxRow
          label="Answer box"
          box={field.geometry?.segments?.[0]}
          armed={sameTarget(drawTarget, { fieldId: field.id, optionKey: null })}
          onToggleDraw={() => onToggleDraw({ fieldId: field.id, optionKey: null })}
          onClear={() => onSetScalarBox(null)}
        />
      )}

      <p className="text-[11px] leading-snug text-text-tertiary">{markSentence(field)}</p>

      <p className="text-[11px] leading-snug text-text-tertiary">
        A field with no box exports as recorded data instead of a mark on the page — visibly
        incomplete, which is the safe way to be wrong.
      </p>
    </div>
  );
}

function BoxRow({
  label,
  box,
  armed,
  onToggleDraw,
  onClear,
}: {
  label: string;
  box: PageBox | undefined;
  armed: boolean;
  onToggleDraw: () => void;
  onClear: () => void;
}) {
  return (
    <div className="rounded-sm border border-border-subtle bg-surface-sunken p-[8px_9px]">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{label}</span>
        {box && (
          <span className="text-[10.5px] font-semibold text-success-text">p{box.page + 1}</span>
        )}
      </div>
      <div className="flex gap-1.5">
        <Button
          variant={armed ? 'primary' : 'outline'}
          leadingIcon="square-dashed"
          className="flex-1 justify-center"
          onClick={onToggleDraw}
        >
          {armed ? 'Drawing…' : box ? 'Redraw' : 'Draw'}
        </Button>
        {box && (
          <Button variant="outline" leadingIcon="trash-2" onClick={onClear}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}
