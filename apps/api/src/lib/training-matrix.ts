/**
 * TRAINING MATRIX ASSEMBLY (U2, KTD3) — the pure half of the matrix read:
 * batched rows in, the whole grid out, no database anywhere in this file.
 *
 * The matrix is the workforce × competency grid a training coordinator reads:
 * one row per member, one column per competency, every cell saying where that
 * person stands on that qualification. The ROUTE (U3) does the reads — members,
 * grants, the per-user standing maps, the org-wide awarding resolution — and
 * hands them here as plain data; this module only decides what each cell SAYS.
 * Splitting it out is what makes the cell rules testable without a database,
 * and is the same shape `packages/shared/src/standing.ts` takes for standing
 * itself: derivation is pure, loading lives elsewhere.
 *
 * NOTHING IS RE-DERIVED HERE (KTD6 discipline). Standing comes from the source
 * maps the resolver built (`competencySourcesByUser` — its keySets ARE the
 * standing sets, legacy role derivation and the four-scope union included), and
 * the awarding map comes from the KTD2 resolver. A withdrawn role or a retired
 * department has ALREADY been dropped by the expansion before this module runs;
 * consuming the maps as given is what keeps this grid, the compliance report
 * and the assignment engine telling one story — three surfaces re-deriving
 * obligation would be three chances to disagree.
 *
 * THE CELL RULES, stated once:
 *   - `null` means "nothing to say": the competency is neither required nor
 *     recommended of this person AND no grant confers anything (`bestCurrency`
 *     is null — no grants, or revoked-only). An EXPIRED optional grant is NOT
 *     null: the person held it and let it lapse, and the client renders
 *     lapsed-optional distinctly from never-relevant.
 *   - `status` is the BEST non-revoked grant's dated state (`bestCurrency` —
 *     the renewal rule: an old expired row beside a fresh held one reads held).
 *     Absent when nothing confers: a required competency never held, or held
 *     only by a revoked grant, renders as a GAP cell — standing present, no
 *     status — because revoked never counts (`countsAsHeld`, R106/R107).
 *   - `revoked: true` marks the revoked-only gap apart from never-held: the
 *     person DID hold it and an appeal or an admin took it away, which is a
 *     different conversation for the coordinator than "never trained".
 *   - `expiresAt` passes through the best grant's derived expiry (`expiryOf` —
 *     explicit date wins, else grant + validity) so the client can sort and
 *     colour by date without re-deriving the formula.
 *   - `evidence` names HOW the best COUNTING grant was earned — a case the
 *     product ran ('assessment'), a licence record ('licence'), a bulk import
 *     ('import') — omitted for a plain hand-recorded grant, and omitted
 *     entirely when nothing counts (an expired grant's provenance answers no
 *     question the gap cell asks).
 *   - `noAward: true` on a REQUIRED-GAP cell whose competency the awarding map
 *     does not name: evidence-only (R7) — no assessment exists to book, the
 *     gap clears by recording evidence, and the summary's "evidence-based gap"
 *     count (U4) reads exactly this flag.
 *
 * AUDIENCE IS ASSESSOR (`EXPIRY_WARNING_DAYS.assessor`, 90 days), matching
 * compliance.ts: the person reading this grid is planning other people's
 * bookings, which is precisely what the longer horizon exists for.
 *
 * `noLocationPlacement` is member-level and derives from RAW placement rows of
 * ANY status — the review-corrected compliance rule restated: the scope
 * expansion drops retired locations because a retired site confers no
 * requirements (the U4 split), but `decideAssignments` reads placement rows
 * unfiltered, so a member placed only at a retired site still gets a case
 * booked there. The flag claims "no case can be planned ANYWHERE", and it may
 * only be true when the membership has no placement rows at all — the route
 * passes raw-row presence in, and this module never second-guesses it.
 */
import {
  bestCurrency,
  competencyCurrency,
  countsAsHeld,
  expiryOf,
  standingOf,
  type CompetencyStatus,
  type HeldCompetency,
  type Standing,
} from '@formai/shared';

