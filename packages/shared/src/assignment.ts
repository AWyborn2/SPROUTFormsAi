/**
 * WHO GETS ASSIGNED WHAT — the pure decision behind every path that assigns
 * (U11). Placement change, requirement change, import and the overdue sweep all
 * funnel through one function so the skip rule and the Location resolution are
 * defined once and cannot drift between callers (KTD16).
 *
 * There is NO database and NO clock here. Currency is decided by
 * `competency-expiry.ts` — the caller resolves each held competency to a
 * `CompetencyStatus` and passes it in — so this file never reads a date, and the
 * one place that answers "is this ticket still current" is not reimplemented.
 */
import { countsAsHeld, type CompetencyStatus } from './competency-expiry.js';
import { resolveLocationParts, type LocationPartKeys } from './assessment.js';

/** One tool a requirement names, with everything the decision reads. */
export interface AssignmentTool {
  toolId: string;
  /**
   * The competency ids passing this tool AWARDS. The skip rule reads them in
   * full: a case is created UNLESS the person already holds EVERY one, current
   * (R45). A tool that awards nothing is therefore vacuously satisfied and
   * assigns no case — tools are expected to award at least one competency.
   */
  awardedCompetencyIds: readonly string[];
  /** Every part key the manifest declares — the universe the parts rule selects from. */
  allPartKeys: readonly string[];
  /** The tool's parts rule (U9): Location id → the part keys required there. */
  locationPartKeys: LocationPartKeys;
  /**
   * The per-Location assessor rule: Location id → the extra competency ids an
   * assessor needs there. Only the location-specific half is carried, because
   * the always-required half is the same at every Location and cannot break a
   * tie (R59).
   */
  assessorStreamCompetencyIds: Readonly<Record<string, readonly string[]>>;
}

/** One competency the person holds, already resolved to its current status. */
export interface HeldCompetencyState {
  competencyId: string;
  status: CompetencyStatus;
}

export interface AssignmentInput {
  /**
   * The required tool ids of each Role the person holds, one array per Role. The
   * union across them is what the person is obliged to hold (R48); a Role with
   * no configured requirements contributes an empty array and so assigns nothing
   * (R49). Changing which Roles a person holds is passing a different set of
   * arrays (R51).
   */
  roleRequirements: readonly (readonly string[])[];
  /** The tools those requirements name, by id. A named tool absent here is skipped. */
  tools: Readonly<Record<string, AssignmentTool>>;
  /** The competencies the person holds, each with its current status (R45). */
  held: readonly HeldCompetencyState[];
  /**
   * The Location ids on the membership, in membership order (R60 reads the
   * first). At least one — U4's placement validator guarantees it, and with none
   * there is nowhere to place a case, so an empty list assigns nothing.
   */
  locationIds: readonly string[];
  /**
   * Tool ids for which the person ALREADY has an OPEN case. The second half of
   * the skip rule and the whole of idempotence (KTD16): a requirement stays
   * unmet while the competency is expired, so without this every sweep would
   * open a fresh duplicate case each run.
   */
  openCaseToolIds: readonly string[];
}

/** A case to create: which tool, and the Location it is assessed at. */
export interface AssignmentDecision {
  toolId: string;
  locationId: string;
}

/**
 * The Location a case records, by the three-step fall-through R58–R60.
 *
 *   R58 — the Location contributing the MOST required parts.
 *   R59 — a tie broken by the Location whose assessor requirement is MORE
 *         demanding (more location-specific competencies).
 *   R60 — still tied: the FIRST Location on the membership.
 *
 * With no parts rule declared anywhere, every Location contributes every part,
 * so step one ties for a multi-Location membership and — absent an assessor rule
 * to separate them — the decision lands on the first Location, which is the
 * ordinary path rather than an edge.
 */
function resolveCaseLocation(tool: AssignmentTool, locationIds: readonly string[]): string {
  const scored = locationIds.map((locationId, index) => ({
    locationId,
    index,
    parts: resolveLocationParts(tool.allPartKeys, tool.locationPartKeys, [locationId]).length,
    assessorDemand: (tool.assessorStreamCompetencyIds[locationId] ?? []).length,
  }));
  scored.sort(
    (a, b) => b.parts - a.parts || b.assessorDemand - a.assessorDemand || a.index - b.index,
  );
  // A non-empty list always has a first element; the caller guarantees one.
  return scored[0]!.locationId;
}

/**
 * The cases to create for one person. Empty when every requirement is already
 * met, already has an open case, or the person holds no Location.
 */
export function decideAssignments(input: AssignmentInput): AssignmentDecision[] {
  // Current tickets only: `expiring` and `grace` still count, `expired` and
  // `revoked` do not — the distinction competency-expiry already draws (R45,
  // R46, R107).
  const held = new Set(
    input.held.filter((h) => countsAsHeld(h.status)).map((h) => h.competencyId),
  );
  const openCases = new Set(input.openCaseToolIds);
  const requiredToolIds = new Set(input.roleRequirements.flat());

  const decisions: AssignmentDecision[] = [];
  for (const toolId of requiredToolIds) {
    // Idempotence (KTD16): never a second open case for the same tool.
    if (openCases.has(toolId)) continue;
    const tool = input.tools[toolId];
    if (!tool) continue;
    // R45: create UNLESS every awarded competency is already held and current.
    if (tool.awardedCompetencyIds.every((c) => held.has(c))) continue;
    // Nowhere to place a case — the precondition U4 enforces did not hold.
    if (input.locationIds.length === 0) continue;
    decisions.push({ toolId, locationId: resolveCaseLocation(tool, input.locationIds) });
  }
  return decisions;
}
