/**
 * Loading around the pure standing resolver (U16; extended for the
 * role-competency links round; scope-generalised by the requirement
 * inheritance round, U2).
 *
 * `packages/shared/src/standing.ts` decides required-vs-recommended-vs-optional
 * from what a person is obliged to hold; this reads that context from the
 * database. Nothing is stored — standing is recomputed on every read (KTD6),
 * so this is pure loading with no writes.
 *
 * A person's obligation is now the UNION over FOUR scopes (R2): what the org
 * requires of everyone, what each Location they are PLACED at requires, what
 * each Department they are placed in requires, and what each non-withdrawn
 * Role they hold requires. Location and Department follow placement, never
 * role-derivation (R3). Within the role scope, REQUIRED is still a DUAL READ
 * (KTD3): the union of (a) the legacy derivation — Role → required tools →
 * each tool's awarded competencies — and (b) direct `competency_requirements`
 * rows with tier 'required'; conversion moves a requirement from (a) to (b)
 * one tool at a time, and the union keeps it visible whichever side it lives
 * on. Legacy rows never existed at the other three scopes.
 *
 * The returned SHAPES are unchanged (KTD3): every production consumer does
 * only `has()`/`size`/iteration over the sets, so the four-scope expansion is
 * invisible to them. Provenance — WHICH scope produced a requirement (R5) —
 * is a sibling read (`competencySourcesFor`), used only by the surfaces that
 * render sources, so the hot batch reads never pay for name resolution.
 *
 * Batched by user because the two surfaces that show standing ask it
 * differently: a person's own record asks for one user, the holder register
 * asks for the many people who hold one competency. One query path serves both.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@formai/db';
import { requiredCompetencyIds } from '@formai/shared';
import { db } from '../db.js';

type Database = NonNullable<typeof db>;
/** The root client OR an open transaction — the reads run on either surface. */
export type Reader = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * The scope keys ONE membership's placement expands to (KTD3, R2). The org
 * scope is implicit — every membership of the org sits under it — so it
 * carries no key here; a resolver adds the org rows unconditionally.
 */
export interface MembershipScopeKeys {
  locationIds: string[];
  departmentIds: string[];
  roleIds: string[];
}

const emptyKeys = (): MembershipScopeKeys => ({ locationIds: [], departmentIds: [], roleIds: [] });

/**
 * Expand memberships to the scope keys their placement confers — one batched
 * read per placement table, so a hundred-member compliance pull is three
 * queries, not three hundred.
 *
 * RETIREMENT SPLIT (the U4-decided semantics, deliberate asymmetry):
 *   - A retired LOCATION or DEPARTMENT confers NOTHING — its requirements
 *     "stop applying" the moment the value retires, so the expansion joins
 *     the value's status and drops retired keys here, before any requirement
 *     row is read.
 *   - A retired-but-held ROLE keeps contributing exactly as shipped: role
 *     retirement withdraws nobody (the R119 posture — the withdrawal or
 *     transfer flow is what ends a holding), so the ONLY role filter is
 *     `withdrawnAt IS NULL` (R52). Adding a jobRoles.status filter here would
 *     silently release every holder of a retired role from its requirements.
 */
