/**
 * Reading and reconciling drizzle's migration ledger.
 *
 * FormAI runs two databases. The Replit workspace's ambient `DATABASE_URL`
 * points at DEV (`heliumdb`); the published app runs against PRODUCTION
 * (`neondb`). `scripts/post-merge.sh` runs `pnpm db:migrate` on every merge, so
 * dev has been migrated by this repo for months and production never has been.
 * Production's SCHEMA nevertheless reached parity, because Replit's own agent
 * tooling pushes schema directly, outside the repo — and a schema push writes no
 * ledger rows and, crucially, RUNS NO DML.
 *
 * The result is a database whose ledger says 24 and whose schema is current
 * through 0054, with one data-only migration (`0042_seed_profiles_category.sql`)
 * that never ran and cannot run, because `drizzle-kit migrate` refuses to start:
 * it re-applies from the ledger's high-water mark and dies on
 * `column "assessor_stream_competency_ids" already exists`.
 *
 * Everything in this module is pure: it takes migration files and ledger rows
 * and returns a report. The scripts in `./scripts/` supply the I/O.
 */
import { createHash } from 'node:crypto';

/** One entry of `drizzle/meta/_journal.json`. */
export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
  breakpoints: boolean;
}

/** One row of `drizzle.__drizzle_migrations`. */
export interface LedgerRow {
  /** `hash text NOT NULL` — sha256 hex of the migration file's contents. */
  hash: string;
  /** `created_at bigint` — the journal entry's `when`, verbatim. Never a clock reading. */
  createdAt: number;
}

/** A migration file paired with its journal entry and everything derived from it. */
export interface MigrationFile {
  tag: string;
  idx: number;
  when: number;
  /**
   * sha256 of the file exactly as it sits on disk. This is what
   * `drizzle-orm`'s `readMigrationFiles` computes, so it is what a
   * `drizzle-kit migrate` run FROM THIS CHECKOUT would record.
   */
  hash: string;
  /**
   * sha256 of the file with CRLF normalised to LF — the hash a checkout with
   * Unix line endings produces. On Windows, `core.autocrlf=true` rewrites
   * these files on checkout, so `hash` and `canonicalHash` differ for every
   * migration while the git blob, and therefore every Linux checkout, is LF.
   * Distinguishing the two is what stops a Windows operator reading a whole
   * repository of line-ending noise as a divergent history.
   */
  canonicalHash: string;
  /** True when the on-disk bytes are not already LF-only. */
  hasCrlf: boolean;
  /** True when the file performs INSERT/UPDATE/DELETE — see {@link containsDml}. */
  hasDml: boolean;
}

/**
 * Strip SQL comments so a comment mentioning `INSERT` is not mistaken for one.
 * Almost every migration in this repo carries a long rationale header, so this
 * is not a nicety.
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/**
 * Does this migration write DATA, as opposed to changing structure?
 *
 * This is the distinction the whole incident turns on. A schema sync — Replit's
 * agent tooling, `drizzle-kit push`, a hand-run DDL script — reproduces
 * structure and skips DML entirely. So a DML migration missing from the ledger
 * has genuinely NOT run, no matter how current the schema looks, and baselining
 * it away silently keeps it from ever running.
 *
 * Deliberately conservative: it would rather flag a migration that only
 * mentions DML than wave one through. A false positive costs an operator an
 * explicit override; a false negative costs a silent data gap, which is what
 * `0042` already cost.
 *
 * `ON DELETE CASCADE` / `ON UPDATE NO ACTION` appear in nearly every DDL
 * migration here, so `UPDATE` alone cannot be the signal — a real update always
 * has a `SET`, and a real delete always has a `FROM`.
 */
export function containsDml(sql: string): boolean {
  const body = stripSqlComments(sql);
  if (/\binsert\s+into\b/i.test(body)) return true;
  if (/\bdelete\s+from\b/i.test(body)) return true;
  // UPDATE <table> [AS alias] SET — the SET is what separates DML from the
  // `ON UPDATE` clause of a foreign key.
  if (/\bupdate\s+(only\s+)?[\w".]+(\s+(as\s+)?[\w"]+)?\s+set\b/i.test(body)) return true;
  return false;
}