/** A competency column, as the route loaded it — validity included, because
 * currency is derived per grant against THIS competency's rules. */
export interface MatrixCompetency {
  id: string;
  name: string;
  /** Null for an internal competency that genuinely has no code — passed
   * through as-is, never an empty string. */
  code: string | null;
  validForMonths?: number | null;
  gracePeriodDays?: number | null;
}

/** A placement value resolved to its display name — names, never bare ids, on
 * anything a person reads (the role-scoped UI rule, PR #198). */
export interface MatrixNamedRef {
  id: string;
  name: string;
}

/** One member row's identity and placement metadata. The placement lists are
 * DISPLAY data only — standing comes exclusively from the source maps, so a
 * role listed here contributes no requirement by being listed. */
export interface MatrixMember {
  membershipId: string;
  userId: string;
  name: string;
  /** The membership's access level (owner/admin/member) — the row caption. */
  role: string;
  locations: MatrixNamedRef[];
  departments: MatrixNamedRef[];
  roles: MatrixNamedRef[];
  /**
   * Whether the membership has ANY raw `membership_locations` row, whatever
   * the location's status — the engine-shaped read (see the module docblock).
   * The route counts raw rows; retired placements COUNT.
   */
  hasPlacementRows: boolean;
}

/** The holder-row fields a cell needs: the currency inputs (`HeldCompetency`)
 * plus the provenance columns that decide the evidence kind. */
export interface MatrixGrant extends HeldCompetency {
  competencyId: string;
  sourceCaseId?: string | null;
  licenceNumber?: string | null;
  licenceClass?: string | null;
  importedAt?: Date | null;
}

/**
 * The standing sets for one user — structurally the resolver's
 * `CompetencySourcesForUser`: only the KEYS are read here (they ARE the
 * standing sets), so the value type is deliberately `unknown` and the
 * resolver's maps pass in unchanged. Typing the values would couple this pure
 * module to the provenance shape it never looks at.
 */
export interface MemberStandingSets {
  required: ReadonlyMap<string, unknown>;
  recommended: ReadonlyMap<string, unknown>;
}

export type MatrixEvidenceKind = 'assessment' | 'licence' | 'import';

/** One cell — see the module docblock for when each field appears. */
export interface TrainingMatrixCell {
  standing: Standing;
  status?: CompetencyStatus;
  expiresAt?: Date;
  revoked?: true;
  evidence?: MatrixEvidenceKind;
  noAward?: true;
}

export interface TrainingMatrixMemberRow {
  membershipId: string;
  userId: string;
  name: string;
  role: string;
  locations: MatrixNamedRef[];
  departments: MatrixNamedRef[];
  roles: MatrixNamedRef[];
  noLocationPlacement: boolean;
  /** Aligned to the payload's `competencies` — `cells[i]` speaks about
   * `competencies[i]`, which is what lets the client render columns without
   * a per-cell competency id repeated thousands of times. */
  cells: (TrainingMatrixCell | null)[];
}

export interface TrainingMatrixPayload {
  competencies: MatrixCompetency[];
  members: TrainingMatrixMemberRow[];
}

export interface TrainingMatrixInput {
  /** Column order as given — ordering is the route's decision, not assembly's. */
  competencies: readonly MatrixCompetency[];
  /** Row order as given, for the same reason. */
  members: readonly MatrixMember[];
  /** userId → the resolver's source maps (`competencySourcesByUser`). A user
   * absent from the map simply has no obligations — every cell reads optional. */
  standingByUser: ReadonlyMap<string, MemberStandingSets>;
  /** userId → that user's `competency_holders` rows, ungrouped — grouping by
   * competency happens here so the route can pass the query result straight in. */
  grantsByUser: ReadonlyMap<string, readonly MatrixGrant[]>;
  /** competencyId → awarding tool id, from the KTD2 resolver
   * (`awardingToolByCompetencyForOrg`). ABSENCE means evidence-only (R7). */
  awardingToolByCompetency: ReadonlyMap<string, string>;
  /** The one instant every cell is resolved at — a parameter, never the clock,
   * so two cells of one response cannot disagree about what "today" is. */
  now: Date;
}

