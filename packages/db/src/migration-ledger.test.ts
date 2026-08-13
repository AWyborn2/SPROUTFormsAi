import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildStatusReport,
  containsDml,
  decideBaseline,
  describeMigration,
  formatStatusReport,
  hashMigration,
  planBaseline,
  type JournalEntry,
  type LedgerRow,
  type MigrationFile,
} from './migration-ledger.js';
import { resolveDatabaseUrl } from './scripts/ledger-io.js';

const DRIZZLE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
);

function entry(idx: number, tag: string, when: number): JournalEntry {
  return { idx, when, tag, breakpoints: true };
}

/** A three-migration history: two DDL, one data-only, in that order. */
function fixture(): MigrationFile[] {
  return [
    describeMigration(entry(0, '0000_create', 1000), 'CREATE TABLE "a" ("id" uuid);\n'),
    describeMigration(
      entry(1, '0001_fk', 2000),
      'ALTER TABLE "b" ADD CONSTRAINT "fk" FOREIGN KEY ("a") REFERENCES "a"("id") ON DELETE cascade ON UPDATE no action;\n',
    ),
    describeMigration(
      entry(2, '0002_seed', 3000),
      "-- data only\nUPDATE \"role_permissions\" SET \"matrix\" = '{}'::jsonb WHERE \"matrix\" IS NULL;\n",
    ),
  ];
}

function ledgerFor(migrations: MigrationFile[]): LedgerRow[] {
  return migrations.map((m) => ({ hash: m.hash, createdAt: m.when }));
}

