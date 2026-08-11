import { eq } from 'drizzle-orm';
import { schema } from '@formai/db';
import type { db as dbType } from '../db.js';
import {
  competencyIdsByLowercaseName,
  createCompetency,
  createCompetencyBody,
  type CreateCompetencyInput,
} from './competency-create.js';

type Database = NonNullable<typeof dbType>;

/**
 * Bulk-create competencies in ONE organisation from a reviewed list.
 *
 * WHY THIS EXISTS AND WHAT IT IS NOT. A workforce import resolves each
 * competency line against the org's register and rejects what it cannot find —
 * it does not mint taxonomy (R169), and that stays true. This is the other
 * half: the register itself, loaded once from a list a human already reviewed
 * and de-duplicated, so that the import has something to resolve against. It is
 * a migration tool for a one-time cutover, not a product feature, and it writes
 * through the same validation the API route uses so it cannot create rows the
 * API would have refused.
 */

/** One line of the reviewed list, before validation. */
export interface CompetencySeedRow {
  /** 1-based line number in the source file, so a failure points at a row. */
  rowNumber: number;
  name: string;
  code: string;
  /**
   * BLANK MEANS NEVER EXPIRES. Carried as `null`, never `0` — zero months would
   * expire the qualification the instant it is granted, which is the opposite
   * of what an empty cell means and would silently lapse everyone holding it.
   */
  validForMonths: number | null;
}

export interface CompetencySeedReport {
  created: { name: string; code: string; validForMonths: number | null }[];
  /** Already in the register under this name — left exactly as it was. */
  skipped: { name: string; existingCode: string; reason: 'already_exists' | 'duplicate_in_file' }[];
  failed: { rowNumber: number; name: string; error: string }[];
  dryRun: boolean;
}

/** Split one CSV line into fields, honouring double-quoted fields that contain commas. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields.map((f) => f.trim());
}

/**
 * Read the reviewed list. Columns are read BY NAME from the header line
 * (`name,code,valid_for_months`) rather than by position, so a file a
 * spreadsheet reordered still loads.
 *
 * A row whose `valid_for_months` cell is empty gets `null` — never expires. A
 * cell that is present but not a positive whole number is left as-is for
 * validation to reject by row, rather than being coerced into a wrong number.
 */
export function parseCompetencySeedCsv(text: string): {
  rows: CompetencySeedRow[];
  errors: { rowNumber: number; error: string }[];
} {
  const rows: CompetencySeedRow[] = [];
  const errors: { rowNumber: number; error: string }[] = [];
  const lines = text.split(/\r?\n/);
  let columns: Record<string, number> | null = null;

  lines.forEach((raw, index) => {
    const rowNumber = index + 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const fields = splitCsvLine(raw);

    if (!columns) {
      const header: Record<string, number> = {};
      fields.forEach((name, i) => {
        header[name.toLowerCase()] = i;
      });
      if (header.name === undefined || header.code === undefined) {
        errors.push({ rowNumber, error: 'header must name at least `name` and `code` columns' });
        // Nothing after this can be read positionally with any confidence.
        columns = header;
        return;
      }
      columns = header;
      return;
    }

    const cols = columns as Record<string, number>;
    const at = (key: string) => {
      const i = cols[key];
      return i === undefined ? '' : (fields[i] ?? '').trim();
    };
    const name = at('name');
    const code = at('code');
    const validityCell = at('valid_for_months');

    let validForMonths: number | null = null;
    if (validityCell !== '') {
      const parsed = Number(validityCell);
      if (!Number.isFinite(parsed)) {
        errors.push({ rowNumber, error: `valid_for_months "${validityCell}" is not a number` });
        return;
      }
      validForMonths = parsed;
    }

    rows.push({ rowNumber, name, code, validForMonths });
  });

  if (!columns) errors.push({ rowNumber: 0, error: 'file is empty — expected a header line' });
  return { rows, errors };
}