export async function scopeKeysForMemberships(
  reader: Reader,
  orgId: string,
  membershipIds: readonly string[],
): Promise<Map<string, MembershipScopeKeys>> {
  const unique = [...new Set(membershipIds)];
  const byMembership = new Map<string, MembershipScopeKeys>();
  for (const id of unique) byMembership.set(id, emptyKeys());
  if (unique.length === 0) return byMembership;

  const locRows = await reader.query.membershipLocations.findMany({
    where: inArray(schema.membershipLocations.membershipId, unique),
  });
  const deptRows = await reader.query.membershipDepartments.findMany({
    where: inArray(schema.membershipDepartments.membershipId, unique),
  });
  // Held Roles only — a withdrawn Role confers no requirement (R52). NO status
  // filter: retired-but-held keeps contributing (see the split above).
  const roleRows = await reader.query.membershipRoles.findMany({
    where: and(
      inArray(schema.membershipRoles.membershipId, unique),
      isNull(schema.membershipRoles.withdrawnAt),
    ),
  });

  // The retired-value filter, applied to the KEYS rather than the requirement
  // rows so every downstream read (standing, provenance, the assignment seam)
  // inherits one definition of "this scope still applies".
  const placedLocationIds = [...new Set(locRows.map((r) => r.locationId))];
  const activeLocationIds = new Set(
    placedLocationIds.length
      ? (
          await reader.query.locations.findMany({
            where: and(
              eq(schema.locations.orgId, orgId),
              inArray(schema.locations.id, placedLocationIds),
              eq(schema.locations.status, 'active'),
            ),
          })
        ).map((l) => l.id)
      : [],
  );
  const placedDepartmentIds = [...new Set(deptRows.map((r) => r.departmentId))];
  const activeDepartmentIds = new Set(
    placedDepartmentIds.length
      ? (
          await reader.query.departments.findMany({
            where: and(
              eq(schema.departments.orgId, orgId),
              inArray(schema.departments.id, placedDepartmentIds),
              eq(schema.departments.status, 'active'),
            ),
          })
        ).map((d) => d.id)
      : [],
  );

  for (const row of locRows) {
    if (!activeLocationIds.has(row.locationId)) continue;
    byMembership.get(row.membershipId)?.locationIds.push(row.locationId);
  }
  for (const row of deptRows) {
    if (!activeDepartmentIds.has(row.departmentId)) continue;
    byMembership.get(row.membershipId)?.departmentIds.push(row.departmentId);
  }
  for (const row of roleRows) {
    byMembership.get(row.membershipId)?.roleIds.push(row.roleId);
  }
  return byMembership;
}

/** The requirement rows of ONE tier, indexed by the scope key carrying them. */
export interface ScopeRequirementIndex {
  byRole: Map<string, string[]>;
  byLocation: Map<string, string[]>;
  byDepartment: Map<string, string[]>;
  /** Org-scope rows — the all-scope-columns-null shape, never a sentinel (KTD1). */
  orgCompetencyIds: string[];
}

/**
 * Read one tier's `competency_requirements` rows across every given scope key
 * plus the org scope. FOUR plain queries rather than one OR: each stays an
 * index-friendly single-scope predicate, and the org shape (all three scope
 * columns null) has no key to put in an inArray anyway. This is the ONE
 * definition of the four-scope read — standing (both tiers), provenance and
 * the assignment seam (via requirement-links) all union through it, so no two
 * consumers can disagree about which rows a scope contributes.
 */