const EMPTY_STANDING: MemberStandingSets = { required: new Map(), recommended: new Map() };

/** The provenance columns, ranked: a case the product ran outranks a licence
 * record outranks an import stamp — the same precedence an auditor gives them,
 * strongest evidence first. A plain hand-recorded grant has none. */
function evidenceKindOf(grant: MatrixGrant): MatrixEvidenceKind | undefined {
  if (grant.sourceCaseId) return 'assessment';
  if (grant.licenceNumber || grant.licenceClass) return 'licence';
  if (grant.importedAt) return 'import';
  return undefined;
}

/**
 * One cell of the grid — the whole of the cell rules in one place (see the
 * module docblock). Exported for the tests' sake and for any surface that
 * needs a single person × competency answer in the matrix's vocabulary.
 */
export function matrixCell(
  competency: MatrixCompetency,
  standing: Standing,
  grants: readonly MatrixGrant[],
  awardingToolByCompetency: ReadonlyMap<string, string>,
  now: Date,
): TrainingMatrixCell | null {
  // Assessor audience — the grid reader plans other people's bookings.
  const currencies = grants.map((g) => competencyCurrency(g, competency, now, 'assessor'));
  const best = bestCurrency(currencies);

  // Nothing required, nothing recommended, nothing conferred: nothing to say.
  // `bestCurrency` null covers both "no grants" and "revoked only" — a revoked
  // optional grant renders null too, because with no obligation there is no
  // gap for the revocation to explain.
  if (standing === 'optional' && !best) return null;

  const cell: TrainingMatrixCell = { standing };
  if (best) {
    cell.status = best.status;
    // The row that PRODUCED the best currency — `bestCurrency` skips revoked
    // rows, so matching on (non-revoked, same status) finds it; ties between
    // equal-status rows are broken by input order, deterministically.
    const bestRow = grants[currencies.findIndex((c) => !c.revoked && c.status === best.status)]!;
    const expiry = expiryOf(bestRow, competency);
    if (expiry) cell.expiresAt = expiry;
    if (countsAsHeld(best)) {
      const evidence = evidenceKindOf(bestRow);
      if (evidence) cell.evidence = evidence;
    }
  } else if (grants.length > 0) {
    // Grants exist but none confers — every one revoked. Marked apart from
    // never-held: "taken away" and "never trained" are different remedies.
    cell.revoked = true;
  }

  // The evidence-only gap (R7): required, not currently satisfied, and no
  // bookable assessment awards it — the summary's "clears by evidence" count.
  const isGap = !best || !countsAsHeld(best);
  if (standing === 'required' && isGap && !awardingToolByCompetency.has(competency.id)) {
    cell.noAward = true;
  }
  return cell;
}

/**
 * Assemble the whole grid. Pure: every read has already happened, and calling
 * this twice with the same input yields the same payload — which is also the
 * invariant the tests pin: `cells.length === competencies.length` on every row.
 */
export function assembleTrainingMatrix(input: TrainingMatrixInput): TrainingMatrixPayload {
  const members: TrainingMatrixMemberRow[] = input.members.map((member) => {
    const standing = input.standingByUser.get(member.userId) ?? EMPTY_STANDING;
    // The maps' keySets ARE the standing sets (competencySourcesByUser's
    // contract) — built once per member, not once per cell.
    const requiredSet = new Set(standing.required.keys());
    const recommendedSet = new Set(standing.recommended.keys());

    const grantsByCompetency = new Map<string, MatrixGrant[]>();
    for (const grant of input.grantsByUser.get(member.userId) ?? []) {
      const list = grantsByCompetency.get(grant.competencyId) ?? [];
      list.push(grant);
      grantsByCompetency.set(grant.competencyId, list);
    }

    return {
      membershipId: member.membershipId,
      userId: member.userId,
      name: member.name,
      role: member.role,
      locations: member.locations,
      departments: member.departments,
      roles: member.roles,
      // Raw-rows rule (module docblock): true ONLY with zero placement rows.
      noLocationPlacement: !member.hasPlacementRows,
      cells: input.competencies.map((competency) =>
        matrixCell(
          competency,
          standingOf(competency.id, requiredSet, recommendedSet),
          grantsByCompetency.get(competency.id) ?? [],
          input.awardingToolByCompetency,
          input.now,
        ),
      ),
    };
  });

  return { competencies: [...input.competencies], members };
}

