import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Db } from '@formai/db';
import {
  blocksForOverflow,
  emptyOptionalProfileFields,
  type PlacementErrorCode,
  type SeatBlockPurchase,
  type Role,
  type ValidProfileRow,
} from '@formai/shared';
import { checkSeatAvailability, lockOrgForSeats, poolFor, type SeatOrg } from './seats.js';
import { writePlacement } from './membership-placement.js';
import { insertUserWithUsername } from './username.js';

/**
 * What a validated import row creates, and what a whole file will cost (R19,
 * R79, R80, R86).
 *
 * THE CONTRACT WITH THE SIBLING ARTIFACT. The upload surface, the file it reads
 * and the confirmation step belong to the Organisation Settings work; this
 * supplies what they call. Deliberately a library rather than a route.
 *
 * THE THREE BRANCHES, and they differ in what they cost:
 *  - an address naming nobody      → create the person, issue a username, create
 *                                    an ACTIVE membership; one seat
 *  - an address naming somebody
 *    with no membership here       → add one; one seat
 *  - a DEACTIVATED membership      → return it to active; one seat, and the
 *                                    competencies deactivation retained come
 *                                    back (R19, R78)
 *  - an ACTIVE membership          → keep it; NO seat, and every difference is
 *                                    REPORTED rather than written
 *
 * The last is the one worth stating twice: an import must not be able to demote
 * an administrator to a candidate on the strength of a column.
 *
 * NO INVITATION AND NO LOGIN. A landed row makes somebody a MEMBER; an
 * invitation is how a person reaches the product, which is a different act
 * (R19, R80).
 */

/** The organisation's already-issued numbers, for the validator's uniqueness check (R7). */
export interface HeldIdentifiers {
  employeeNumbers: Set<string>;
  swipeCardNumbers: Set<string>;
}

/**
 * Every workforce number already issued in the organisation, lowercased to match
 * the profile's case-folded partial unique indexes.
 *
 * Fed into `validateWorkforceImport`'s context so a clash is a named rejection
 * on the preview rather than a failed insert part-way through the run.
 */
export async function loadHeldIdentifiers(db: Db, orgId: string): Promise<HeldIdentifiers> {
  const rows = await db.query.memberProfiles.findMany({
    where: eq(schema.memberProfiles.orgId, orgId),
  });
  const employeeNumbers = new Set<string>();
  const swipeCardNumbers = new Set<string>();
  for (const row of rows) {
    if (row.employeeNumber) employeeNumbers.add(row.employeeNumber.toLowerCase());
    if (row.swipeCardNumber) swipeCardNumbers.add(row.swipeCardNumber.toLowerCase());
  }
  return { employeeNumbers, swipeCardNumbers };
}

/** What one row will do, before anything is written. */
export type RowDisposition =
  /** No person with this address — create everything. Costs a seat. */
  | 'create'
  /** The person exists but holds no membership here — add one. Costs a seat. */
  | 'add_membership'
  /** They hold a deactivated membership here — return it to active. Costs a seat (R78). */
  | 'reactivate'
  /** They are already an active member — keep it, report differences, cost nothing. */
  | 'merge'
  /**
   * A second (or later) row for an address an EARLIER row in this file already
   * handled. Costs nothing and does nothing on landing — the first row is what
   * created or matched the person (R1: one membership per person per org). Kept
   * distinct from `merge` so the run does not try to diff or land it against ids
   * the first occurrence may not have produced yet.
   */
  | 'duplicate';

export interface ResolvedRow {
  row: ValidProfileRow;
  disposition: RowDisposition;
  /** Null on `create`. */
  userId: string | null;
  /** Set on `reactivate` and `merge`. */
  membershipId: string | null;
  /** Which pool this row draws on, or null when it costs nothing. */
  pool: 'staff' | 'candidate' | null;
}

/**
 * Resolve every row against the people and memberships that already exist.
 *
 * ONE pass shared by the preview and the run, which is what keeps them from
 * disagreeing about what a file costs. Deduplicates by address within the file:
 * the same person twice is one seat, not two — R1 admits one membership per
 * person per organisation, so the second occurrence resolves against what the
 * first will have created.
 */