export async function requirementIndexForScopes(
  reader: Reader,
  orgId: string,
  keys: {
    roleIds: readonly string[];
    locationIds: readonly string[];
    departmentIds: readonly string[];
  },
  tier: 'required' | 'recommended',
): Promise<ScopeRequirementIndex> {
  const index: ScopeRequirementIndex = {
    byRole: new Map(),
    byLocation: new Map(),
    byDepartment: new Map(),
    orgCompetencyIds: [],
  };
  const tierEq = eq(schema.competencyRequirements.tier, tier);

  if (keys.roleIds.length) {
    const rows = await reader.query.competencyRequirements.findMany({
      where: and(
        eq(schema.competencyRequirements.orgId, orgId),
        inArray(schema.competencyRequirements.roleId, [...keys.roleIds]),
        tierEq,
      ),
    });
    for (const row of rows) {
      if (row.roleId === null) continue; // unreachable: the inArray above is role-keyed; narrows the nullable column
      const list = index.byRole.get(row.roleId) ?? [];
      list.push(row.competencyId);
      index.byRole.set(row.roleId, list);
    }
  }
  if (keys.locationIds.length) {
    const rows = await reader.query.competencyRequirements.findMany({
      where: and(
        eq(schema.competencyRequirements.orgId, orgId),
        inArray(schema.competencyRequirements.locationId, [...keys.locationIds]),
        tierEq,
      ),
    });
    for (const row of rows) {
      if (row.locationId === null) continue; // unreachable, as above
      const list = index.byLocation.get(row.locationId) ?? [];
      list.push(row.competencyId);
      index.byLocation.set(row.locationId, list);
    }
  }
  if (keys.departmentIds.length) {
    const rows = await reader.query.competencyRequirements.findMany({
      where: and(
        eq(schema.competencyRequirements.orgId, orgId),
        inArray(schema.competencyRequirements.departmentId, [...keys.departmentIds]),
        tierEq,
      ),
    });
    for (const row of rows) {
      if (row.departmentId === null) continue; // unreachable, as above
      const list = index.byDepartment.get(row.departmentId) ?? [];
      list.push(row.competencyId);
      index.byDepartment.set(row.departmentId, list);
    }
  }
  // Org scope always reads — it applies to every membership unconditionally
  // (R2), and its shape is the CHECK-enforced all-null row (KTD1).
  const orgRows = await reader.query.competencyRequirements.findMany({
    where: and(
      eq(schema.competencyRequirements.orgId, orgId),
      isNull(schema.competencyRequirements.roleId),
      isNull(schema.competencyRequirements.locationId),
      isNull(schema.competencyRequirements.departmentId),
      tierEq,
    ),
  });
  index.orgCompetencyIds = orgRows.map((r) => r.competencyId);
  return index;
}

/** Union every membership's keys — the whole-batch id lists the scoped reads take.
 * Exported for requirement-change's removal compute and the batched tool
 * resolution (requirement-links), which take the same whole-batch union. */
export function unionKeys(keysByMembership: ReadonlyMap<string, MembershipScopeKeys>): MembershipScopeKeys {
  const all = emptyKeys();
  for (const keys of keysByMembership.values()) {
    all.roleIds.push(...keys.roleIds);
    all.locationIds.push(...keys.locationIds);
    all.departmentIds.push(...keys.departmentIds);
  }
  return {
    roleIds: [...new Set(all.roleIds)],
    locationIds: [...new Set(all.locationIds)],
    departmentIds: [...new Set(all.departmentIds)],
  };
}

/**
 * The shared HEAD of the three batched per-user reads (required, recommended,
 * provenance): resolve the given users' memberships, then expand each
 * membership's placement to its scope keys. Empty membershipRows is the
 * callers' early-return signal; the keys map is empty then, with no placement
 * query issued.
 *
 * MUST RUN INSIDE THE CALLER'S REPEATABLE-READ TRANSACTION — this is the KTD3
 * snapshot obligation, stated once. Conversion deletes a legacy
 * `role_required_assessments` row and inserts the direct link in one commit;
 * a location transfer moves placement rows; a scope save rewrites one
 * scope's requirement rows. Run on the root client, any of those commits
 * could land BETWEEN two of the reads and a requirement would be visible to
 * neither side — a person reading compliant for the duration of a request
 * purely because an admin clicked Accept at the wrong moment. A transaction
 * pins every read — the placement tables included, they joined the dual read
 * when scopes did — to one snapshot.
 *
 * REPEATABLE READ IS THE LOAD-BEARING HALF. Postgres defaults to READ
 * COMMITTED, where every statement takes a FRESH snapshot — the transaction
 * alone would be decorative. `repeatable read` fixes one snapshot for the
 * whole block, which is the guarantee KTD3 actually asks for. Safe to ask
 * for: these blocks only read, so they can never raise a serialization
 * failure of their own.
 */