describe('hashMigration', () => {
  // Derived from drizzle-orm's readMigrationFiles (node_modules/drizzle-orm/
  // migrator.js), which drizzle-kit migrate delegates to: sha256 of the WHOLE
  // file, header comments and statement-breakpoint markers included, taken
  // before the split on breakpoints. Restated here independently so a change
  // to our implementation has to disagree with the spec, not just with itself.
  it('is sha256 of the entire file contents', () => {
    const sql = '-- header\nCREATE TABLE "a" ();\n--> statement-breakpoint\nSELECT 1;\n';
    expect(hashMigration(sql)).toBe(createHash('sha256').update(sql).digest('hex'));
  });

  it('agrees with drizzle-orm on every migration in this repo', async () => {
    // The check that matters. Rather than trust a reading of the migrator's
    // source, run the migrator's own file reader — the exact function
    // `drizzle-kit migrate` delegates to for every Postgres driver — over the
    // real drizzle/ folder and require agreement on all 56 files, hash and
    // created_at alike. A wrong hash is worse than no row, so this is pinned.
    const { readMigrationFiles } = await import('drizzle-orm/migrator');
    const theirs = readMigrationFiles({ migrationsFolder: DRIZZLE_DIR });
    const journal = JSON.parse(
      await readFile(path.join(DRIZZLE_DIR, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: JournalEntry[] };

    expect(theirs.length).toBe(journal.entries.length);
    expect(theirs.length).toBeGreaterThan(0);

    for (const [i, journalEntry] of journal.entries.entries()) {
      const sql = await readFile(path.join(DRIZZLE_DIR, `${journalEntry.tag}.sql`), 'utf8');
      const ours = describeMigration(journalEntry, sql);
      expect(ours.hash, journalEntry.tag).toBe(theirs[i]!.hash);
      // `created_at` is the journal's `when`, copied verbatim — never a clock
      // reading. The migrator compares against it to decide what is pending.
      expect(ours.when, journalEntry.tag).toBe(theirs[i]!.folderMillis);
    }
  });

  it('is sensitive to line endings, which is why a canonical hash exists', () => {
    const lf = 'SELECT 1;\nSELECT 2;\n';
    const crlf = 'SELECT 1;\r\nSELECT 2;\r\n';
    expect(hashMigration(lf)).not.toBe(hashMigration(crlf));

    const m = describeMigration(entry(0, '0000_x', 1), crlf);
    expect(m.hasCrlf).toBe(true);
    expect(m.hash).toBe(hashMigration(crlf));
    expect(m.canonicalHash).toBe(hashMigration(lf));
  });
});

describe('containsDml', () => {
  it('flags INSERT, UPDATE ... SET and DELETE FROM', () => {
    expect(containsDml('INSERT INTO "t" ("a") VALUES (1);')).toBe(true);
    expect(containsDml('UPDATE "t" SET "a" = 1 WHERE "b" IS NULL;')).toBe(true);
    expect(containsDml('update only t as x set a = 1;')).toBe(true);
    expect(containsDml('DELETE FROM "t" WHERE "a" = 1;')).toBe(true);
  });

  it('does not mistake ON DELETE / ON UPDATE foreign key clauses for DML', () => {
    // Nearly every DDL migration in this repo carries these, so a naive
    // keyword match would flag the entire history as data migrations and make
    // the DML warning worthless.
    const ddl = `ALTER TABLE "b" ADD CONSTRAINT "fk" FOREIGN KEY ("a")
       REFERENCES "a"("id") ON DELETE cascade ON UPDATE no action;`;
    expect(containsDml(ddl)).toBe(false);
  });

  it('ignores DML words inside comments', () => {
    // These migrations carry long rationale headers; one that says "this does
    // not INSERT anything" must not be read as inserting something.
    expect(containsDml('-- does not INSERT INTO anything\nALTER TABLE "a" ADD "b" text;')).toBe(
      false,
    );
    expect(containsDml('/* UPDATE t SET x=1 */\nALTER TABLE "a" ADD "b" text;')).toBe(false);
  });

  it('recognises the real 0042_seed_profiles_category.sql as a data migration', async () => {
    const sql = await readFile(path.join(DRIZZLE_DIR, '0042_seed_profiles_category.sql'), 'utf8');
    expect(containsDml(sql)).toBe(true);
  });

  it('recognises a real DDL-only migration as not a data migration', async () => {
    const sql = await readFile(path.join(DRIZZLE_DIR, '0001_replit_auth.sql'), 'utf8');
    expect(containsDml(sql)).toBe(false);
  });
});

describe('buildStatusReport', () => {
  it('passes on a database whose ledger matches the journal', () => {
    const migrations = fixture();
    const report = buildStatusReport('neondb', migrations, ledgerFor(migrations));

    expect(report.drift).toBe(false);
    expect(report.journalCount).toBe(3);
    expect(report.ledgerCount).toBe(3);
    expect(report.missing).toEqual([]);
    expect(report.hashMismatches).toEqual([]);
    expect(report.orphanRows).toEqual([]);
    expect(formatStatusReport(report)).toContain('IN STEP');
  });

  it('reports a behind ledger by tag, and exits-worthy drift', () => {
    // The production shape: the ledger stops partway, the schema does not.
    const migrations = fixture();
    const report = buildStatusReport('neondb', migrations, ledgerFor(migrations).slice(0, 1));

    expect(report.drift).toBe(true);
    expect(report.ledgerCount).toBe(1);
    expect(report.missing.map((e) => e.tag)).toEqual(['0001_fk', '0002_seed']);

    const text = formatStatusReport(report);
    expect(text).toContain('BEHIND');
    expect(text).toContain('0001_fk');
  });

  it('calls out the missing migrations that write data, separately', () => {
    const migrations = fixture();
    const report = buildStatusReport('neondb', migrations, ledgerFor(migrations).slice(0, 1));

    // 0001_fk is DDL and a schema sync would have reproduced it; 0002_seed is
    // data and a schema sync cannot have.
    expect(report.missingWithDml.map((e) => e.tag)).toEqual(['0002_seed']);

    const text = formatStatusReport(report);
    expect(text).toContain('DATA MIGRATIONS PENDING');
    expect(text).toContain('0002_seed');
  });

  it('distinguishes a divergent history from a merely behind one', () => {
    const migrations = fixture();
    const ledger = ledgerFor(migrations);
    ledger[1] = { hash: 'f'.repeat(64), createdAt: migrations[1]!.when };

    const report = buildStatusReport('neondb', migrations, ledger);
    expect(report.missing).toEqual([]);
    expect(report.hashMismatches.map((e) => e.tag)).toEqual(['0001_fk']);
    expect(formatStatusReport(report)).toContain('DIVERGED');
  });

  it('treats a CRLF checkout as matching, not as divergence', () => {
    // core.autocrlf rewrites every migration on a Windows checkout. Without
    // this, db:status would scream "diverged" at 56 files on Ash's machine.
    const lf = 'SELECT 1;\nSELECT 2;\n';
    const onDisk = describeMigration(entry(0, '0000_x', 1000), lf.replace(/\n/g, '\r\n'));
    const ledger: LedgerRow[] = [{ hash: hashMigration(lf), createdAt: 1000 }];

    const report = buildStatusReport('neondb', [onDisk], ledger);
    expect(report.drift).toBe(false);
    expect(report.lineEndingSkew).toBe(true);
    expect(report.entries[0]!.state).toBe('applied-line-endings');
  });

  it('flags ledger rows that match no journal entry', () => {
    const migrations = fixture();
    const ledger = [...ledgerFor(migrations), { hash: 'a'.repeat(64), createdAt: 9999 }];

    const report = buildStatusReport('neondb', migrations, ledger);
    expect(report.drift).toBe(true);
    expect(report.orphanRows).toHaveLength(1);
    expect(formatStatusReport(report)).toContain('UNKNOWN');
  });

  it('matches rows on created_at, not on hash', () => {
    // If it matched on hash, an edited migration would look missing rather
    // than diverged and baselining would happily re-record it.
    const migrations = fixture();
    const ledger = ledgerFor(migrations).map((r) => ({ ...r, hash: 'b'.repeat(64) }));
    const report = buildStatusReport('neondb', migrations, ledger);

    expect(report.missing).toEqual([]);
    expect(report.hashMismatches).toHaveLength(3);
  });
});

describe('planBaseline', () => {
  it('plans exactly the missing entries, with drizzle-shaped rows', () => {
    const migrations = fixture();
    const report = buildStatusReport('neondb', migrations, ledgerFor(migrations).slice(0, 1));
    const plan = planBaseline(migrations, report);

    expect(plan.toRecord).toEqual([
      { tag: '0001_fk', hash: migrations[1]!.canonicalHash, createdAt: 2000 },
      { tag: '0002_seed', hash: migrations[2]!.canonicalHash, createdAt: 3000 },
    ]);
    expect(plan.alreadyRecorded).toEqual(['0000_create']);
    expect(plan.blockedByDml).toEqual(['0002_seed']);
  });

  /*
    The range limit, and why it exists at all.

    Baselining asserts "these already ran". That is a claim about the database,
    not a wish. A schema pushed to some point is ahead of its ledger only UP TO
    that point — anything merged since has run nowhere, and recording it as
    applied makes the next migrate skip a migration whose columns do not exist.

    Production on 2026-08-12 was exactly this: ledger 24, schema 0054, and 0055
    merged an hour earlier and present nowhere.
  */
  it('stops after --through, leaving later migrations pending', () => {
    const migrations = fixture();
    const report = buildStatusReport('neondb', migrations, ledgerFor(migrations).slice(0, 1));
    const plan = planBaseline(migrations, report, '0001_fk');

    expect(plan.toRecord.map((r) => r.tag)).toEqual(['0001_fk']);
    expect(plan.beyondRange).toEqual(['0002_seed']);
  });

  it('does NOT refuse over a data migration that --through excludes', () => {
    const migrations = fixture();
    const report = buildStatusReport('neondb', migrations, ledgerFor(migrations).slice(0, 1));
    // 0002_seed is DML, but it is beyond the range — it stays pending, so it
    // has no business blocking a baseline it is not part of.
    const plan = planBaseline(migrations, report, '0001_fk');

    expect(plan.blockedByDml).toEqual([]);
    expect(
      decideBaseline({ database: 'neondb', plan, report, confirmed: true, allowDml: false }).action,
    ).toBe('write');
  });

  it('still refuses over a data migration INSIDE the range', () => {
    const migrations = fixture();
    const report = buildStatusReport('neondb', migrations, ledgerFor(migrations).slice(0, 1));
    const plan = planBaseline(migrations, report, '0002_seed');

    expect(plan.blockedByDml).toEqual(['0002_seed']);
    expect(
      decideBaseline({ database: 'neondb', plan, report, confirmed: true, allowDml: false }).action,
    ).toBe('refuse-dml');
  });

  it('records everything missing when no range is given', () => {
    const migrations = fixture();
    const report = buildStatusReport('neondb', migrations, ledgerFor(migrations).slice(0, 1));
    const plan = planBaseline(migrations, report);

    expect(plan.toRecord).toHaveLength(2);
    expect(plan.beyondRange).toEqual([]);
  });

  it('is idempotent — a recorded tag is skipped, never duplicated', () => {
    const migrations = fixture();
    // Second run: the ledger now holds everything the first run wrote.
    const report = buildStatusReport('neondb', migrations, ledgerFor(migrations));
    const plan = planBaseline(migrations, report);

    expect(plan.toRecord).toEqual([]);
    expect(plan.alreadyRecorded).toHaveLength(3);
    expect(
      decideBaseline({ database: 'neondb', plan, report, confirmed: true, allowDml: true }).action,
    ).toBe('nothing-to-do');
  });
});

describe('decideBaseline', () => {
  const ddlOnly = () => {
    const migrations = fixture().slice(0, 2);
    const report = buildStatusReport('neondb', migrations, ledgerFor(migrations).slice(0, 1));
    return { migrations, report, plan: planBaseline(migrations, report) };
  };

  it('refuses to write without explicit confirmation', () => {
    const { plan, report } = ddlOnly();
    const decision = decideBaseline({
      database: 'neondb',
      plan,
      report,
      confirmed: false,
      allowDml: false,
    });

    expect(decision.action).toBe('dry-run');
    expect(decision.exitCode).toBe(0);
    expect(decision.message).toContain('DRY RUN');
    expect(decision.message).toContain('--yes');
  });

  it('prints the rows it would record before writing anything', () => {
    const { plan, report, migrations } = ddlOnly();
    const decision = decideBaseline({
      database: 'neondb',
      plan,
      report,
      confirmed: false,
      allowDml: false,
    });

    expect(decision.message).toContain('0001_fk');
    expect(decision.message).toContain(String(migrations[1]!.when));
    expect(decision.message).toContain(migrations[1]!.canonicalHash);
  });

  it('writes when confirmed and nothing pending writes data', () => {
    const { plan, report } = ddlOnly();
    expect(
      decideBaseline({ database: 'neondb', plan, report, confirmed: true, allowDml: false }).action,
    ).toBe('write');
  });

  it('refuses outright when a pending migration writes data, and says why', () => {
    const migrations = fixture();
    const report = buildStatusReport('neondb', migrations, ledgerFor(migrations).slice(0, 1));
    const plan = planBaseline(migrations, report);
    const decision = decideBaseline({
      database: 'neondb',
      plan,
      report,
      confirmed: true,
      allowDml: false,
    });

    expect(decision.action).toBe('refuse-dml');
    expect(decision.exitCode).toBe(1);
    expect(decision.message).toContain('REFUSING TO BASELINE');
    // The worked example, in the message, because the abstract rule did not
    // stop anyone the first time.
    expect(decision.message).toContain('0042_seed_profiles_category.sql');
    expect(decision.message).toContain('--allow-dml');
  });

  it('proceeds past DML only when --allow-dml is given separately', () => {
    const migrations = fixture();
    const report = buildStatusReport('neondb', migrations, ledgerFor(migrations).slice(0, 1));
    const plan = planBaseline(migrations, report);
    const decision = decideBaseline({
      database: 'neondb',
      plan,
      report,
      confirmed: true,
      allowDml: true,
    });

    expect(decision.action).toBe('write');
    expect(decision.message).toContain('--allow-dml given');
  });

  it('refuses on a divergent history before it even considers DML', () => {
    const migrations = fixture();
    const ledger = ledgerFor(migrations).slice(0, 2);
    ledger[1] = { hash: 'c'.repeat(64), createdAt: migrations[1]!.when };
    const report = buildStatusReport('neondb', migrations, ledger);
    const plan = planBaseline(migrations, report);

    const decision = decideBaseline({
      database: 'neondb',
      plan,
      report,
      confirmed: true,
      allowDml: true,
    });
    expect(decision.action).toBe('refuse-diverged');
    expect(decision.exitCode).toBe(1);
  });
});

describe('resolveDatabaseUrl', () => {
  // The ambiguity these tools exist to fix: an ambient DATABASE_URL that meant
  // dev while the operator meant production. Neither tool may fall back to it.
  it('refuses to run without an explicitly named database', () => {
    const result = resolveDatabaseUrl(['node', 'db-status.ts'], {
      DATABASE_URL: 'postgres://ambient/heliumdb',
    });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('No database named');
      expect(result.error).toContain('--url-env');
    }
  });

  it('accepts a literal --url', () => {
    const result = resolveDatabaseUrl(['node', 'x', '--url', 'postgres://x/neondb'], {});
    expect(result).toEqual({ url: 'postgres://x/neondb', source: '--url' });
  });

  it('accepts --url-env, including DATABASE_URL when it was actually typed', () => {
    const result = resolveDatabaseUrl(['node', 'x', '--url-env', 'DATABASE_URL'], {
      DATABASE_URL: 'postgres://ambient/heliumdb',
    });
    expect(result).toEqual({ url: 'postgres://ambient/heliumdb', source: '$DATABASE_URL' });
  });

  it('rejects a named variable that is empty rather than silently falling through', () => {
    const result = resolveDatabaseUrl(['node', 'x', '--url-env', 'PROD_URL'], {});
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('PROD_URL');
  });

  it('rejects --url and --url-env together', () => {
    const result = resolveDatabaseUrl(['node', 'x', '--url', 'a', '--url-env', 'B'], { B: 'b' });
    expect('error' in result).toBe(true);
  });
});