export async function resolveRows(db: Db, orgId: string, rows: readonly ValidProfileRow[]): Promise<ResolvedRow[]> {
  const addresses = [...new Set(rows.map((r) => r.email.toLowerCase()))];
  // Compare case-insensitively: users.email is stored as entered (never
  // normalised on write), so a raw `email IN (...)` of lowercased addresses
  // misses an existing member whose stored address has any capital — resolving
  // them to `create` and forking a second users row for the same person. Mirror
  // the `lower(email)` comparison team.ts and invites.ts already use.
  const users = addresses.length
    ? await db.query.users.findMany({ where: inArray(sql`lower(${schema.users.email})`, addresses) })
    : [];
  const userByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));

  const memberships = users.length
    ? await db.query.memberships.findMany({
        where: and(
          eq(schema.memberships.orgId, orgId),
          inArray(
            schema.memberships.userId,
            users.map((u) => u.id),
          ),
        ),
      })
    : [];
  const membershipByUser = new Map(memberships.map((m) => [m.userId, m]));

  /** Addresses an earlier row in this file already accounted for. */
  const seen = new Set<string>();
  const resolved: ResolvedRow[] = [];

  for (const row of rows) {
    const key = row.email.toLowerCase();
    const user = userByEmail.get(key);
    const membership = user ? membershipByUser.get(user.id) : undefined;

    let disposition: RowDisposition;
    if (!user) disposition = 'create';
    else if (!membership) disposition = 'add_membership';
    else if (membership.status === 'active') disposition = 'merge';
    else disposition = 'reactivate';

    /*
      A repeat of an address an earlier row already handled costs nothing more
      and does nothing on landing — the first row is what created or matched the
      person. It is a DUPLICATE, not a merge: a first occurrence resolving to
      `create`/`add_membership` has produced no user/membership id yet, so
      calling it a merge (which lands and diffs against those ids) would deref
      nulls. Counting it again would also over-state the bill.
    */
    const repeated = seen.has(key);
    if (repeated) disposition = 'duplicate';
    seen.add(key);

    resolved.push({
      row,
      disposition,
      userId: user?.id ?? null,
      membershipId: membership?.id ?? null,
      pool: disposition === 'merge' || disposition === 'duplicate' ? null : poolFor(row.role),
    });
  }
  return resolved;
}

// ── The cost preview (R80, R86) ─────────────────────────────────────────────

export interface PoolCost {
  /** Seats this file needs in the pool. */
  needed: number;
  /** Seats the organisation's allocation still has free, or null when unlimited. */
  available: number | null;
  /** What the allocation covers of `needed`. */
  covered: number;
  /** What it does not — zero when the pool is unlimited. */
  overflow: number;
}

export interface ImportCostPreview {
  candidate: PoolCost;
  staff: PoolCost;
  /**
   * Blocks the candidate overflow would buy, at the automatic size (KTD27).
   *
   * EMPTY while U37 has not landed: expansion does not exist yet, so an
   * overflowing row is refused rather than bought for. R86 makes the run proceed
   * only once the Admin confirms, and the preview is what that confirmation is
   * given against — quoting blocks the run cannot buy would have them authorise
   * a purchase and receive a pile of rejections instead.
   */
  blocks: SeatBlockPurchase[];
  /** Rows the run will refuse for want of a seat, while expansion does not exist. */
  refusedForSeats: number;
}

/**
 * Whether automatic expansion exists yet (U37).
 *
 * Read rather than assumed so the preview and the run agree in BOTH windows —
 * before U37 the preview promises refusals and the run delivers them; after it,
 * the same preview promises blocks. Flipped to `true` by U37.
 */
export const AUTOMATIC_EXPANSION_AVAILABLE = false;

function poolCost(needed: number, limit: number | null, used: number): PoolCost {
  if (limit === null) return { needed, available: null, covered: needed, overflow: 0 };
  const available = Math.max(0, limit - used);
  const covered = Math.min(needed, available);
  return { needed, available, covered, overflow: needed - covered };
}

/**
 * What a file will cost in BOTH pools, before any of it is written (R80, R86).
 *
 * Counts SEATS, not rows, which is the distinction that decides whether a real
 * file is priced correctly: a row merging onto an already-active membership
 * costs nothing, a row matching a deactivated membership costs one, and the same
 * address twice costs one in total. A customer whose assessors already hold
 * logins is exactly the file this exists for, and a count of rows would
 * over-state their bill — getting runs abandoned, or overflow authorised that
 * the run never spends.
 *
 * Reports the two pools separately because R19 lets every row name its own
 * access level, so one figure would cover only part of what the file spends.
 */