async function membershipsWithScopeKeys(
  tx: Reader,
  orgId: string,
  userIds: readonly string[],
): Promise<{
  membershipRows: (typeof schema.memberships.$inferSelect)[];
  keysByMembership: Map<string, MembershipScopeKeys>;
}> {
  const membershipRows = await tx.query.memberships.findMany({
    where: and(
      eq(schema.memberships.orgId, orgId),
      inArray(schema.memberships.userId, [...userIds]),
    ),
  });
  if (membershipRows.length === 0) return { membershipRows, keysByMembership: new Map() };
  const keysByMembership = await scopeKeysForMemberships(
    tx,
    orgId,
    membershipRows.map((m) => m.id),
  );
  return { membershipRows, keysByMembership };
}

/**
 * The set of competency ids each given user is OBLIGED to hold — the full
 * four-scope union (R2): org rows, the rows of every Location and Department
 * they are placed at/in, everything a held Role requires DIRECTLY, plus
 * everything awarded by a tool a held Role still requires the legacy way. A
 * user with no membership or no applicable requirement maps to an empty set
 * rather than being absent, so a caller can look every user up.
 */
export async function requiredCompetencyIdsByUser(
  database: Database,
  orgId: string,
  userIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const uniqueUserIds = [...new Set(userIds)];
  const byUser = new Map<string, Set<string>>();
  for (const userId of uniqueUserIds) byUser.set(userId, new Set());
  if (uniqueUserIds.length === 0) return byUser;

  // ONE SNAPSHOT FOR EVERY SCOPE, at REPEATABLE READ — the KTD3 rationale
  // lives on `membershipsWithScopeKeys`, the shared head of all three reads.
  return database.transaction(
    async (tx) => {
      const { membershipRows, keysByMembership } = await membershipsWithScopeKeys(
        tx,
        orgId,
        uniqueUserIds,
      );
      if (membershipRows.length === 0) return byUser;
      const allKeys = unionKeys(keysByMembership);

      // Legacy half — ROLE scope only; legacy rows never lived anywhere else.
      const reqRows = allKeys.roleIds.length
        ? await tx.query.roleRequiredAssessments.findMany({
            where: and(
              eq(schema.roleRequiredAssessments.orgId, orgId),
              inArray(schema.roleRequiredAssessments.roleId, allKeys.roleIds),
            ),
          })
        : [];
      const toolIdsByRole = new Map<string, string[]>();
      for (const r of reqRows) {
        const list = toolIdsByRole.get(r.roleId) ?? [];
        list.push(r.toolId);
        toolIdsByRole.set(r.roleId, list);
      }
      const toolIds = [...new Set(reqRows.map((r) => r.toolId))];
      const toolRows = toolIds.length
        ? await tx.query.assessmentTools.findMany({
            where: and(
              eq(schema.assessmentTools.orgId, orgId),
              inArray(schema.assessmentTools.id, toolIds),
            ),
          })
        : [];
      const awardsByTool: Record<string, readonly string[]> = {};
      for (const t of toolRows) awardsByTool[t.id] = t.awardedCompetencyIds ?? [];

      // Direct half at every scope: tier 'required' links only. Recommended
      // NEVER enters this set — it is the never-enforced tier (R13), read by
      // its own sibling below.
      const direct = await requirementIndexForScopes(tx, orgId, allKeys, 'required');

      // Per membership: the UNION across every scope the membership is under.
      // A Set, so a competency several scopes name — or both halves name
      // during transition — counts once (AE4's read side, KTD2).
      for (const membership of membershipRows) {
        const keys = keysByMembership.get(membership.id) ?? emptyKeys();
        const requiredToolIds = [
          ...new Set(keys.roleIds.flatMap((roleId) => toolIdsByRole.get(roleId) ?? [])),
        ];
        const union = requiredCompetencyIds(requiredToolIds, awardsByTool);
        for (const roleId of keys.roleIds) {
          for (const competencyId of direct.byRole.get(roleId) ?? []) union.add(competencyId);
        }
        for (const locationId of keys.locationIds) {
          for (const competencyId of direct.byLocation.get(locationId) ?? []) union.add(competencyId);
        }
        for (const departmentId of keys.departmentIds) {
          for (const competencyId of direct.byDepartment.get(departmentId) ?? []) union.add(competencyId);
        }
        // Org scope is implicit: every membership of the org carries it (R2).
        for (const competencyId of direct.orgCompetencyIds) union.add(competencyId);
        byUser.set(membership.userId, union);
      }

      return byUser;
    },
    { isolationLevel: 'repeatable read' },
  );
}

