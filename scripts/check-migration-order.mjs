#!/usr/bin/env node
/**
 * Guards against out-of-order Drizzle migration journal timestamps.
 *
 * Drizzle's migrator (drizzle-orm/pg-core/dialect.js) selects a SINGLE row —
 * the highest `created_at` in __drizzle_migrations — once, before its apply
 * loop, then runs an entry only when that value is strictly less than the
 * entry's `folderMillis`. A journal entry whose `when` is below an
 * already-applied entry's is skipped silently: exit code 0, no error, no DDL.
 *
 * CI cannot catch that by running migrations, because CI starts from an empty
 * database where no baseline row exists and every entry applies in order
 * regardless. The failure only appears on databases with history — that is,
 * every real environment. This repo has hit it three times (0006, 0007, 0008),
 * so the check is structural rather than behavioural.
 *
 * Fails when a new entry's `when` is not strictly greater than every entry
 * before it, or when a journal entry and its .sql file disagree about
 * existence.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const drizzleDir = join(repoRoot, 'packages', 'db', 'drizzle');
const journalPath = join(drizzleDir, 'meta', '_journal.json');

/**
 * Entries that already violated the ordering rule before this guard existed.
 * They are repaired forward by 0009_repair_submitted_by_user_id, which
 * re-applies their DDL idempotently, and are deliberately NOT edited in place:
 * changing an applied migration's `when` makes Drizzle re-run it, which fails
 * on every database where the original did apply.
 *
 * Do not add to this list to silence a new failure. Regenerate the migration
 * with a real current timestamp instead.
 */
const GRANDFATHERED = new Set(['0006_plan_tiers', '0008_kind_calypso']);

if (!existsSync(journalPath)) {
  console.error(`::error::Migration journal not found at ${journalPath}`);
  process.exit(1);
}

const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
const entries = journal.entries ?? [];

if (entries.length === 0) {
  console.error('::error::Migration journal contains no entries.');
  process.exit(1);
}

const sqlFiles = new Set(
  readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).map((f) => f.replace(/\.sql$/, '')),
);

const failures = [];
const warnings = [];
let highest = { when: -Infinity, tag: '(none)' };

for (const entry of entries) {
  const { tag, when } = entry;

  if (typeof when !== 'number' || !Number.isFinite(when)) {
    failures.push(`${tag}: journal "when" is not a finite number (got ${JSON.stringify(when)}).`);
    continue;
  }

  if (!sqlFiles.has(tag)) {
    failures.push(`${tag}: journal entry has no matching ${tag}.sql in packages/db/drizzle/.`);
  }

  if (when <= highest.when) {
    const detail =
      `${tag} has when=${when}, which is not greater than ${highest.tag} (when=${highest.when}). ` +
      `Drizzle will skip ${tag} on any database that already applied ${highest.tag}.`;
    if (GRANDFATHERED.has(tag)) {
      warnings.push(`${detail} Known and repaired forward by 0009_repair_submitted_by_user_id.`);
    } else {
      failures.push(detail);
    }
  }

  if (when > highest.when) highest = { when, tag };
}

for (const tag of sqlFiles) {
  if (!entries.some((e) => e.tag === tag)) {
    failures.push(`${tag}.sql exists but has no entry in meta/_journal.json — it will never run.`);
  }
}

for (const warning of warnings) {
  console.log(`known-issue: ${warning}`);
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`::error::${failure}`);
  }
  console.error(
    '\nA migration must carry a real current epoch-ms "when" value, greater than every ' +
      'entry before it. Never copy or increment a neighbour\'s timestamp — if that ' +
      'neighbour is stale, the new entry inherits the bug. Regenerate with ' +
      '`pnpm db:generate` (or `drizzle-kit generate --custom`), which stamps Date.now().',
  );
  process.exit(1);
}

console.log(
  `Migration journal OK — ${entries.length} entries, timestamps strictly increasing` +
    `${warnings.length > 0 ? ` (${warnings.length} grandfathered)` : ''}.`,
);