/**
 * Seed one org's competency register.
 *
 * IDEMPOTENT BY NAME, case-insensitively. An existing name is SKIPPED and
 * reported, never updated: someone may have already curated its code, validity
 * or grace period, and a re-run silently overwriting that is a worse failure
 * than a duplicate. The fold is `name.trim().toLowerCase()` because that is
 * exactly how the workforce import looks a competency up.
 *
 * ORG-SCOPED BY CONSTRUCTION. `orgId` is a required argument, the organisation
 * must exist, and every row is written with it — there is no ambient tenant and
 * no default, so a run cannot land in the wrong org by omission.
 */
export async function seedCompetencies(
  database: Database,
  options: { orgId: string; rows: CompetencySeedRow[]; dryRun?: boolean },
): Promise<CompetencySeedReport> {
  const orgId = options.orgId?.trim();
  if (!orgId) throw new Error('org_required: seedCompetencies needs an explicit organisation id');

  const org = await database.query.organizations.findFirst({
    where: eq(schema.organizations.id, orgId),
  });
  if (!org) throw new Error(`org_not_found: no organisation ${orgId}`);

  const dryRun = options.dryRun ?? false;
  const report: CompetencySeedReport = { created: [], skipped: [], failed: [], dryRun };

  // One read of the register, not one per row: a name is matched against what
  // is already there plus whatever this run has created, so a list containing
  // the same name twice creates it once.
  const existing = await competencyIdsByLowercaseName(database, orgId);
  const claimed = new Set<string>();

  for (const row of options.rows) {
    const key = row.name.trim().toLowerCase();
    if (key !== '') {
      const already = existing.get(key);
      if (already) {
        report.skipped.push({
          name: row.name,
          existingCode: already.code,
          reason: 'already_exists',
        });
        continue;
      }
      if (claimed.has(key)) {
        report.skipped.push({ name: row.name, existingCode: row.code, reason: 'duplicate_in_file' });
        continue;
      }
    }

    // The SAME validation the API route applies. A row the route would reject
    // is a row this must reject too, reported rather than written.
    const parsed = createCompetencyBody.safeParse({
      name: row.name,
      code: row.code,
      validForMonths: row.validForMonths,
    } satisfies Partial<CreateCompetencyInput>);
    if (!parsed.success) {
      const detail = parsed.error.errors
        .map((e) => `${e.path.join('.') || 'row'}: ${e.message}`)
        .join('; ');
      report.failed.push({ rowNumber: row.rowNumber, name: row.name, error: detail });
      continue;
    }

    if (!dryRun) {
      try {
        await createCompetency(database, orgId, parsed.data);
      } catch (err) {
        report.failed.push({
          rowNumber: row.rowNumber,
          name: row.name,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }
    claimed.add(key);
    report.created.push({
      name: parsed.data.name,
      code: parsed.data.code,
      validForMonths: parsed.data.validForMonths ?? null,
    });
  }

  return report;
}

/** The human-readable run report — created / skipped / failed, by name. */
export function formatCompetencySeedReport(report: CompetencySeedReport): string {
  const prefix = report.dryRun ? '[dry-run] would create' : 'Created';
  const lines: string[] = [];

  lines.push(`${prefix} ${report.created.length} competencies:`);
  for (const c of report.created) {
    const validity = c.validForMonths === null ? 'never expires' : `${c.validForMonths} months`;
    lines.push(`  + ${c.name} (${c.code}) — ${validity}`);
  }

  lines.push(`Skipped ${report.skipped.length} already present:`);
  for (const s of report.skipped) {
    const why = s.reason === 'duplicate_in_file' ? 'repeated in file' : `already exists as ${s.existingCode}`;
    lines.push(`  = ${s.name} — ${why}, left unchanged`);
  }

  lines.push(`Failed ${report.failed.length}:`);
  for (const f of report.failed) {
    lines.push(`  ! row ${f.rowNumber} ${f.name || '(no name)'} — ${f.error}`);
  }

  return lines.join('\n');
}