/**
 * The set of competency ids each given user's scopes RECOMMEND — direct
 * `competency_requirements` rows with tier 'recommended' across the same four
 * scopes, nothing else. There is still no legacy half (the legacy world had
 * no recommended tier), but the old no-transaction exemption is DEAD (KTD3):
 * "single source" stopped being true the moment this read spanned the
 * placement tables and four requirement shapes — a location transfer or a
 * scope save committing mid-read could otherwise show half a world. Same
 * repeatable-read posture as the required sibling, same contract: every
 * requested userId is present, empty Set by default.
 */
export async function recommendedCompetencyIdsByUser(
  database: Database,
  orgId: string,
  userIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const uniqueUserIds = [...new Set(userIds)];
  const byUser = new Map<string, Set<string>>();
  for (const userId of uniqueUserIds) byUser.set(userId, new Set());
  if (uniqueUserIds.length === 0) return byUser;

  return database.transaction(
    async (tx) => {
      const { membershipRows, keysByMembership } = await membershipsWithScopeKeys(
        tx,
        orgId,
        uniqueUserIds,
      );
      if (membershipRows.length === 0) return byUser;
      const direct = await requirementIndexForScopes(
        tx,
        orgId,
        unionKeys(keysByMembership),
        'recommended',
      );

      for (const membership of membershipRows) {
        const keys = keysByMembership.get(membership.id) ?? emptyKeys();
        const set = new Set<string>();
        for (const roleId of keys.roleIds) {
          for (const competencyId of direct.byRole.get(roleId) ?? []) set.add(competencyId);
        }
        for (const locationId of keys.locationIds) {
          for (const competencyId of direct.byLocation.get(locationId) ?? []) set.add(competencyId);
        }
        for (const departmentId of keys.departmentIds) {
          for (const competencyId of direct.byDepartment.get(departmentId) ?? []) set.add(competencyId);
        }
        for (const competencyId of direct.orgCompetencyIds) set.add(competencyId);
        byUser.set(membership.userId, set);
      }
      return byUser;
    },
    { isolationLevel: 'repeatable read' },
  );
}

/** The required-competency set for one user — the single-user shape of the batch. */
export async function requiredCompetencyIdsFor(
  database: Database,
  orgId: string,
  userId: string,
): Promise<Set<string>> {
  const byUser = await requiredCompetencyIdsByUser(database, orgId, [userId]);
  return byUser.get(userId) ?? new Set();
}

/** The recommended-competency set for one user — the single-user shape of the batch. */
export async function recommendedCompetencyIdsFor(
  database: Database,
  orgId: string,
  userId: string,
): Promise<Set<string>> {
  const byUser = await recommendedCompetencyIdsByUser(database, orgId, [userId]);
  return byUser.get(userId) ?? new Set();
}

// ── provenance: WHICH scope produced a requirement (R5, KTD3) ────────────────

export type RequirementScope = 'org' | 'location' | 'department' | 'role';

/**
 * A requirement scope, ADDRESSED (KTD5/KTD6): which one scope a preview, an
 * apply or a route is talking about. The org scope carries no id — it is the
 * organisation itself, and rows at it are the all-null shape (KTD1) — so the
 * union is discriminated rather than a nullable id nobody could type-check.
 * Lives here, beside `RequirementScope`, because both requirement-change and
 * assignment speak it and each already imports this module.
 */
