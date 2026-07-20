/**
 * Dynamic Google Fonts loading for branded surfaces.
 *
 * Every surface that renders inside a tenant's brand names the org's chosen
 * family in `--org-font`, but naming a family does nothing unless its
 * stylesheet is on the page — the reason the old fixed picker offered
 * Spectral while only ever loading Inter/Sora. `ensureFontLoaded` closes that
 * gap: it injects the family's `css2` stylesheet once, on demand.
 *
 * Two details are load-bearing:
 *   - The URL requests the INTERSECTION of the family's real weights with the
 *     weights branded UI renders. A bare-family request serves 400 only, and
 *     requesting a weight a family does not ship fails the whole request — so
 *     both a naive bare request and a naive `400;500;600;700` request drop the
 *     font for a large slice of the catalog.
 *   - Every failure path is swallowed. A blocked or failed stylesheet must
 *     leave the generic fallback stack rendering, never break the surface.
 */
import { findGoogleFont } from '@formai/shared';

/** The weights branded surfaces actually render (body → headings → buttons). */
const USED_WEIGHTS = [400, 500, 600, 700] as const;

/** Stable element id per family, so idempotency is a DOM lookup, not module state. */
function linkId(family: string): string {
  return `org-font-${family.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
}

/**
 * The `fonts.googleapis.com/css2` URL for `family`, or `null` if the family is
 * not in the bundled catalog (an unknown name must never reach the network —
 * it would put an unvalidated string in the query).
 */
export function googleFontsCss2Url(family: string): string | null {
  const entry = findGoogleFont(family);
  if (!entry) return null;
  const wanted = USED_WEIGHTS.filter((w) => entry.weights.includes(w));
  // Every catalog family ships 400, so this is belt-and-braces: fall back to
  // the family's lightest weight rather than emitting an empty `wght@`.
  const weights = wanted.length > 0 ? wanted : entry.weights.slice(0, 1);
  const name = encodeURIComponent(entry.family).replace(/%20/g, '+');
  return `https://fonts.googleapis.com/css2?family=${name}:wght@${weights.join(';')}&display=swap`;
}

/**
 * Ensure `family`'s stylesheet is present in `doc`. Idempotent per family and
 * safe to call on every render. Unknown families, a missing document, and any
 * thrown DOM/CSP error are all silent no-ops.
 *
 * `doc` is injectable so the loader is unit-testable in a node environment.
 */
export function ensureFontLoaded(
  family: string,
  doc: Document | null = typeof document === 'undefined' ? null : document,
): void {
  try {
    if (!doc) return;
    const href = googleFontsCss2Url(family);
    if (!href) return;
    const id = linkId(family);
    if (doc.getElementById(id)) return;
    const link = doc.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = href;
    link.crossOrigin = 'anonymous';
    doc.head.appendChild(link);
  } catch {
    // A failed injection leaves the generic fallback stack rendering.
  }
}
