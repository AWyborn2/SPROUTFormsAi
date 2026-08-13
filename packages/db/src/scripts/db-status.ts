/**
 * Report drift between a database's migration ledger and this checkout's
 * journal. Reads only; changes nothing; safe against production at any time.
 *
 *   pnpm db:status --url-env DATABASE_URL
 *   pnpm db:status --url-env PRODUCTION_DATABASE_URL
 *   pnpm db:status --url 'postgres://...'
 *
 * Exits 1 on drift so CI or a human notices. Exits 0 only when every journal
 * entry is recorded and every hash reconciles.
 *
 * This exists because nothing in the repo could previously tell you that
 * production's ledger said 24 while its schema was current through 0054 — or,
 * worse, that `0042_seed_profiles_category.sql` was a DATA migration sitting
 * in that gap, unrun and unrunnable.
 */
import {
  buildStatusReport,
  formatStatusReport,
} from '../migration-ledger.js';
import {
  defaultMigrationsFolder,
  findUnjournalledFiles,
  flag,
  openLedger,
  readMigrations,
  resolveDatabaseUrl,
} from './ledger-io.js';

async function main(): Promise<number> {
  const resolved = resolveDatabaseUrl();
  if ('error' in resolved) {
    console.error(resolved.error);
    return 2;
  }

  const folder = flag('migrations') ?? defaultMigrationsFolder();
  const migrations = await readMigrations(folder);

  const conn = await openLedger(resolved.url);
  try {
    // Printed before anything else, every run: the operator sees which database
    // they are addressing without having to trust the connection string they
    // typed or the variable they named.
    console.log(`connected to ${conn.database} (via ${resolved.source})`);
    console.log('');

    if (!conn.ledgerTablePresent) {
      console.log(`database:  ${conn.database}`);
      console.log(`journal:   ${migrations.length} migrations in drizzle/meta/_journal.json`);
      console.log('ledger:    drizzle.__drizzle_migrations DOES NOT EXIST');
      console.log('');
      console.log('This database has never been migrated by this repo. If its schema is');
      console.log('nevertheless current, it was synced by something else — check db:status');
      console.log('output on a database that HAS been migrated before assuming parity.');
      return 1;
    }

    const report = buildStatusReport(conn.database, migrations, conn.rows);
    console.log(formatStatusReport(report));

    const stray = await findUnjournalledFiles(folder, migrations);
    if (stray.length > 0) {
      console.log('');
      console.log(`WARNING — ${stray.length} .sql file(s) in ${folder} that no journal entry names:`);
      for (const f of stray) console.log(`  ${f}`);
      console.log('  Drizzle ignores these entirely. They will never run.');
    }

    return report.drift ? 1 : 0;
  } finally {
    await conn.sql.end({ timeout: 5 });
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