export async function previewImportCost(
  db: Db,
  org: SeatOrg,
  rows: readonly ValidProfileRow[],
): Promise<ImportCostPreview> {
  const resolved = await resolveRows(db, org.id, rows);

  let candidateNeeded = 0;
  let staffNeeded = 0;
  for (const r of resolved) {
    if (r.pool === 'candidate') candidateNeeded++;
    else if (r.pool === 'staff') staffNeeded++;
  }

  // The same counting the binding check does, so the quote and the enforcement
  // read one rule.
  const candidateCheck = await checkSeatAvailability(db, org, 'candidate');
  const staffCheck = await checkSeatAvailability(db, org, 'assessor');

  const candidate = poolCost(candidateNeeded, candidateCheck.limit, candidateCheck.used);
  const staff = poolCost(staffNeeded, staffCheck.limit, staffCheck.used);

  return {
    candidate,
    staff,
    blocks: AUTOMATIC_EXPANSION_AVAILABLE ? blocksForOverflow(candidate.overflow) : [],
    /*
      The staff pool never expands (KTD27), so its overflow is always a refusal.
      The candidate pool's is one too until U37 lands.
    */
    refusedForSeats: staff.overflow + (AUTOMATIC_EXPANSION_AVAILABLE ? 0 : candidate.overflow),
  };
}

// ── Landing one row (R19) ───────────────────────────────────────────────────

export type LandingOutcome =
  | { kind: 'created' | 'added' | 'reactivated'; userId: string; membershipId: string; incomplete: string[] }
  | { kind: 'merged'; userId: string; membershipId: string; differences: RowDifference[] }
  /** A repeat of an address an earlier row already handled — nothing written. */
  | { kind: 'duplicate' }
  | { kind: 'refused'; reason: 'seat_limit_reached'; pool: 'staff' | 'candidate' }
  /**
   * The placement the file names is no longer valid against the org's active
   * taxonomy — a Location, Department or Role retired between the preview and the
   * run (R119). Refused rather than landed unplaced; the run reports the code.
   */
  | { kind: 'refused'; reason: 'placement_invalid'; code: PlacementErrorCode; subjectId?: string };

/** A value the row carries that the existing active membership does not (R19). */
export interface RowDifference {
  field: 'accessLevel' | 'locations' | 'departments' | 'roles';
  existing: string;
  fromFile: string;
}

export interface ProfileSeed {
  firstName: string;
  lastName: string;
  [key: string]: unknown;
}

/**
 * Land one validated row.
 *
 * Runs in ONE transaction so a refused row leaves no person, no membership and
 * no profile behind — half a person is worse than none, and the run reports the
 * refusal rather than failing the file.
 *
 * The seat check is `lockOrgForSeats` then `checkSeatAvailability`, the binding
 * pair the rest of the product goes through: a run that bypassed it would walk
 * straight past the caps the preview quoted, and two runs against the same last
 * seat would both take it.
 */
/**
 * A placement that no longer validates, thrown to roll the whole row back from
 * inside its transaction and translated into a `placement_invalid` refusal
 * outside it. `writePlacement` returns rather than throws, so without this a
 * refusal would be silently dropped and the member landed active but unplaced.
 */
class PlacementRefusedError extends Error {
  constructor(readonly refusal: { code: PlacementErrorCode; subjectId?: string }) {
    super('placement_invalid');
    this.name = 'PlacementRefusedError';
  }
}

