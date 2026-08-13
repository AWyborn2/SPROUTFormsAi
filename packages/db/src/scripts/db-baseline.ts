/**
 * Record migrations as applied WITHOUT running them.
 *
 *   pnpm db:baseline --url-env PRODUCTION_DATABASE_URL                    # dry run
 *   pnpm db:baseline --url-env PRODUCTION_DATABASE_URL --yes              # writes
 *   pnpm db:baseline --url-env PROD --through 0054_unique_jack_flag --yes # stop short
 *
 * For the one case this is for: a database whose SCHEMA is genuinely ahead of
 * its ledger, because something outside this repo pushed the schema directly.
 * `drizzle-kit migrate` then refuses to start — it re-applies from the ledger's
 * high-water mark and dies on `column ... already exists`. Baselining moves the
 * bookkeeping forward so the next real migration can run.
 *
 * It is a sharp tool and behaves like one:
 *
 *   - It never baselines by default. Without `--yes` it prints the plan and stops.
 *   - It REFUSES outright if any pending migration writes data, and says why.
 *     `--allow-dml` overrides that, separately and explicitly.
 *   - It prints every row it would write, hash and all, before writing any.
 *   - It is idempotent: an already-recorded tag is skipped, never duplicated.
 *   - It requires the database to be NAMED. No ambient DATABASE_URL.
 *   - `--through <tag>` stops after that migration, leaving later ones PENDING.
 *     Use it whenever the schema is ahead only UP TO a point: recording a
 *     migration that has run nowhere makes the next migrate skip it, and its
 *     columns never appear.
 */
import { buildStatusReport, decideBaseline, planBaseline } from '../migration-ledger.js';
import {
  defaultMigrationsFolder,
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

  const confirmed = process.argv.includes('--yes');
  const allowDml = process.argv.includes('--allow-dml');
  const through = flag('through') ?? undefined;
  const folder = flag('migrations') ?? defaultMigrationsFolder();
  const migrations = await readMigrations(folder);

  const conn = await openLedger(resolved.url);
  try {
    console.log(`connected to ${conn.database} (via ${resolved.source})`);
    console.log('');

    const report = buildStatusReport(conn.database, migrations, conn.rows);
    const plan = planBaseline(migrations, report, through);
    if (through !== undefined && plan.toRecord.length === 0 && plan.beyondRange.length > 0) {
      console.error(
        `--through "${through}" matched no pending migration at or before it.
` +
          `Check the tag. Pending: ${plan.beyondRange.slice(0, 3).join(', ')}...`,
      );
      return 2;
    }
    const decision = decideBaseline({
      database: conn.database,
      plan,
      report,
      confirmed,
      allowDml,
    });

    if (decision.action === 'refuse-diverged' || decision.action === 'refuse-dml') {
      console.error(decision.message);
      return decision.exitCode;
    }

    // Everything it will write, printed before any of it is written.
    console.log(decision.message);
    if (decision.action !== 'write') return decision.exitCode;

    // Written the way drizzle writes them: `created_at` is the journal entry's
    // `when` verbatim (never a clock reading — the migrator compares against it
    // to decide what is pending), and `hash` is the sha256 of the migration
    // file's contents, LF-normalised so it matches what a Linux checkout of the
    // same commit computes.
    await conn.sql.begin(async (tx) => {
      await tx`create schema if not exists drizzle`;
      await tx`
        create table if not exists drizzle.__drizzle_migrations (
          id serial primary key,
          hash text not null,
          created_at bigint
        )
      `;
      for (const row of plan.toRecord) {
        // Guarded on created_at rather than blindly inserted, so a concurrent
        // migrate cannot produce a duplicate row for the same entry.
        await tx`
          insert into drizzle.__drizzle_migrations (hash, created_at)
          select ${row.hash}, ${row.createdAt}
          where not exists (
            select 1 from drizzle.__drizzle_migrations where created_at = ${row.createdAt}
          )
        `;
      }
    });

    console.log(`Recorded ${plan.toRecord.length} migration(s) in ${conn.database}.`);
    if (plan.beyondRange.length > 0) {
      console.log('');
      console.log(`STILL PENDING (left out by --through), run these with db:migrate:`);
      for (const t of plan.beyondRange) console.log(`  ${t}`);
    }
    console.log('Re-run db:status to confirm.');
    return 0;
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
