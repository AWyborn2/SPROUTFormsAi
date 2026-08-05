/**
 * Which competencies an assessor needs for ONE case.
 *
 * THE RULE IS NOT A FLAT LIST. The Track Dozer document names its assessors as
 * "an Appointed Training Dept Trainer or Worsley Assessor who holds the
 * following qualifications", and the qualifications are:
 *
 *   Q34666893  ATO Track Dozer                      — the category of assessment
 *   Q50071833  Worsley Assessor Skill Set           — MINING assessments
 *   Q50073293  Authority to Assess Mobile Equipment — RAW MATERIALS assessments
 *
 * so the real requirement is `Q34666893 AND (Q50071833 OR Q50073293)`, and the
 * OR is not a free choice between equals — it is decided by WHERE the
 * assessment happens.
 *
 * A single AND list gets this wrong in both directions. Listing all three
 * demands a combination nobody holds, so every case opens carrying a warning
 * that can never be satisfied and assessors learn to ignore the whole class of
 * warning. Listing one accepts an assessor authorised for the other site, which
 * is the failure that actually matters: a Raw Materials ticket signed off by
 * someone whose authority covers the mine.
 *
 * Rather than a general expression language, the requirement is split in two —
 * what is needed everywhere, and what is needed at a particular location. That
 * covers the rule the customer stated without inventing a grammar nobody has
 * asked for, and each half stays something an admin can read.
 */

/** What a tool declares its assessors must hold. */
export interface AssessorRequirements {
  /** Required at every Location. */
  always: readonly string[];
  /**
   * Extra requirements per Location, keyed by the LOCATION ID (U8). A case
   * records a `location_id` chosen from the organisation's managed list, and
   * the rule is keyed by the same ids, so a rule and a case cannot name the
   * same site two ways — an id is an exact match or it is absent (R79). Before
   * U8 these keys were free-text stream names matched by normalisation; now
   * that a value is chosen from a list rather than typed, a near-miss is
   * impossible and the match is a plain lookup.
   */
  byStream?: Readonly<Record<string, readonly string[]>>;
}

/**
 * How much of the requirement it was possible to check.
 *
 * `unrecognised` is gone (U8): a Location id is either present or absent, never
 * a near-miss spelling, so a case that records a Location the tool has no rule
 * for is `matched` with the always-required half — a tool with no
 * location-specific requirement there, not a value that failed to resolve. The
 * only remaining partial check is a case that records no Location at all.
 */
export type StreamCheck =
  /** This tool's requirement does not depend on Location. Nothing to check. */
  | 'not_applicable'
  /** The location-specific half was resolved (whether or not the tool has a rule at this Location). */
  | 'matched'
  /** The tool varies by Location and the case records none. */
  | 'missing';

/** What the requirements resolve to for one case. */
export interface ResolvedAssessorRequirements {
  /** Every competency id this case's assessor must hold. */
  required: string[];
  /**
   * Whether the location-specific half was actually checked.
   *
   * A caller that ignored this would present a partial check as a complete one,
   * which on a competency record is worse than saying plainly that something
   * could not be verified.
   */
  streamCheck: StreamCheck;
  /** The Location ids this tool declares a rule for, for offering as choices. */
  knownLocationIds: string[];
}

/**
 * Resolve a tool's assessor requirements against one case's Location id.
 *
 * A Location id chosen from the organisation's list cannot be a near-miss, so a
 * value outside the rule's keys is a Location the tool simply has no extra
 * requirement for — the always-required half applies and nothing is skipped
 * silently. The only thing that leaves the location-specific half unchecked is
 * a case that records no Location at all, which is what `missing` reports.
 */
export function resolveAssessorRequirements(
  requirements: AssessorRequirements,
  locationId: string | null | undefined,
): ResolvedAssessorRequirements {
  const byStream = requirements.byStream ?? {};
  const knownLocationIds = Object.keys(byStream);
  const always = [...requirements.always];

  if (knownLocationIds.length === 0) {
    // Every tool that predates this. A missing Location is not a gap when
    // nothing depended on it, and saying otherwise would warn on every case.
    return { required: always, streamCheck: 'not_applicable', knownLocationIds };
  }

  if (!locationId) {
    return { required: always, streamCheck: 'missing', knownLocationIds };
  }

  const extra = byStream[locationId];
  return {
    // Deduplicated: a tool may list the same competency in both halves, and a
    // caller that reported it twice would warn about one gap twice. A Location
    // the tool has no rule for contributes nothing — that is `matched` with the
    // always-required half, not a near-miss.
    required: [...new Set([...always, ...(extra ?? [])])],
    streamCheck: 'matched',
    knownLocationIds,
  };
}

/**
 * Wording for a case whose assessor requirements could not be fully checked, or
 * null when they could. Only a case with no Location leaves the location half
 * unchecked now. `knownLocationNames` names the sites the tool has a rule for,
 * so an admin can set one — the ids the rule is keyed by are not human-readable.
 */
export function streamCheckWarning(
  resolved: Pick<ResolvedAssessorRequirements, 'streamCheck'>,
  knownLocationNames: readonly string[] = [],
): string | null {
  if (resolved.streamCheck !== 'missing') return null;
  const known = knownLocationNames.filter(Boolean).join(', ');
  return (
    'assessor eligibility only partly checked — this assessment has ' +
    `location-specific requirements${known ? ` (${known})` : ''} and this case ` +
    'records no location'
  );
}
