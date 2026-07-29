/**
 * Switch an org's plan tier directly in the database. DEV/TESTING ONLY.
 *
 *   cd packages/db
 *   DATABASE_URL=... node scripts/set-org-plan.mjs                 # show current
 *   DATABASE_URL=... node scripts/set-org-plan.mjs enterprise      # switch
 *   DATABASE_URL=... node scripts/set-org-plan.mjs business --org <uuid>
 *
 * Mirrors POST /org/plan, which is the supported route but needs an
 * authenticated owner session — awkward from a shell. This writes the same
 * three columns the endpoint does (plan_tier, seat_limit, candidate_seat_limit)
 * from the same PLAN_CONFIG, so the two cannot drift.
 *
 * Reports current state and exits when given no tier, so it is safe to run
 * blind.
 */
import postgres from 'postgres';
import { PLAN_CONFIG, PLAN_TIERS } from '@formai/db';

const args = process.argv.slice(2);
const tier = args.find((a) => !a.startsWith('--'));
const orgIdx = args.indexOf('--org');
const ORG_ID = orgIdx > -1 ? args[orgIdx + 1] : null;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL);

async function main() {
  const orgs = ORG_ID
    ? await sql`select id, name, plan_tier, seat_limit, candidate_seat_limit from organizations where id = ${ORG_ID}`
    : await sql`select id, name, plan_tier, seat_limit, candidate_seat_limit from organizations order by id`;

  if (orgs.length === 0) {
    console.error('No matching organisation.');
    process.exit(1);
  }

  console.log('Current:');
  console.table(orgs);

  if (!tier) {
    console.log(`\nPass a tier to change it: ${PLAN_TIERS.join(' | ')}`);
    console.log('Assessments require business or enterprise.');
    return;
  }

  if (!PLAN_TIERS.includes(tier)) {
    console.error(`\nUnknown tier "${tier}". Expected one of: ${PLAN_TIERS.join(', ')}`);
    process.exit(1);
  }

  if (orgs.length > 1 && !ORG_ID) {
    console.error(`\n${orgs.length} organisations found — pass --org <uuid> to name the one to change.`);
    process.exit(1);
  }

  const org = orgs[0];
  const config = PLAN_CONFIG[tier];
  await sql`
    update organizations
    set plan_tier = ${tier},
        seat_limit = ${config.seatLimit},
        candidate_seat_limit = ${config.candidateSeatLimit}
    where id = ${org.id}
  `;

  const [after] = await sql`select id, name, plan_tier, seat_limit, candidate_seat_limit from organizations where id = ${org.id}`;
  console.log(`\nUpdated ${org.name}:`);
  console.table([after]);
  console.log('\nFeatures now enabled:');
  console.table(
    Object.entries(config.features).map(([feature, on]) => ({ feature, enabled: on })),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