export async function landImportRow(
  db: Db,
  orgId: string,
  resolved: ResolvedRow,
  profile: ProfileSeed,
): Promise<LandingOutcome> {
  const { row, disposition } = resolved;

  if (disposition === 'duplicate') {
    // An address an earlier row already handled: the first row did the work.
    return { kind: 'duplicate' };
  }

  if (disposition === 'merge') {
    // Costs no seat and writes no placement: report the differences instead.
    const differences = await differencesAgainst(db, resolved);
    return { kind: 'merged', userId: resolved.userId!, membershipId: resolved.membershipId!, differences };
  }

  try {
    return await db.transaction(async (tx) => {
      const org = await lockOrgForSeats(tx, orgId);
      if (org) {
        const check = await checkSeatAvailability(tx, org, row.role);
        if (!check.ok) {
          // Rolls back to nothing; the run reports it and continues (R170).
          return { kind: 'refused', reason: 'seat_limit_reached', pool: check.pool } as const;
        }
      }

      let userId = resolved.userId;
      if (!userId) {
        // R21: issued in the same transaction as the row it belongs to.
        const created = await insertUserWithUsername(
          tx,
          { name: row.name, email: row.email },
          { firstName: profile.firstName, lastName: profile.lastName },
        );
        userId = created.id;
      }

      let membershipId = resolved.membershipId;
      if (membershipId) {
        // R19/R78: a row asserting somebody is part of the workforce being
        // imported is an assertion that they are back. The competencies
        // deactivation retained need no action — nothing revoked them (R63, R69).
        await tx
          .update(schema.memberships)
          .set({ status: 'active', role: row.role })
          .where(eq(schema.memberships.id, membershipId));
      } else {
        const [created] = await tx
          .insert(schema.memberships)
          // ACTIVE immediately: an import creates members, not invitations (R80).
          .values({ orgId, userId, role: row.role, status: 'active' })
          .returning();
        membershipId = created!.id;
      }

      /*
        The SAME writer the team screen places through (R155), so an import
        cannot land a placement the screen would refuse. It opens a nested
        transaction, which Postgres runs as a savepoint inside ours — the row
        still lands or rolls back whole. It RETURNS a refusal rather than
        throwing when the active taxonomy no longer admits the placement (a
        Location/Department/Role retired since the preview, R119); throw it so
        this row rolls back whole rather than committing a member with no
        placement, and the run reports the code.
      */
      const placement = await writePlacement(tx, orgId, membershipId, {
        locationIds: row.locationIds,
        departmentIds: row.departmentIds,
        roleIds: row.roleIds,
      });
      if (!placement.ok) throw new PlacementRefusedError(placement.error);

      const values = {
        ...profile,
        employeeNumber: row.employeeNumber.trim() || null,
        swipeCardNumber: row.swipeCardNumber.trim() || null,
      };
      /*
        A reactivated or re-imported member already carries a profile row —
        deactivation never deletes it (R63) — so a bare INSERT hits
        member_profiles_membership_uq. Upsert refreshes the existing row from the
        file instead of failing the run.
      */
      await tx
        .insert(schema.memberProfiles)
        .values({ orgId, membershipId, ...values } as typeof schema.memberProfiles.$inferInsert)
        .onConflictDoUpdate({
          target: schema.memberProfiles.membershipId,
          set: values as Partial<typeof schema.memberProfiles.$inferInsert>,
        });

      return {
        kind: resolved.disposition === 'create' ? 'created' : resolved.disposition === 'reactivate' ? 'reactivated' : 'added',
        userId,
        membershipId,
        /*
          R19: a row that lands with optional fields empty is FLAGGED naming
          exactly what it left empty, rather than having whoever ran the import
          invent demographic answers for a worker they may never speak to.
        */
        incomplete: emptyOptionalProfileFields(values),
      } as const;
    });
  } catch (e) {
    if (e instanceof PlacementRefusedError) {
      return { kind: 'refused', reason: 'placement_invalid', code: e.refusal.code, subjectId: e.refusal.subjectId };
    }
    throw e;
  }
}

/** What the row says that the existing active membership does not (R19). */
async function differencesAgainst(db: Db, resolved: ResolvedRow): Promise<RowDifference[]> {
  const membership = await db.query.memberships.findFirst({
    where: eq(schema.memberships.id, resolved.membershipId!),
  });
  const differences: RowDifference[] = [];
  if (membership && membership.role !== resolved.row.role) {
    differences.push({
      field: 'accessLevel',
      existing: membership.role,
      fromFile: resolved.row.role as Role,
    });
  }

  const [locations, departments, roles] = await Promise.all([
    db.query.membershipLocations.findMany({
      where: eq(schema.membershipLocations.membershipId, resolved.membershipId!),
    }),
    db.query.membershipDepartments.findMany({
      where: eq(schema.membershipDepartments.membershipId, resolved.membershipId!),
    }),
    db.query.membershipRoles.findMany({
      where: eq(schema.membershipRoles.membershipId, resolved.membershipId!),
    }),
  ]);

  const compare = (
    field: RowDifference['field'],
    existing: readonly string[],
    fromFile: readonly string[],
  ) => {
    const a = [...existing].sort().join(',');
    const b = [...fromFile].sort().join(',');
    if (a !== b) differences.push({ field, existing: a, fromFile: b });
  };
  compare('locations', locations.map((l) => l.locationId), resolved.row.locationIds);
  compare('departments', departments.map((d) => d.departmentId), resolved.row.departmentIds);
  compare('roles', roles.map((r) => r.roleId), resolved.row.roleIds);

  return differences;
}
