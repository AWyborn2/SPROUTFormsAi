/**
 * Visibility-condition authoring, mounted inside the field inspector.
 *
 * Conditions belong where every other field setting is configured: an author
 * who has just retyped a field and set its options should not leave the panel
 * to say "…and only show it for Depot A". The panel is deliberately small —
 * source, operator, value — because the shared evaluator (`visibility.ts`) is
 * the only place the semantics live. Nothing here re-decides what "visible"
 * means; it only writes a `VisibilityCondition`.
 *
 * Two restrictions on the SOURCE list are load-bearing rather than cosmetic.
 *
 * 1. EARLIER-ONLY. A field may only key off something answered before it.
 *    Offering a later field authors a form whose section vanishes based on an
 *    answer the filler has not reached.
 * 2. NON-REPEATING (R20). A repeating group has an array of rows, not one
 *    scalar answer, so a comparison against it is meaningless — the evaluator
 *    already treats that as unevaluatable and fails OPEN, which would look to
 *    the author like a condition that silently does nothing. Excluding it at
 *    authoring time is what keeps evaluation free of row state, and free of
 *    any path that could loop. Section headers are excluded for the same
 *    reason: they hold no answer at all.
 *
 * On a `section_header` the authored condition governs the whole section (the
 * expansion happens in `visibleFields`). That is the difference between one
 * condition and dozens across an 18-page assessment, so the panel states it in
 * words and names the fields in range — and the canvas marks them, so "what did
 * I just scope?" is answerable by looking rather than by counting headers.
 */
import type { FormField, VisibilityCondition, VisibilityOperator } from '@formai/shared';
import { Select } from '@formai/ui';

/**
 * The properties this panel needs. Taken structurally, like `ColumnInspector`'s
 * — a review row carries extraction metadata a published field does not, so
 * requiring either concrete type would lock one of the two hosts out.
 */
export type ConditionField = Pick<FormField, 'id' | 'type' | 'label' | 'options' | 'visibleWhen'>;

/**
 * The single edit this panel performs, supplied by whoever mounts it.
 *
 * Import review dispatches through the import session; the builder through its
 * own reducer. Taking the write as a contract is what lets ONE panel serve both
 * hosts, exactly as `ColumnActions` does for table columns.
 */
export interface ConditionActions {
  /** Set (or, with null, clear) the field's condition. */
  setCondition(fieldId: string, condition: VisibilityCondition | null): void;
}

/**
 * Types whose answer cannot serve as a condition source. Mirrors `visibility.ts`.
 *
 * `checkbox_group` is here because its answer is an ARRAY, which the evaluator
 * classifies as non-scalar and fails open on — so a condition keyed off one is
 * always true. Offering it authored a silent no-op: the author sets up a rule,
 * sees no error, and the field is simply always visible.
 */
const NON_SOURCE_TYPES: ReadonlySet<FormField['type']> = new Set([
  'repeating_group',
  'section_header',
  'checkbox_group',
]);

const OPERATOR_OPTIONS: Array<{ label: string; value: VisibilityOperator }> = [
  { label: 'is', value: 'equals' },
  { label: 'is not', value: 'notEquals' },
];

/**
 * The fields that may be a condition source for `fieldId`: strictly earlier in
 * the form, answerable with a single scalar, and never the field itself.
 * Exported (and unit-tested) because it is the rule, not the rendering.
 */
export function conditionSources(
  fields: readonly ConditionField[],
  fieldId: string,
): ConditionField[] {
  const index = fields.findIndex((f) => f.id === fieldId);
  // An unknown field has no established position, so nothing is safely "earlier".
  if (index < 0) return [];
  return fields.slice(0, index).filter((f) => !NON_SOURCE_TYPES.has(f.type));
}

/**
 * The values a source field can actually hold, or null when its answers cannot
 * be enumerated (free text, numbers, dates) and the author must type one.
 * A `Location` dropdown offering its real choices is what stops a condition
 * being keyed off a typo that can never match.
 */
export function sourceValueOptions(field: ConditionField): string[] | null {
  if (field.options && field.options.length > 0) return field.options;
  // The evaluator normalizes a boolean answer to these exact strings.
  if (field.type === 'checkbox' || field.type === 'boolean_yes_no') return ['true', 'false'];
  return null;
}

/**
 * The fields a condition on `headerId` governs: everything from that header up
 * to the next one (or the end of the form), matching `visibleFields`. Empty for
 * anything that is not a section header — a plain field governs only itself.
 *
 * It is derived from the CURRENT field order every time, never stored, so
 * moving a field out of a section stops it inheriting the section's condition
 * and deleting the header releases the scope entirely.
 */