/** Per-member row compliance, read off assembled cells. */
export interface MemberRequiredCounts {
  /** How many columns this person is REQUIRED to hold. */
  requiredTotal: number;
  /** How many of those currently count (`countsAsHeld` over the cell's status
   * — cells with a status are non-revoked by construction). */
  requiredHeld: number;
}

/**
 * Does one assembled cell currently SATISFY a requirement? The single reading
 * of "this cell counts", used by the per-row fraction below and the U4
 * member-set aggregates — stated once so the row header, the summary KPIs and
 * the sweep's snapshot cannot each re-decide what a satisfied cell is.
 *
 * A cell's status always comes from a NON-revoked grant (`bestCurrency` skips
 * revoked), so `revoked: false` here restates the construction rather than
 * assuming anything new; a status-less cell (never held, or revoked-only) is
 * simply not satisfied.
 */
export function cellCountsAsHeld(cell: TrainingMatrixCell): boolean {
  return cell.status !== undefined && countsAsHeld({ status: cell.status, revoked: false });
}

/**
 * The summary-oriented slice a row header shows ("7 / 9 required held").
 * Deliberately NOT the U4 aggregates — those sum across the org and live with
 * the summary unit; this is one row's fraction, derived from cells so it can
 * never disagree with what the row renders.
 */
export function requiredCounts(
  cells: readonly (TrainingMatrixCell | null)[],
): MemberRequiredCounts {
  let requiredTotal = 0;
  let requiredHeld = 0;
  for (const cell of cells) {
    if (!cell || cell.standing !== 'required') continue;
    requiredTotal += 1;
    if (cellCountsAsHeld(cell)) requiredHeld += 1;
  }
  return { requiredTotal, requiredHeld };
}

// ── the U4 member-set slice: ONE implementation for the route AND the sweep ──

/**
 * The batched reads a member-set compliance derivation consumes — the same
 * plain-data posture as `TrainingMatrixInput`, minus the display metadata a
 * grid needs and an aggregate does not. `awardingToolByCompetency` matters
 * only to a consumer that reads `noAward` off the cells (the summary's
 * evidence-only gap count); a counts-only caller (the sweep) passes an empty
 * map, because no COUNT below reads the flag.
 */
export interface MemberSetStandingInput {
  /** The member set, BY USER (one entry per person; duplicates collapse). */
  userIds: readonly string[];
  /** userId → the competency ids REQUIRED of them (`requiredCompetencyIdsByUser`). */
  requiredByUser: ReadonlyMap<string, ReadonlySet<string>>;
  competencyById: ReadonlyMap<string, MatrixCompetency>;
  grantsByUser: ReadonlyMap<string, readonly MatrixGrant[]>;
  awardingToolByCompetency: ReadonlyMap<string, string>;
  now: Date;
}

/** One member's REQUIRED standing, cell by cell — what every U4 aggregate folds over. */
export interface MemberRequiredStanding {
  userId: string;
  /** competencyId → this member's required-standing cell for it. Never null:
   * a required cell always has something to say (`matrixCell`'s contract). */
  cells: Map<string, TrainingMatrixCell>;
  /** Every required competency counts as held — the "fully compliant" bit. */
  compliant: boolean;
  /** The required competencies NOT currently satisfied — open required gaps. */
  gapCompetencyIds: string[];
}

/**
 * Resolve each member of a set to their required cells and gap list — the
 * shared derivation under `GET /training-summary` AND the sweep's daily
 * snapshot (U4). Both surfaces fold over THIS result, so a snapshot row and
 * the live KPI computed from the same data cannot disagree: there is exactly
 * one opinion of "compliant member" and "open required gap", and it is
 * `matrixCell` + `cellCountsAsHeld`, the same rules the matrix grid renders.
 *
 * A required competency the org no longer DEFINES still gaps: nobody can hold
 * a deleted competency current, the assignment engine treats it as unmet, and
 * `GET /compliance` reports it as never held — so a synthetic unnamed column
 * stands in rather than the requirement silently vanishing from the numbers.
 */
