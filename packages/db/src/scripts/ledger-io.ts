/**
 * The I/O half of the migration-ledger tools: reading the journal off disk,
 * resolving a connection string the operator NAMED, and reading the ledger.
 *
 * `packages/db/src/migration-ledger.ts` holds the reconciliation logic and is
 * pure; everything that touches a disk or a socket is here.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import {
  describeMigration,
  type JournalEntry,
  type LedgerRow,
  type MigrationFile,
} from '../migration-ledger.js';

/** `packages/db/drizzle`, resolved from this file rather than from cwd. */
export function defaultMigrationsFolder(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
}

export function flag(name: string, argv: string[] = process.argv): string | null {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? (argv[i + 1] ?? null) : null;
}

/**
 * Resolve the database to address.
 *
 * There is NO fallback to an ambient `DATABASE_URL`. That ambiguity is the
 * whole cause of the incident these tools exist for: in the Replit workspace
 * `DATABASE_URL` is DEV (`heliumdb`) while the published app runs PRODUCTION
 * (`neondb`), and every tool that quietly read the ambient variable was
 * addressing dev while the operator believed otherwise. The operator must name
 * the database, either as a literal string or as the environment variable to
 * read — `--url-env DATABASE_URL` is allowed, but only because it was typed.
 */
export function resolveDatabaseUrl(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): { url: string; source: string } | { error: string } {
  const literal = flag('url', argv);
  const fromEnv = flag('url-env', argv);

  if (literal && fromEnv) {
    return { error: 'Pass --url or --url-env, not both.' };
  }
  if (literal) return { url: literal, source: '--url' };
  if (fromEnv) {
    const value = env[fromEnv];
    if (!value) return { error: `--url-env ${fromEnv} is set, but ${fromEnv} is empty or unset.` };
    return { url: value, source: `$${fromEnv}` };
  }
  return {
    error: [
      'No database named. Pass one explicitly:',
      '',
      '  --url  <postgres://...>        a literal connection string',
      '  --url-env <VAR>                the environment variable to read it from',
      '',
      'The ambient DATABASE_URL is deliberately NOT used as a fallback. In the Replit',
      'workspace it points at DEV (heliumdb) while the published app runs PRODUCTION',
      '(neondb), and tools that silently read it have addressed the wrong database.',
      'If dev is genuinely what you want, say so: --url-env DATABASE_URL.',
    ].join('\n'),
  };
}

/** Read `drizzle/meta/_journal.json` and every migration file it names. */
export async function readMigrations(folder: string): Promise<MigrationFile[]> {
  const journalPath = path.join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: JournalEntry[] };
  const files: MigrationFile[] = [];
  for (const entry of journal.entries) {
    const sql = await readFile(path.join(folder, `${entry.tag}.sql`), 'utf8');
    files.push(describeMigration(entry, sql));
  }
  return files;
}

/**
 * Warn about `.sql` files in the folder that no journal entry names. Drizzle
 * ignores them completely, which makes a migration that was added by hand
 * without regenerating the journal invisible to every tool including this one.
 */
export async function findUnjournalledFiles(
  folder: string,
  migrations: MigrationFile[],
): Promise<string[]> {
  const known = new Set(migrations.map((m) => `${m.tag}.sql`));
  const present = (await readdir(folder)).filter((f) => f.endsWith('.sql'));
  return present.filter((f) => !known.has(f)).sort();
}

export interface LedgerConnection {
  database: string;
  /** False when `drizzle.__drizzle_migrations` does not exist at all. */
  ledgerTablePresent: boolean;
  rows: LedgerRow[];
  sql: postgres.Sql;
}

/**
 * Open a connection, report which database it actually landed on, and read the
 * ledger. Read-only; safe against production at any time.
 *
 * `current_database()` is printed by the callers before anything else happens,
 * so an operator who fat-fingered a connection string sees it immediately
 * rather than after the fact.
 */
export async function openLedger(url: string): Promise<LedgerConnection> {
  const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
  const [info] = await sql<{ db: string }[]>`select current_database() as db`;
  const database = info?.db ?? '(unknown)';

  // The table may legitimately not exist — a database that has never been
  // migrated by this repo at all. That is a reportable state, not an error.
  const [exists] = await sql<{ present: boolean }[]>`
    select exists (
      select 1 from information_schema.tables
      where table_schema = 'drizzle' and table_name = '__drizzle_migrations'
    ) as present
  `;

  let rows: LedgerRow[] = [];
  if (exists?.present) {
    const raw = await sql<{ hash: string; created_at: string | number | null }[]>`
      select hash, created_at from drizzle.__drizzle_migrations order by created_at asc
    `;
    rows = raw.map((r) => ({ hash: r.hash, createdAt: Number(r.created_at ?? 0) }));
  }

  return { database, ledgerTablePresent: exists?.present ?? false, rows, sql };
}
