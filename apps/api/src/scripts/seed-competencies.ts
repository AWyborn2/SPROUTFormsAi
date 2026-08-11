/**
 * Seed one organisation's competency register from a reviewed CSV list.
 *
 *   pnpm --filter @formai/api seed:competencies -- --org <uuid> --file list.csv
 *   pnpm --filter @formai/api seed:competencies -- --org <uuid> --file list.csv --dry-run
 *
 * The file is `name,code,valid_for_months` with a header line; a BLANK
 * `valid_for_months` means the qualification NEVER EXPIRES and is stored as
 * NULL, not zero. Re-running is safe: a name already in the org's register is
 * skipped and reported, never updated.
 *
 * This exists because a customer migration needs ~65 competencies to exist
 * before a competency import can resolve against them, and the import
 * deliberately does not mint taxonomy (R169). Creating the register is a
 * separate, deliberate act — this is it, done once, from a list a human
 * reviewed.
 */
import { readFile } from 'node:fs/promises';
import { db } from '../db.js';
import {
  formatCompetencySeedReport,
  parseCompetencySeedCsv,
  seedCompetencies,
} from '../lib/competency-seed.js';

function flag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const orgId = flag('org');
  const file = flag('file');
  const dryRun = process.argv.includes('--dry-run');

  if (!db) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }
  // Named explicitly, every run. There is no default org and no fallback to
  // "the only one" — seeding 65 rows into the wrong customer is not something a
  // convenience default should be able to do.
  if (!orgId) {
    console.error('--org <uuid> is required.');
    process.exit(1);
  }
  if (!file) {
    console.error('--file <path to name,code,valid_for_months csv> is required.');
    process.exit(1);
  }

  const { rows, errors } = parseCompetencySeedCsv(await readFile(file, 'utf8'));
  for (const e of errors) console.error(`  ! line ${e.rowNumber}: ${e.error}`);
  if (rows.length === 0) {
    console.error('Nothing to seed.');
    process.exit(1);
  }

  const report = await seedCompetencies(db, { orgId, rows, dryRun });
  console.log(formatCompetencySeedReport(report));

  // A non-zero exit when anything failed, so an operator cannot mistake a
  // partial run for a clean one.
  if (report.failed.length > 0 || errors.length > 0) process.exit(1);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
