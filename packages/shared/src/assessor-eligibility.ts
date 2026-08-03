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
  /** Required in every stream. */
  always: readonly string[];
  /**
   * Extra requirements per location stream, keyed by the stream name. Matched
   * case-insensitively and trimmed: the case's stream is free text a human
   * types, so "Raw Materials", "raw materials" and " Raw Materials " are one
   * place, and treating them as three would silently skip the check.
   */
  byStream?: Readonly<Record<string, readonly string[]>>;
}

/**
 * How much of the requirement it was possible to check.
 *
 * Three outcomes rather than a boolean, because the two ways of failing need
 * different words: a case with no stream needs one setting, and a case naming a
 * stream nobody declared needs someone to work out whether it is a typo or a
 * site the rule has not been written for.
 */
export type StreamCheck =
  /** This tool's requirement does not depend on location. Nothing to check. */
  | 'not_applicable'
  /** Recognised; the location-specific requirements are included. */
  | 'matched'
  /** The tool varies by location and the case records none. */
  | 'missing'
  /** The tool varies by location and does not know the one this case names. */
  | 'unrecognised';

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
  /** The stream names this tool knows about, for offering as choices. */
  knownStreams: string[];
}

/** Free text as typed → the form used for comparison. */
function normalise(stream: string): string {
  return stream.trim().toLowerCase();
}

/**
 * Resolve a tool's assessor requirements against one case's location stream.
 *
 * AN UNRECOGNISED STREAM IS FLAGGED, NOT TREATED AS AN UNREGULATED SITE.
 *
 * An earlier version of this reasoned that "the tool has said which locations
 * carry extra requirements, so a stream outside that list is a location with
 * none", and returned a clean result. That is the dangerous reading. This value
 * is free text, and it is also the answer to the document's own stream
 * question, so it is not owned by the eligibility rule — which means a value
 * outside `byStream` is far more likely to be a near-miss spelling of a
 * location the rule DOES cover than a genuinely unregulated site. "Mine"
 * against a tool keyed "Mining" reduced `Q34666893 AND (Q50071833 OR
 * Q50073293)` to `Q34666893` and reported it as fully checked, which is exactly
 * the cross-site pass this function exists to prevent.
 *
 * The costs are not symmetric. Flagging a genuine third site produces a warning
 * somebody reads and dismisses; not flagging a typo signs off a mining
 * assessment by an assessor authorised only for raw materials, and nothing ever
 * says so. Nothing here blocks, so a warning costs attention and silence costs
 * correctness.
 */
export function resolveAssessorRequirements(
  requirements: AssessorRequirements,
  locationStream: string | null | undefined,
): ResolvedAssessorRequirements {
  const byStream = requirements.byStream ?? {};
  const knownStreams = Object.keys(byStream);
  const always = [...requirements.always];

  if (knownStreams.length === 0) {
    // Every tool that predates this. A missing stream is not a gap when nothing
    // depended on it, and saying otherwise would warn on every case.
    return { required: always, streamCheck: 'not_applicable', knownStreams };
  }

  if (!locationStream || !locationStream.trim()) {
    return { required: always, streamCheck: 'missing', knownStreams };
  }

  const wanted = normalise(locationStream);
  const match = knownStreams.find((key) => normalise(key) === wanted);
  if (!match) {
    return { required: always, streamCheck: 'unrecognised', knownStreams };
  }

  return {
    // Deduplicated: a tool may list the same competency in both halves, and a
    // caller that reported it twice would warn about one gap twice.
    required: [...new Set([...always, ...(byStream[match] ?? [])])],
    streamCheck: 'matched',
    knownStreams,
  };
}

/**
 * Wording for a case whose assessor requirements could not be fully checked, or
 * null when they could.
 *
 * Names the streams the tool knows about in both failing cases, because the fix
 * is to set one of them and nobody can guess the spelling a tool expects.
 */
export function streamCheckWarning(
  resolved: Pick<ResolvedAssessorRequirements, 'streamCheck' | 'knownStreams'>,
  locationStream: string | null | undefined,
): string | null {
  const known = resolved.knownStreams.join(', ');
  switch (resolved.streamCheck) {
    case 'missing':
      return (
        'assessor eligibility only partly checked — this assessment has ' +
        `location-specific requirements (${known}) and this case records no ` +
        'location stream'
      );
    case 'unrecognised':
      return (
        'assessor eligibility only partly checked — this case\'s location stream ' +
        `"${locationStream}" is not one this assessment has requirements for ` +
        `(${known}), so the location-specific half was skipped`
      );
    default:
      return null;
  }
}
