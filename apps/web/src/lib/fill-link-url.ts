/**
 * Builds the absolute shareable URL for a fill link. The API returns `url`
 * as a path only (`"/fill/<token>"`) — the web layer owns the origin.
 * Tolerates a trailing slash on the origin and a missing leading slash on
 * the path so the join never doubles or drops the separator.
 */
export function fillLinkUrl(origin: string, linkPath: string): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}${linkPath.startsWith('/') ? '' : '/'}${linkPath}`;
}
