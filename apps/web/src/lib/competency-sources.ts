import type { Standing } from '@formai/shared';
import type { CompetencySourceRef } from './data/types.js';

/**
 * The ONE spelling of a requirement's provenance caption (R5, U8), shared by
 * every surface that names source scopes — the record, the holders register,
 * the compliance gap list and the recommended cards — so "Required — from
 * Boddington, Operations and Dozer Operator" cannot drift into four dialects.
 *
 * Format rules, pinned by test:
 *   - comma-joined with "and" before the last (AE1's line). No truncation:
 *     at most four scopes can co-occur per person per competency.
 *   - the org scope renders as "org-wide", never by the organisation's name —
 *     a member knows their org; the caption's job is to say "everyone".
 *   - org-ONLY drops the "from": "Required — org-wide" reads as the fact it
 *     is, where "from org-wide" would read as a place.
 */
export function sourcesPhrase(sources: readonly CompetencySourceRef[] | undefined): string | null {
  if (!sources || sources.length === 0) return null;
  const names = sources.map((s) => (s.scope === 'org' ? 'org-wide' : s.name));
  const joined =
    names.length === 1
      ? names[0]!
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
  return sources.every((s) => s.scope === 'org') ? joined : `from ${joined}`;
}

/** Caption labels per standing. Optional has no sources and gets no line. */
const STANDING_LABEL: Partial<Record<Standing, string>> = {
  required: 'Required',
  recommended: 'Recommended',
};

/**
 * The full record line — "Required — from <scopes>" / "Recommended — from
 * <Location>" (R5, AE5). Null where there is nothing honest to say: no
 * sources (absent OR empty — a gated read and an optional entry both render
 * no line rather than a false one), or a standing that names nothing.
 */
export function sourcesLine(
  standing: Standing,
  sources: readonly CompetencySourceRef[] | undefined,
): string | null {
  const label = STANDING_LABEL[standing];
  const phrase = sourcesPhrase(sources);
  if (!label || !phrase) return null;
  return `${label} — ${phrase}`;
}