export type RequirementScopeRef =
  | { kind: 'org' }
  | { kind: 'location'; id: string }
  | { kind: 'department'; id: string }
  | { kind: 'role'; id: string };

/** One contributing scope, resolved to its display name. */
export interface CompetencySource {
  scope: RequirementScope;
  /** Null exactly at org scope — the org scope has no id of its own (KTD1). */
  scopeId: string | null;
  scopeName: string;
}

/** Both tiers' provenance for one user, keyed by competency id. */
export interface CompetencySourcesForUser {
  required: Map<string, CompetencySource[]>;
  recommended: Map<string, CompetencySource[]>;
}

/**
 * The `{scope, name}` wire shape the read surfaces render (R5, U8): the DTO
 * drops `scopeId` — screens caption with names, never ids — and the mapper
 * lives beside the source type so the three routes that serialise sources
 * (candidate record, compliance gaps, holders register) cannot each invent a
 * slightly different shape. `undefined` in maps to `[]` out, because a
 * competency the maps do not name simply has no contributing scope.
 */
export interface CompetencySourceRef {
  scope: RequirementScope;
  name: string;
}

export function sourceRefs(sources: readonly CompetencySource[] | undefined): CompetencySourceRef[] {
  return (sources ?? []).map((s) => ({ scope: s.scope, name: s.scopeName }));
}

/** Render order: broadest first, then by name so a rebuilt list reads identically. */
const SCOPE_RANK: Record<RequirementScope, number> = { org: 0, location: 1, department: 2, role: 3 };

const emptySources = (): CompetencySourcesForUser => ({ required: new Map(), recommended: new Map() });

/**
 * The provenance sibling of the standing reads (KTD3): per user, competencyId
 * → every scope that names it, with scope names resolved for rendering
 * ("Required — from <Location>", R5). ONE COMBINED READ for both tiers rather
 * than two functions, deliberately: the record page renders required and
 * recommended side by side, and two separate calls would be two snapshots — a
 * tier change (an UPDATE on the row, KTD1) committing between them could show
 * one competency in both tiers or neither. The tier split is structural (two
 * maps), not a field to filter.
 *
 * BATCHED BY USER (the U2-anticipated sibling) because compliance captions a
 * whole workforce's gap rows in one response (U8): the reads are set-wise over
 * the union of every user's scope keys — one query per table however many
 * users are asked about — and each user's sources are then assembled from
 * their OWN membership's keys, so u1's role never captions u2's record.
 *
 * The legacy derivation is provenance too: a pre-conversion tool requirement
 * is still a ROLE obligation, and R5 allows no requirement without a source,
 * so its awarded competencies carry the role as their source exactly like a
 * direct link. Sources are deduped per (scope, scopeId) and ordered broadest
 * scope first, then by name — deterministic, so preview and record agree.
 */
export async function competencySourcesByUser(
  database: Database,
  orgId: string,
  userIds: readonly string[],
): Promise<Map<string, CompetencySourcesForUser>> {
  return (await competencySourcesExpansionByUser(database, orgId, userIds)).sourcesByUser;
}

/**
 * The provenance batch PLUS the scope expansion it rode on. The maps' KEYS are
 * the standing sets themselves — the required map carries the legacy role
 * derivation exactly as `requiredCompetencyIdsByUser` does, the recommended
 * map mirrors its sibling — so a caller that needs sources AND the id sets
 * (compliance, the record reads) takes ONE org-wide expansion on one snapshot
 * instead of two or three.
 *
 * INTERNAL. `keysByMembership` used to be threaded out to compliance's
 * unplaced marker; that read moved to raw `membership_locations` because the
 * ASSIGNMENT ENGINE does not apply the expansion's retired-value filter, and a
 * marker derived from the filtered keys claimed "cannot be scheduled" about
 * members whose case was already booked. Nothing outside this module needs the
 * keys now — `competencySourcesByUser` is the exported shape.
 */
