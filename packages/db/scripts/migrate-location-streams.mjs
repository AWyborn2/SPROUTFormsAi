/**
 * U8 data migration — move the location axis from free-text streams to managed
 * Locations.
 *
 * Two things carried a stream NAME before U8 and must now carry a Location id:
 *
 *   1. assessment_tools.assessor_stream_competency_ids — a jsonb keyed by stream
 *      name (`{ "Mining": [...], "Raw Materials": [...] }`). The new resolver
 *      matches by Location id, so each name key is turned into the id of an
 *      active Location of that name (created if the org has none yet).
 *
 *   2. assessment_cases.location_stream — free text. Each non-empty value is
 *      resolved to a Location the same way and written to location_id. This step
 *      is skipped automatically once 0029 has dropped the column (nothing left
 *      to read); it is also a no-op on an org with no cases.
 *
 * Run it AFTER 0028 (which adds location_id) and BEFORE 0029 drops
 * location_stream — 0029 refuses to drop while any case still has a stream but
 * no location_id, so it is the backstop if this did not run. The tool re-key
 * reads a column 0029 never touches, so it is safe either side of the drop.
 *
 *   cd packages/db
 *   DATABASE_URL=... node scripts/migrate-location-streams.mjs             # all orgs
 *   DATABASE_URL=... node scripts/migrate-location-streams.mjs --org <uuid>
 *   DATABASE_URL=... node scripts/migrate-location-streams.mjs --dry-run
 *
 * IDEMPOTENT: a key that is already a Location id is left alone, Locations are
 * matched by name before being created, and a case that already has a
 * location_id is skipped — so re-running changes nothing.
 */
import postgres from 'postgres';

const args = process.argv.slice(2);
const orgIdx = args.indexOf('--org');
const ORG_ID = orgIdx > -1 ? args[orgIdx + 1] : null;
const DRY_RUN = args.includes('--dry-run');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s.trim());

let locationsCreated = 0;
let toolsRekeyed = 0;
let casesLinked = 0;

/** Find an active Location by name in the org, creating one if absent. */
async function resolveLocation(orgId, name, cache) {
  const key = name.trim().toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const [existing] = await sql`
    select id from locations
    where org_id = ${orgId} and lower(name) = ${key} and status = 'active'
    limit 1`;
  let id = existing?.id ?? null;
  if (!id) {
    locationsCreated++;
    if (DRY_RUN) {
      id = `(new:${name.trim()})`;
    } else {
      const [row] = await sql`
        insert into locations (org_id, name, status)
        values (${orgId}, ${name.trim()}, 'active')
        returning id`;
      id = row.id;
    }
  }
  cache.set(key, id);
  return id;
}

async function migrateOrg(orgId, orgName) {
  const cache = new Map(); // lower(name) -> location id
  const locs = await sql`
    select id, name from locations where org_id = ${orgId} and status = 'active'`;
  for (const l of locs) cache.set(l.name.trim().toLowerCase(), l.id);

  // 1) Re-key each tool's per-stream assessor requirements by Location id.
  const tools = await sql`
    select id, name, assessor_stream_competency_ids as ids
    from assessment_tools where org_id = ${orgId}`;
  for (const tool of tools) {
    const ids = tool.ids ?? {};
    const keys = Object.keys(ids);
    if (keys.length === 0 || keys.every(isUuid)) continue;

    const rekeyed = {};
    for (const k of keys) {
      const targetId = isUuid(k) ? k.trim() : await resolveLocation(orgId, k, cache);
      const arr = Array.isArray(ids[k]) ? ids[k] : [];
      // Two names collapsing to one Location (a case/spacing dup) merge rather
      // than clobber — the union is the only reading that loses no requirement.
      rekeyed[targetId] = rekeyed[targetId]
        ? Array.from(new Set([...rekeyed[targetId], ...arr]))
        : arr;
    }

    toolsRekeyed++;
    if (DRY_RUN) {
      console.log(
        `  tool "${tool.name}": ${JSON.stringify(keys)} -> ${JSON.stringify(Object.keys(rekeyed))}`,
      );
    } else {
      await sql`
        update assessment_tools set assessor_stream_competency_ids = ${sql.json(rekeyed)}
        where id = ${tool.id}`;
    }
  }

  // 2) Link existing cases — only while location_stream still exists.
  const [{ present } = { present: false }] = await sql`
    select exists (
      select 1 from information_schema.columns
      where table_name = 'assessment_cases' and column_name = 'location_stream'
    ) as present`;
  if (!present) return;

  const cases = await sql`
    select id, location_stream from assessment_cases
    where org_id = ${orgId}
      and location_stream is not null and location_stream <> ''
      and location_id is null`;
  for (const c of cases) {
    const locId = await resolveLocation(orgId, c.location_stream, cache);
    casesLinked++;
    if (DRY_RUN) {
      console.log(`  case ${c.id}: "${c.location_stream}" -> ${locId}`);
    } else {
      await sql`update assessment_cases set location_id = ${locId} where id = ${c.id}`;
    }
  }
}

async function main() {
  const orgs = ORG_ID
    ? await sql`select id, name from organizations where id = ${ORG_ID}`
    : await sql`select id, name from organizations order by created_at`;
  if (orgs.length === 0) {
    console.error(ORG_ID ? `No organisation ${ORG_ID}.` : 'No organisations.');
    process.exit(1);
  }

  for (const org of orgs) {
    console.log(`Migrating "${org.name}" (${org.id}).`);
    await migrateOrg(org.id, org.name);
  }

  console.log(
    `${DRY_RUN ? '[dry-run] would create/change' : 'Done'}: ` +
      `${locationsCreated} locations, ${toolsRekeyed} tools re-keyed, ${casesLinked} cases linked.`,
  );
  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
