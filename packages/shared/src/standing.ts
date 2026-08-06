/**
 * COMPETENCY STANDING — required or optional, derived from the Roles a person
 * holds right now (U16). It answers a DIFFERENT question from currency: currency
 * asks "is this ticket still in date", standing asks "is this person obliged to
 * hold it at all". A person can hold a current ticket they no longer need
 * (optional, current) or let a required one lapse (required, expired), and the
 * two facts must never be conflated into one predicate — a prerequisite check
 * reads currency alone, so an optional-but-current ticket still satisfies it
 * (R105), and compliance reads standing alone, so only a REQUIRED ticket counts
 * against a person when it lapses (R101).
 *
 * NOTHING IS STORED (KTD6). Standing is a pure function of the Roles held and
 * what those Roles require, recomputed on every read. That is what makes R92
 * free: a competency stops being required the moment no held Role requires it,
 * with no write, no delete and no revoke — the record stays exactly as granted
 * and only its DERIVED label changes.
 */

/** Whether a held competency is one the person's Roles oblige them to hold. */
export type Standing = 'required' | 'optional';

export interface StandingInput {
  /**
   * The competency ids the person HOLDS. Standing is resolved for each of these;
   * a competency nobody holds has no standing to report.
   */
  heldCompetencyIds: readonly string[];
  /**
   * The tool ids required by the Roles the person currently holds. WITHDRAWN
   * Roles are excluded BY THE CALLER (R52, R90) — this resolver never sees them,
   * so a withdrawn Role contributes nothing by construction. The union across
   * held Roles is the obligation (R48); a Role requiring nothing simply adds no
   * ids.
   */
  requiredToolIds: readonly string[];
  /**
   * toolId → the competency ids that tool AWARDS. A required tool absent from
   * this map awards nothing, which is the same as a tool that awards nothing:
   * it makes no competency required.
   */
  awardsByTool: Readonly<Record<string, readonly string[]>>;
}

/**
 * The competencies a person is OBLIGED to hold: everything awarded by any tool
 * their held Roles require. This is the whole of standing — a held competency is
 * required iff it is in this set, optional otherwise.
 */
export function requiredCompetencyIds(
  requiredToolIds: readonly string[],
  awardsByTool: Readonly<Record<string, readonly string[]>>,
): Set<string> {
  const required = new Set<string>();
  for (const toolId of requiredToolIds) {
    for (const competencyId of awardsByTool[toolId] ?? []) required.add(competencyId);
  }
  return required;
}

/**
 * The standing of one competency against a pre-computed required set. Split out
 * so a caller resolving many competencies against the same obligation builds the
 * set once.
 */
export function standingOf(competencyId: string, required: ReadonlySet<string>): Standing {
  return required.has(competencyId) ? 'required' : 'optional';
}

/**
 * Standing for every held competency: required if some held Role requires a tool
 * that awards it (R88, R90), optional otherwise (R91, R93). A competency that WAS
 * required reads optional here the moment the Role requiring it is no longer held
 * — the derivation says so, and nothing is deleted or revoked to make it happen
 * (R92).
 */
export function resolveStanding(input: StandingInput): Record<string, Standing> {
  const required = requiredCompetencyIds(input.requiredToolIds, input.awardsByTool);
  const out: Record<string, Standing> = {};
  for (const competencyId of input.heldCompetencyIds) {
    out[competencyId] = standingOf(competencyId, required);
  }
  return out;
}
