/**
 * Display-level seeding for fixed-row checklist tables (repeating_group fields
 * carrying `fixedRows`). Pure module — imports from @formai/shared are
 * type-only so the node-env test runner never has to resolve the package.
 *
 * Fixed-row identity is positional: row i corresponds to fixedRows[i]; ad-hoc
 * rows appended by the filler follow after index fixedRows.length - 1.
 */
import type { FormField, RepeatingRowValue, SubmissionValue } from '@formai/shared';

/**
 * One seeded row per fixed item: the label cell (first column, KTD1) is filled
 * with the item text; checkbox cells start `false` (matching the component's
 * empty-row convention); `boolean_yes_no` cells start `null` so an explicit
 * "No" is distinguishable from "not answered yet" (KTD2); everything else is
 * an empty string. Returns [] for fields without `fixedRows`.
 */
export function seedFixedRows(field: FormField): RepeatingRowValue[] {
  if (field.type !== 'repeating_group') return [];
  const fixedRows = field.fixedRows;
  if (!fixedRows || fixedRows.length === 0) return [];
  const columns = field.columns ?? [];
  const labelKey = columns[0]?.key;
  return fixedRows.map((label) => {
    const row: RepeatingRowValue = {};
    for (const c of columns) {
      row[c.key] = c.type === 'boolean_yes_no' ? null : c.type === 'checkbox' ? false : '';
    }
    if (labelKey !== undefined) row[labelKey] = label;
    return row;
  });
}

/**
 * The seeding contract for fill surfaces: seed ONLY when the stored value is
 * undefined/null (a never-touched field). Any existing array — including an
 * empty one — is the filler's state and is returned untouched, so seeding
 * stays display-level and never masks real data. Non-array garbage degrades
 * to [] exactly as the renderer did before fixed rows existed.
 */
export function resolveRepeatingRows(
  field: FormField,
  value: SubmissionValue | undefined,
): RepeatingRowValue[] {
  if (value === null || value === undefined) return seedFixedRows(field);
  return Array.isArray(value) ? (value as RepeatingRowValue[]) : [];
}