export function governedFieldIds(
  fields: readonly ConditionField[],
  headerId: string,
): string[] {
  const index = fields.findIndex((f) => f.id === headerId);
  if (index < 0 || fields[index]!.type !== 'section_header') return [];

  const out: string[] = [];
  for (const f of fields.slice(index + 1)) {
    if (f.type === 'section_header') break;
    out.push(f.id);
  }
  return out;
}

export interface ConditionEditorProps {
  /** The field being configured. */
  field: ConditionField;
  /** The whole form, in authored order — the source list is derived from it. */
  fields: readonly ConditionField[];
  actions: ConditionActions;
}

export function ConditionEditor({ field, fields, actions }: ConditionEditorProps) {
  const sources = conditionSources(fields, field.id);
  const condition = field.visibleWhen;
  const source = condition ? fields.find((f) => f.id === condition.fieldId) : undefined;
  const values = source ? sourceValueOptions(source) : null;
  const isSection = field.type === 'section_header';
  const governed = isSection ? governedFieldIds(fields, field.id) : [];

  /** Point the condition at a new source, seeding a value it can actually match. */
  function pickSource(sourceId: string) {
    if (!sourceId) {
      actions.setCondition(field.id, null);
      return;
    }
    const next = fields.find((f) => f.id === sourceId);
    const options = next ? sourceValueOptions(next) : null;
    actions.setCondition(field.id, {
      fieldId: sourceId,
      op: condition?.op ?? 'equals',
      // Keep the typed value when re-pointing between two free-text sources;
      // an enumerated source starts on a choice that exists.
      value: options ? (options.includes(condition?.value ?? '') ? condition!.value : options[0]!) : (condition?.value ?? ''),
    });
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
      <div>
        <div className="text-[12.5px] font-semibold">Show this {isSection ? 'section' : 'field'}</div>
        <p className="mt-0.5 text-[11px] text-text-tertiary">
          {isSection
            ? 'This condition governs the whole section — every field below this header, up to the next one.'
            : 'Always shown unless you pick a question it depends on.'}
        </p>
      </div>

      {sources.length === 0 ? (
        <p className="rounded-md border border-border-subtle bg-surface-sunken p-[9px_10px] text-[11px] text-text-tertiary">
          Nothing earlier in the form can be used as a condition. A field can only depend on a
          single-answer question that comes before it.
        </p>
      ) : (
        <>
          <Select
            label="Depends on"
            options={[
              { label: 'Always show', value: '' },
              ...sources.map((f) => ({ label: f.label, value: f.id })),
            ]}
            value={condition?.fieldId ?? ''}
            onChange={(e) => pickSource(e.target.value)}
            aria-label={`Condition source: ${field.label}`}
          />

          {condition && (
            <div className="flex flex-col gap-2 rounded-md border border-border-subtle bg-surface-sunken p-[9px_10px]">
              <div className="w-[110px]">
                <Select
                  options={OPERATOR_OPTIONS}
                  value={condition.op}
                  onChange={(e) =>
                    actions.setCondition(field.id, {
                      ...condition,
                      op: e.target.value as VisibilityOperator,
                    })
                  }
                  aria-label={`Condition operator: ${field.label}`}
                />
              </div>

              {values ? (
                <Select
                  options={values.map((v) => ({ label: v, value: v }))}
                  value={condition.value}
                  onChange={(e) => actions.setCondition(field.id, { ...condition, value: e.target.value })}
                  aria-label={`Condition value: ${field.label}`}
                />
              ) : (
                <input
                  value={condition.value}
                  onChange={(e) => actions.setCondition(field.id, { ...condition, value: e.target.value })}
                  aria-label={`Condition value: ${field.label}`}
                  placeholder="Answer to match"
                  className="h-7 w-full min-w-0 rounded-sm border border-border bg-surface-card px-2 text-[12.5px] text-text-primary focus-visible:shadow-focus"
                />
              )}

              {isSection && (
                <p className="text-[11px] text-text-secondary">
                  {governed.length === 0
                    ? 'This section is empty — the condition will apply to any field added below it.'
                    : `Governs ${governed.length} field${governed.length === 1 ? '' : 's'} in this section.`}
                </p>
              )}

              <button
                onClick={() => actions.setCondition(field.id, null)}
                className="self-start rounded-sm border border-border bg-surface-card px-2 py-1 text-[11.5px] font-semibold text-text-secondary hover:bg-surface-hover"
              >
                Clear condition
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