/**
 * sha256 hex of a migration's contents.
 *
 * Derived from `drizzle-orm`'s `readMigrationFiles` (node_modules/drizzle-orm/
 * migrator.js), which `drizzle-kit migrate` delegates to for every Postgres
 * driver:
 *
 *     const query = fs.readFileSync(`${folder}/${tag}.sql`).toString();
 *     hash: crypto.createHash('sha256').update(query).digest('hex')
 *
 * It is the WHOLE file — header comments, `--> statement-breakpoint` markers,
 * trailing newline and all. The split on statement breakpoints happens after
 * hashing and does not affect it.
 */
export function hashMigration(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

/** Build the derived record for one migration file. */
export function describeMigration(entry: JournalEntry, contents: string): MigrationFile {
  const normalised = contents.replace(/\r\n/g, '\n');
  return {
    tag: entry.tag,
    idx: entry.idx,
    when: entry.when,
    hash: hashMigration(contents),
    canonicalHash: hashMigration(normalised),
    hasCrlf: normalised !== contents,
    hasDml: containsDml(contents),
  };
}

/** How a journal entry lines up against the ledger. */
export type EntryState =
  /** Recorded, and the recorded hash matches this checkout. */
  | 'applied'
  /** Recorded, but only matches once line endings are normalised. */
  | 'applied-line-endings'
  /** Recorded, and the hash matches nothing we can produce from this file. */
  | 'hash-mismatch'
  /** Not recorded at all. */
  | 'missing';

export interface EntryStatus {
  tag: string;
  idx: number;
  when: number;
  hasDml: boolean;
  state: EntryState;
  /** The hash the ledger holds, when there is a row for this entry. */
  recordedHash?: string;
  /** The hash this checkout computes. */
  expectedHash: string;
}

export interface StatusReport {
  /** `current_database()`, so the operator can see which database was addressed. */
  database: string;
  journalCount: number;
  ledgerCount: number;
  entries: EntryStatus[];
  /** Entries with no ledger row, in journal order. */
  missing: EntryStatus[];
  /** The subset of `missing` that writes data — the dangerous kind. */
  missingWithDml: EntryStatus[];
  /** Recorded entries whose hash matches neither the file nor its LF form. */
  hashMismatches: EntryStatus[];
  /** Ledger rows with no journal entry — a ledger from a different history. */
  orphanRows: LedgerRow[];
  /** True when the checkout's line endings differ from the recorded ones. */
  lineEndingSkew: boolean;
  /** True when anything at all is out of step. */
  drift: boolean;
}

/**
 * Reconcile journal against ledger.
 *
 * Rows are matched on `created_at`, not on hash. `created_at` is the journal
 * entry's `when`, copied verbatim by the migrator, so it is the stable identity
 * of an entry; the hash is the thing being CHECKED and cannot also be the key.
 * Matching on hash would make an edited migration look like a missing one.
 */
export function buildStatusReport(
  database: string,
  migrations: MigrationFile[],
  ledger: LedgerRow[],
): StatusReport {
  const byWhen = new Map<number, LedgerRow>();
  for (const row of ledger) byWhen.set(row.createdAt, row);

  const entries: EntryStatus[] = migrations.map((m) => {
    const row = byWhen.get(m.when);
    let state: EntryState;
    if (!row) state = 'missing';
    else if (row.hash === m.hash) state = 'applied';
    else if (row.hash === m.canonicalHash) state = 'applied-line-endings';
    else state = 'hash-mismatch';
    return {
      tag: m.tag,
      idx: m.idx,
      when: m.when,
      hasDml: m.hasDml,
      state,
      recordedHash: row?.hash,
      expectedHash: m.hash,
    };
  });

  const known = new Set(migrations.map((m) => m.when));
  const orphanRows = ledger.filter((r) => !known.has(r.createdAt));
  const missing = entries.filter((e) => e.state === 'missing');
  const hashMismatches = entries.filter((e) => e.state === 'hash-mismatch');
  const lineEndingSkew = entries.some((e) => e.state === 'applied-line-endings');

  return {
    database,
    journalCount: migrations.length,
    ledgerCount: ledger.length,
    entries,
    missing,
    missingWithDml: missing.filter((e) => e.hasDml),
    hashMismatches,
    orphanRows,
    lineEndingSkew,
    drift: missing.length > 0 || hashMismatches.length > 0 || orphanRows.length > 0,
  };
}

/** Render a status report for a terminal. Pure — returns the text, prints nothing. */
export function formatStatusReport(report: StatusReport): string {
  const out: string[] = [];
  out.push(`database:  ${report.database}`);
  out.push(`journal:   ${report.journalCount} migrations in drizzle/meta/_journal.json`);
  out.push(`ledger:    ${report.ledgerCount} rows in drizzle.__drizzle_migrations`);
  out.push('');

  if (!report.drift) {
    out.push('IN STEP — every journal entry is recorded and every hash matches.');
    if (report.lineEndingSkew) {
      out.push(
        '  note: hashes matched only after normalising CRLF to LF. This checkout has',
        '        Windows line endings (core.autocrlf); the recorded hashes came from a',
        '        LF checkout. Not drift.',
      );
    }
    return out.join('\n');
  }

  if (report.missing.length > 0) {
    out.push(`BEHIND — ${report.missing.length} journal entr${report.missing.length === 1 ? 'y is' : 'ies are'} not recorded in the ledger:`);
    for (const e of report.missing) {
      out.push(`  ${e.hasDml ? 'DML ' : '    '} ${e.tag}`);
    }
    out.push('');
  }

  if (report.missingWithDml.length > 0) {
    out.push(
      `DATA MIGRATIONS PENDING — ${report.missingWithDml.length} of the missing entries write data:`,
    );
    for (const e of report.missingWithDml) out.push(`  ${e.tag}`);
    out.push(
      '',
      '  These are the dangerous ones. A schema sync reproduces structure and skips',
      '  DML entirely, so if this database reached its current schema by a sync rather',
      '  than by migrating, these have NOT run and their effects are absent — silently,',
      '  with no error anywhere. Do not baseline past them; run them.',
      '',
    );
  }

  if (report.hashMismatches.length > 0) {
    out.push(`DIVERGED — ${report.hashMismatches.length} recorded entr${report.hashMismatches.length === 1 ? 'y has' : 'ies have'} a hash this checkout cannot produce:`);
    for (const e of report.hashMismatches) {
      out.push(`  ${e.tag}`);
      out.push(`      recorded ${e.recordedHash}`);
      out.push(`      expected ${e.expectedHash}`);
    }
    out.push(
      '',
      '  The file changed after it was applied, or this database was migrated from a',
      '  different branch. This is a divergent history, not a behind one.',
      '',
    );
  }

  if (report.orphanRows.length > 0) {
    out.push(`UNKNOWN — ${report.orphanRows.length} ledger row(s) match no journal entry:`);
    for (const r of report.orphanRows) {
      out.push(`  created_at ${r.createdAt}  hash ${r.hash}`);
    }
    out.push(
      '',
      '  This ledger records migrations this checkout does not have. Check the branch',
      '  before doing anything else.',
      '',
    );
  }

  if (report.lineEndingSkew) {
    out.push(
      'note: some hashes matched only after normalising CRLF to LF — this checkout has',
      '      Windows line endings. That part is not drift.',
      '',
    );
  }

  return out.join('\n').trimEnd();
}

/* ------------------------------------------------------------------ *\
 * Baselining
\* ------------------------------------------------------------------ */

/** One row `db:baseline` would write. */
export interface BaselineRow {
  tag: string;
  /**
   * The hash to record. Always the LF form: the git blob is LF, and every
   * checkout that will ever run `drizzle-kit migrate` against this database
   * — Replit, CI — sees LF. Recording a Windows checkout's CRLF hash would
   * write a value no other machine can reproduce.
   */
  hash: string;
  /** `created_at` — the journal entry's `when`, exactly as the migrator copies it. */
  createdAt: number;
}

export interface BaselinePlan {
  /** Rows that would be inserted. */
  toRecord: BaselineRow[];
  /** Tags already in the ledger, skipped rather than duplicated. */
  alreadyRecorded: string[];
  /** Missing entries that write data. Non-empty means refuse, unless overridden. */
  blockedByDml: string[];
  /**
   * Missing entries left OUT by `--through`, and so still pending afterwards.
   *
   * Reported rather than silent: an operator who mistypes the tag would
   * otherwise see a baseline that looks complete and leaves half the range
   * unrecorded, which is the same confusion this whole tool exists to end.
   */
  beyondRange: string[];
}

/**
 * Work out what baselining would write, without writing it.
 *
 * Idempotent by construction: an entry the ledger already records never appears
 * in `toRecord`, so a second run writes nothing rather than duplicating rows.
 */
export function planBaseline(
  migrations: MigrationFile[],
  report: StatusReport,
  /**
   * Stop after this tag (inclusive), leaving everything later PENDING.
   *
   * WHY A RANGE IS NOT OPTIONAL IN PRACTICE. Baselining says "these already
   * ran"; it is a claim about the database, not a wish. A database whose schema
   * was pushed to some point is ahead of its ledger only UP TO that point —
   * anything merged since has run nowhere, and recording it as applied is a lie
   * the next `drizzle-kit migrate` will believe. It will then skip a migration
   * whose columns do not exist, and the failure surfaces far from here.
   *
   * Concretely, on 2026-08-12: production sat at ledger 24 with schema 0054,
   * while 0055 had just merged and existed nowhere. Baselining everything
   * missing would have marked 0055 applied, and `import_runs.status` — the
   * column its own backfill needs — would never have been created.
   *
   * Omitted, every missing migration is recorded, which is only right when the
   * schema truly matches the last one on disk.
   */
  through?: string,
): BaselinePlan {
  const byTag = new Map(migrations.map((m) => [m.tag, m]));
  const missingTags = new Set(report.missing.map((e) => e.tag));

  /*
    Cut by the migration's ORDER on disk rather than by string comparison of
    tags: the tags carry a numeric prefix, but the words after it are arbitrary
    and would sort a range apart.
  */
  const order = new Map(migrations.map((m, i) => [m.tag, i]));
  const limit = through === undefined ? Infinity : (order.get(through) ?? -1);
  const beyondRange: string[] = [];

  const toRecord: BaselineRow[] = [];
  for (const e of report.missing) {
    const m = byTag.get(e.tag);
    if (!m) continue;
    if ((order.get(m.tag) ?? Infinity) > limit) {
      beyondRange.push(m.tag);
      continue;
    }
    toRecord.push({ tag: m.tag, hash: m.canonicalHash, createdAt: m.when });
  }

  const recordedTags = new Set(toRecord.map((r) => r.tag));
  return {
    toRecord,
    alreadyRecorded: migrations.filter((m) => !missingTags.has(m.tag)).map((m) => m.tag),
    /*
      Only what this run would actually record can block it. A data migration
      LATER than `through` is left pending on purpose — that is the point of the
      range — so it must not refuse the baseline it is excluded from.
    */
    blockedByDml: report.missingWithDml.map((e) => e.tag).filter((t) => recordedTags.has(t)),
    beyondRange,
  };
}

/**
 * The refusal message for a baseline whose range contains a data migration.
 *
 * Named and exported so the reason is testable and cannot drift away from the
 * check that produces it.
 */
export function formatDmlRefusal(tags: string[]): string {
  return [
    `REFUSING TO BASELINE — ${tags.length} pending migration(s) write data:`,
    ...tags.map((t) => `  ${t}`),
    '',
    'Baselining records a migration as applied WITHOUT running it. For a schema',
    'migration whose effects are already present that is merely bookkeeping. For a',
    'DATA migration it is a lie: pretending it ran will not make it run, and it will',
    'never be looked at again.',
    '',
    '0042_seed_profiles_category.sql is the worked example. It backfills the',
    '`profiles` permission category into role matrices that predate it. A schema sync',
    'skipped it, so it never ran, and every organisation with a stored role matrix',
    'silently resolved profile access to DENIED — an empty screen, no error, and hours',
    'to find. Baselining it would have made that permanent.',
    '',
    'Run these migrations against the database, by hand if need be, and re-run',
    'db:status. If you have already verified their effects are present by other',
    'means, and you can say what those means were, re-run with --allow-dml.',
  ].join('\n');
}

/** What `db:baseline` should do, given a plan and the operator's flags. */
export type BaselineAction =
  /** The ledger records something this checkout does not have. Stop. */
  | 'refuse-diverged'
  /** Pending migrations write data and `--allow-dml` was not given. Stop. */
  | 'refuse-dml'
  /** Every entry already recorded. Nothing to do — and that is a success. */
  | 'nothing-to-do'
  /** A plan was printed but `--yes` was not given. Write nothing. */
  | 'dry-run'
  /** Write the rows. */
  | 'write';

export interface BaselineDecision {
  action: BaselineAction;
  exitCode: number;
  message: string;
}

/**
 * Decide, without touching a database, what a baseline run should do.
 *
 * Split out from the script so every refusal is testable and so the reasons
 * cannot drift away from the checks that produce them. The ordering matters: a
 * divergent history is checked before a DML block, because on a divergent
 * ledger the DML analysis is answering the wrong question.
 */
export function decideBaseline(input: {
  database: string;
  plan: BaselinePlan;
  report: StatusReport;
  confirmed: boolean;
  allowDml: boolean;
}): BaselineDecision {
  const { database, plan, report, confirmed, allowDml } = input;

  if (report.hashMismatches.length > 0) {
    return {
      action: 'refuse-diverged',
      exitCode: 1,
      message: [
        `REFUSING TO BASELINE — ${report.hashMismatches.length} recorded migration(s) have a hash`,
        'this checkout cannot produce. That is a divergent history, not a behind ledger.',
        'Run db:status and work out which branch this database was migrated from before',
        'recording anything else against it.',
      ].join('\n'),
    };
  }
  if (report.orphanRows.length > 0) {
    return {
      action: 'refuse-diverged',
      exitCode: 1,
      message: [
        `REFUSING TO BASELINE — ${report.orphanRows.length} ledger row(s) match no journal entry.`,
        'This ledger records migrations this checkout does not have. Check the branch.',
      ].join('\n'),
    };
  }
  if (plan.toRecord.length === 0) {
    return {
      action: 'nothing-to-do',
      exitCode: 0,
      message: formatBaselinePlan(database, plan),
    };
  }
  if (plan.blockedByDml.length > 0 && !allowDml) {
    return { action: 'refuse-dml', exitCode: 1, message: formatDmlRefusal(plan.blockedByDml) };
  }

  const preamble = [formatBaselinePlan(database, plan), ''];
  if (plan.blockedByDml.length > 0) {
    preamble.push(
      `--allow-dml given: ${plan.blockedByDml.length} DATA migration(s) will be recorded as`,
      'applied without running. Their effects had better already be present.',
      '',
    );
  }

  if (!confirmed) {
    return {
      action: 'dry-run',
      exitCode: 0,
      message: [...preamble, 'DRY RUN — nothing written. Re-run with --yes to record these rows.']
        .join('\n'),
    };
  }
  return { action: 'write', exitCode: 0, message: preamble.join('\n').trimEnd() };
}

/** Render a baseline plan for the operator to confirm. */
export function formatBaselinePlan(database: string, plan: BaselinePlan): string {
  const out: string[] = [];
  out.push(`database:  ${database}`);
  out.push('');
  if (plan.toRecord.length === 0) {
    out.push('Nothing to record — every journal entry is already in the ledger.');
    return out.join('\n');
  }
  out.push(`Would record ${plan.toRecord.length} migration(s) as applied WITHOUT running them:`);
  out.push('');
  for (const r of plan.toRecord) {
    out.push(`  ${r.tag}`);
    out.push(`      created_at ${r.createdAt}`);
    out.push(`      hash       ${r.hash}`);
  }
  out.push('');
  out.push(`(${plan.alreadyRecorded.length} already recorded — skipped, not duplicated.)`);
  return out.join('\n');
}