interface CompetencySourcesExpansion {
  sourcesByUser: Map<string, CompetencySourcesForUser>;
  /** membershipId → the scope keys the expansion used (retired values already dropped, U4). */
  keysByMembership: Map<string, MembershipScopeKeys>;
}

async function competencySourcesExpansionByUser(
  database: Database,
  orgId: string,
  userIds: readonly string[],
): Promise<CompetencySourcesExpansion> {
  const uniqueUserIds = [...new Set(userIds)];
  const byUser = new Map<string, CompetencySourcesForUser>();
  for (const userId of uniqueUserIds) byUser.set(userId, emptySources());
  if (uniqueUserIds.length === 0) return { sourcesByUser: byUser, keysByMembership: new Map() };

  // Same KTD3 posture as the batch reads (see `membershipsWithScopeKeys`): one
  // repeatable-read snapshot across placement, requirement, legacy and NAME
  // reads — a rename or transfer committing mid-read must not caption one
  // entry with the old world and the next with the new.
  return database.transaction(
    async (tx) => {
      const { membershipRows, keysByMembership } = await membershipsWithScopeKeys(
        tx,
        orgId,
        uniqueUserIds,
      );
      if (membershipRows.length === 0) return { sourcesByUser: byUser, keysByMembership };
      // The whole batch's keys — what the scoped reads and the name reads take.
      const keys = unionKeys(keysByMembership);

      const requiredIndex = await requirementIndexForScopes(tx, orgId, keys, 'required');
      const recommendedIndex = await requirementIndexForScopes(tx, orgId, keys, 'recommended');

      // Legacy half → role-sourced REQUIRED provenance.
      const reqRows = keys.roleIds.length
        ? await tx.query.roleRequiredAssessments.findMany({
            where: and(
              eq(schema.roleRequiredAssessments.orgId, orgId),
              inArray(schema.roleRequiredAssessments.roleId, keys.roleIds),
            ),
          })
        : [];
      const legacyToolIdsByRole = new Map<string, string[]>();
      for (const row of reqRows) {
        const list = legacyToolIdsByRole.get(row.roleId) ?? [];
        list.push(row.toolId);
        legacyToolIdsByRole.set(row.roleId, list);
      }
      const legacyToolIds = [...new Set(reqRows.map((r) => r.toolId))];
      const legacyTools = legacyToolIds.length
        ? await tx.query.assessmentTools.findMany({
            where: and(
              eq(schema.assessmentTools.orgId, orgId),
              inArray(schema.assessmentTools.id, legacyToolIds),
            ),
          })
        : [];
      const awardsByTool = new Map(legacyTools.map((t) => [t.id, t.awardedCompetencyIds ?? []]));

      // Names. Locations/departments in `keys` are active by construction (the
      // retired filter lives in the expansion); roles are read WITHOUT a
      // status filter — a retired-but-held role still contributes (U4 split)
      // and must still name itself.
      const orgRows = await tx.query.organizations.findMany({
        where: eq(schema.organizations.id, orgId),
      });
      const orgName = orgRows[0]?.name ?? '';
      const nameOf = async (
        table: 'locations' | 'departments' | 'jobRoles',
        ids: readonly string[],
      ): Promise<Map<string, string>> => {
        if (ids.length === 0) return new Map();
        const rows =
          table === 'locations'
            ? await tx.query.locations.findMany({
                where: and(eq(schema.locations.orgId, orgId), inArray(schema.locations.id, [...ids])),
              })
            : table === 'departments'
              ? await tx.query.departments.findMany({
                  where: and(
                    eq(schema.departments.orgId, orgId),
                    inArray(schema.departments.id, [...ids]),
                  ),
                })
              : await tx.query.jobRoles.findMany({
                  where: and(eq(schema.jobRoles.orgId, orgId), inArray(schema.jobRoles.id, [...ids])),
                });
        return new Map(rows.map((r) => [r.id, r.name]));
      };
      const locationNames = await nameOf('locations', keys.locationIds);
      const departmentNames = await nameOf('departments', keys.departmentIds);
      const roleNames = await nameOf('jobRoles', keys.roleIds);

      // Assemble PER MEMBERSHIP, from that membership's own keys — the batch
      // indexes cover everyone's scopes, and slicing by each member's keys is
      // what keeps one person's placement out of a colleague's captions.
      // Dedupe per (scope, scopeId) so the legacy half and a direct link on
      // the same role read as ONE source, then sort deterministically.
      const collect = (
        into: Map<string, CompetencySource[]>,
        competencyId: string,
        source: CompetencySource,
      ) => {
        const list = into.get(competencyId) ?? [];
        if (!list.some((s) => s.scope === source.scope && s.scopeId === source.scopeId)) {
          list.push(source);
        }
        into.set(competencyId, list);
      };
      const spread = (
        into: Map<string, CompetencySource[]>,
        index: ScopeRequirementIndex,
        memberKeys: MembershipScopeKeys,
      ) => {
        // Org scope is implicit — every membership of the org sits under it (R2).
        for (const competencyId of index.orgCompetencyIds) {
          collect(into, competencyId, { scope: 'org', scopeId: null, scopeName: orgName });
        }
        for (const locationId of memberKeys.locationIds) {
          for (const competencyId of index.byLocation.get(locationId) ?? []) {
            collect(into, competencyId, {
              scope: 'location',
              scopeId: locationId,
              scopeName: locationNames.get(locationId) ?? '',
            });
          }
        }
        for (const departmentId of memberKeys.departmentIds) {
          for (const competencyId of index.byDepartment.get(departmentId) ?? []) {
            collect(into, competencyId, {
              scope: 'department',
              scopeId: departmentId,
              scopeName: departmentNames.get(departmentId) ?? '',
            });
          }
        }
        for (const roleId of memberKeys.roleIds) {
          for (const competencyId of index.byRole.get(roleId) ?? []) {
            collect(into, competencyId, {
              scope: 'role',
              scopeId: roleId,
              scopeName: roleNames.get(roleId) ?? '',
            });
          }
        }
      };

      for (const membership of membershipRows) {
        // A user can hold several memberships; `collect` dedupes across them,
        // so the union of their keys assembles into one caption set.
        const result = byUser.get(membership.userId) ?? emptySources();
        byUser.set(membership.userId, result);
        const memberKeys = keysByMembership.get(membership.id) ?? emptyKeys();
        spread(result.required, requiredIndex, memberKeys);
        spread(result.recommended, recommendedIndex, memberKeys);
        // Legacy half → role-sourced REQUIRED provenance, from THIS member's
        // held roles only.
        for (const roleId of memberKeys.roleIds) {
          for (const toolId of legacyToolIdsByRole.get(roleId) ?? []) {
            for (const competencyId of awardsByTool.get(toolId) ?? []) {
              collect(result.required, competencyId, {
                scope: 'role',
                scopeId: roleId,
                scopeName: roleNames.get(roleId) ?? '',
              });
            }
          }
        }
      }

      for (const result of byUser.values()) {
        for (const map of [result.required, result.recommended]) {
          for (const list of map.values()) {
            list.sort(
              (a, b) =>
                SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] ||
                a.scopeName.localeCompare(b.scopeName) ||
                (a.scopeId ?? '').localeCompare(b.scopeId ?? ''),
            );
          }
        }
      }
      return { sourcesByUser: byUser, keysByMembership };
    },
    { isolationLevel: 'repeatable read' },
  );
}

/** The provenance for one user — the single-user shape of the batch. */
export async function competencySourcesFor(
  database: Database,
  orgId: string,
  userId: string,
): Promise<CompetencySourcesForUser> {
  const byUser = await competencySourcesByUser(database, orgId, [userId]);
  return byUser.get(userId) ?? emptySources();
}
