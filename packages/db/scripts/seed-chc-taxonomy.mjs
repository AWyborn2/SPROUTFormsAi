/**
 * Seed the existing CHC customer's Departments and Roles into their own
 * taxonomy tables (U5, R3, R7). This is how the hardcoded department/role map
 * becomes per-org configuration: the four Departments and every Role each
 * offers are written from the same `CHC_DEPARTMENTS` constant the intake used,
 * with Operations set to allow several Roles and the other three to allow one —
 * so the seeded taxonomy reproduces exactly what the hardcoded map did.
 *
 *   cd packages/db
 *   DATABASE_URL=... node scripts/seed-chc-taxonomy.mjs --org <uuid>
 *   DATABASE_URL=... node scripts/seed-chc-taxonomy.mjs --org <uuid> --dry-run
 *
 * IDEMPOTENT: an active Department or Role of the same name is left as-is rather
 * than duplicated, so re-running is safe. It does NOT create Locations — the
 * hardcoded map carries none, and a Location list is the customer's to build.
 */
import postgres from 'postgres';
import { CHC_DEPARTMENTS } from '@formai/shared';

const args = process.argv.slice(2);
const orgIdx = args.indexOf('--org');
const ORG_ID = orgIdx > -1 ? args[orgIdx + 1] : null;
const DRY_RUN = args.includes('--dry-run');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}
if (!ORG_ID) {
  console.error('--org <uuid> is required.');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL);

async function main() {
  const [org] = await sql`select id, name, plan_tier from organizations where id = ${ORG_ID}`;
  if (!org) {
    console.error(`No organisation ${ORG_ID}.`);
    process.exit(1);
  }
  console.log(`Seeding CHC taxonomy into "${org.name}" (${org.plan_tier}).`);

  let departmentsCreated = 0;
  let rolesCreated = 0;

  for (const [name, def] of Object.entries(CHC_DEPARTMENTS)) {
    const existing = await sql`
      select id, allows_multiple_roles from departments
      where org_id = ${ORG_ID} and lower(name) = lower(${name}) and status = 'active'
      limit 1`;
    let departmentId = existing[0]?.id ?? null;

    if (!departmentId) {
      if (DRY_RUN) {
        console.log(`  + department ${name} (multi=${def.multi})`);
      } else {
        const [row] = await sql`
          insert into departments (org_id, name, allows_multiple_roles, status)
          values (${ORG_ID}, ${name}, ${def.multi}, 'active')
          returning id`;
        departmentId = row.id;
      }
      departmentsCreated++;
    }

    for (const roleName of def.roles) {
      if (!departmentId) {
        // dry-run with an uncreated department: still report the roles.
        console.log(`    + role ${roleName} (in new ${name})`);
        rolesCreated++;
        continue;
      }
      const roleExists = await sql`
        select 1 from roles
        where department_id = ${departmentId} and lower(name) = lower(${roleName}) and status = 'active'
        limit 1`;
      if (roleExists.length) continue;
      if (DRY_RUN) {
        console.log(`    + role ${roleName}`);
      } else {
        await sql`
          insert into roles (org_id, department_id, name, status)
          values (${ORG_ID}, ${departmentId}, ${roleName}, 'active')`;
      }
      rolesCreated++;
    }
  }

  console.log(
    `${DRY_RUN ? '[dry-run] would create' : 'Created'} ${departmentsCreated} departments, ${rolesCreated} roles.`,
  );
  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
