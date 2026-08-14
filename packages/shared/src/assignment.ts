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

/** One competency the person holds, resolved to its currency (dated state + revoked). */
export interface HeldCompetencyState {
  competencyId: string;
  status: CompetencyStatus;
  /** Revoked beats the date: excluded from the held set regardless (R107). */
  revoked: boolean;
}

export interface AssignmentInput {
  /**
   * The required tool ids the person's scopes confer. HISTORICAL NAME, WIDER
   * MEANING since the requirement inheritance round (U3, KTD4): the arrays
   * once carried one Role each, but the caller now passes the flattened union
   * of the membership's WHOLE scope stack — org, placed Locations, placed
   * Departments, held Roles (R2) — usually as a single array. The name stays
   * because the engine has NEVER read the grouping: it unions everything
   * before deciding (see below), so per-role arrays and one flat array are
   * indistinguishable here, and renaming would touch every caller for zero
   * behaviour change. A scope with no requirements contributes nothing (R49);
   * changing what a person's placement confers is passing a different set
   * (R51).
   */
  roleRequirements: readonly (readonly string[])[];
  /** The tools those requirements name, by id. A named tool absent here is skipped. */
  tools: Readonly<Record<string, AssignmentTool>>;
  /** The competencies the person holds, each with its current status (R45). */
  held: readonly HeldCompetencyState[];
  /**
   * The Location ids on the membership, in membership order (R60 reads the
   * first). With none there is nowhere to place a case, so an empty list
   * assigns nothing — and that skip DELIBERATELY survives the scope rounds
   * (KTD4): a member with no location placement can still OWE an org or
   * department requirement, which stays visible through standing/compliance
   * while no case is planned. The gap names its own fix; it is never silently
   * met.
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
 * The projected effects of a retrospective change to a Role's requirements
 * (U12, reworked in COMPETENCY terms by the role-competency links round). ONE
 * function computes these and the write plan (KTD10): the preview returns them
 * and discards the plan, the apply returns them and executes it, so `created`
 * here equals the cases the apply inserts on unchanged data.
 *
 * The unit of change is now a COMPETENCY, not a tool: a Role's requirement is
 * a competency link, and an added competency plans a case only where the KTD2
 * resolver finds an awarding assessment — a licence-type competency with none
 * adds to required standing without creating anything.
 *
 * Union-by-presence, not a discriminated add/remove — the apply body is the full
 * desired set, so a single save can add one competency and drop another at
 * once, and `created` can be non-zero alongside the removal counters. The side
 * that does not apply reads 0/[].
 */
export interface RequiredAssessmentsChangeEffects {
  /** Competencies the change ADDS to the required tier (desired minus current). Empty on a pure removal. */
  addedCompetencyIds: string[];
  /**
   * Competencies the change REMOVES from required standing — dropped required
   * links plus the awards of any legacy tool row this change explicitly
   * removes (the awaitingLink exit, KTD9). Empty on a pure addition.
   */
  removedCompetencyIds: string[];
  /** Distinct current holders of the Role — a headcount, whichever way it changes (R82, R84, R85). */
  affected: number;
  /**
   * Assessment CASES the addition creates (R83, R84). Already past the skip rule,
   * so it is the holders left with an unmet requirement, not the headcount — and
   * on a multi-competency add it can exceed `affected`. Zero on a pure removal,
   * and never used to describe a removal (R85). An added competency with no
   * awarding assessment contributes nothing here (R7, R9 — evidence-only).
   */
  created: number;
  /**
   * Cases already in flight for a requirement this change drops that run to
   * completion rather than being cancelled (R55). Counts cases, not people.
   * Zero on a pure addition.
   */
  inFlightContinuing: number;
  /**
   * (holder, competency) standings that drop from required to optional (R56) —
   * a removed competency that no Role the holder still carries requires,
   * through EITHER source (direct link or remaining legacy derivation). Counts
   * pairs, not competencies. Zero on a pure addition.
   */
  competenciesDemoting: number;
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
  // revoked do not — the distinction competency-expiry already draws (R45, R46,
  // R107). `countsAsHeld` reads the dated state AND the revoked flag off each
  // resolved holder.
  const held = new Set(
    input.held.filter((h) => countsAsHeld(h)).map((h) => h.competencyId),
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