export function requiredStandingByMember(
  input: MemberSetStandingInput,
): Map<string, MemberRequiredStanding> {
  const byUser = new Map<string, MemberRequiredStanding>();
  for (const userId of input.userIds) {
    if (byUser.has(userId)) continue;
    const required = input.requiredByUser.get(userId) ?? new Set<string>();

    const grantsByCompetency = new Map<string, MatrixGrant[]>();
    for (const grant of input.grantsByUser.get(userId) ?? []) {
      const list = grantsByCompetency.get(grant.competencyId) ?? [];
      list.push(grant);
      grantsByCompetency.set(grant.competencyId, list);
    }

    const cells = new Map<string, TrainingMatrixCell>();
    const gapCompetencyIds: string[] = [];
    for (const competencyId of required) {
      const competency = input.competencyById.get(competencyId) ?? {
        id: competencyId,
        name: 'Unknown competency',
        code: null,
      };
      const cell = matrixCell(
        competency,
        'required',
        grantsByCompetency.get(competencyId) ?? [],
        input.awardingToolByCompetency,
        input.now,
      );
      if (!cell) continue; // unreachable: a required cell is never null
      cells.set(competencyId, cell);
      if (!cellCountsAsHeld(cell)) gapCompetencyIds.push(competencyId);
    }
    byUser.set(userId, {
      userId,
      cells,
      compliant: gapCompetencyIds.length === 0,
      gapCompetencyIds,
    });
  }
  return byUser;
}

/** The three numbers a `compliance_snapshots` row stores, and the summary's
 * headline KPI — named identically to the columns on purpose. */
export interface MemberSetComplianceCounts {
  /** Members whose every required competency counts as held. */
  compliantCount: number;
  /** Members in the set (by user). Zero members yields 0/0 — the client
   * renders 0%, never NaN, and no percentage is computed server-side. */
  memberCount: number;
  /** Open required gaps summed across the set. */
  requiredGapCount: number;
}

/**
 * Fold a set of member standings into the snapshot numbers. Takes standings
 * rather than raw reads so a caller slicing ONE org-wide derivation into many
 * scoped subsets (the sweep's per-location and per-department rows, the
 * summary's per-group bars) folds the same cells every time instead of
 * re-deriving them per scope.
 */
export function complianceCountsOf(
  standings: Iterable<MemberRequiredStanding>,
): MemberSetComplianceCounts {
  let compliantCount = 0;
  let memberCount = 0;
  let requiredGapCount = 0;
  for (const standing of standings) {
    memberCount += 1;
    if (standing.compliant) compliantCount += 1;
    requiredGapCount += standing.gapCompetencyIds.length;
  }
  return { compliantCount, memberCount, requiredGapCount };
}

/**
 * One pass over placement rows → users per scope id. Both the summary route
 * and the sweep chart per-scope compliance; a scan of the whole placement set
 * per scope is O(scopes × placements), so the grouping happens here, once,
 * and each scope's lookup is O(1). Sharing the pass also keeps the two
 * surfaces from drifting on who counts as "placed here".
 */
export function usersByScopeId<T extends { membershipId: string }>(
  placements: readonly T[],
  scopeIdOf: (row: T) => string,
  userOfMembership: ReadonlyMap<string, string>,
  includeUser?: (userId: string) => boolean,
): Map<string, Set<string>> {
  const users = new Map<string, Set<string>>();
  for (const row of placements) {
    const userId = userOfMembership.get(row.membershipId);
    if (!userId || (includeUser && !includeUser(userId))) continue;
    const scopeId = scopeIdOf(row);
    let set = users.get(scopeId);
    if (!set) {
      set = new Set();
      users.set(scopeId, set);
    }
    set.add(userId);
  }
  return users;
}
