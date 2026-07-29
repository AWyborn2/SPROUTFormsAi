/**
 * The credential out of an `Authorization: Bearer …` header, if there is one.
 *
 * A local copy rather than an import from the API: this package has to stay
 * installable on its own, and six lines of header parsing is a cheaper price
 * than a workspace dependency that would drag the whole server in with it.
 */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim() || null;
}
