import crypto from 'node:crypto';

/**
 * API keys — minting and verifying the machine credential.
 *
 * The plaintext is `fai_<prefix>_<secret>`. The prefix is stored and shown so a
 * key can be recognised in a list without being reproducible; the secret never
 * leaves the create response. Only the SHA-256 of the WHOLE plaintext is
 * persisted, so knowing a prefix — which is deliberately visible — tells an
 * attacker nothing they can present.
 *
 * Verification is prefix lookup then `verifyApiKey`, never a comparison the
 * caller writes with `===`: a naive string compare leaks the shared-prefix
 * length through timing, and this is the credential that stands between an
 * agent and an organisation's intake data.
 */

const KEY_NAMESPACE = 'fai';
const PREFIX_BYTES = 6;
const SECRET_BYTES = 24;

export interface MintedApiKey {
  /** Returned to the caller exactly once. Never stored. */
  plaintext: string;
  /** Stored and displayable. Also the lookup handle. */
  prefix: string;
  /** Stored. SHA-256 of `plaintext`, hex. */
  hash: string;
}

export function hashApiKey(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * Hex, not base64url. The underscore is the key's own delimiter, and
 * base64url's alphabet includes it — a minted key would parse into four parts
 * roughly a third of the time, rejecting a perfectly valid credential.
 */
export function mintApiKey(): MintedApiKey {
  const prefix = crypto.randomBytes(PREFIX_BYTES).toString('hex');
  const secret = crypto.randomBytes(SECRET_BYTES).toString('hex');
  const plaintext = `${KEY_NAMESPACE}_${prefix}_${secret}`;
  return { plaintext, prefix, hash: hashApiKey(plaintext) };
}

/**
 * The prefix embedded in a presented key, or null when the string is not
 * shaped like one of ours. Returning null early keeps a malformed header from
 * reaching the database at all.
 */
export function parseApiKey(raw: string): { prefix: string } | null {
  const parts = raw.split('_');
  if (parts.length !== 3) return null;
  const [namespace, prefix, secret] = parts;
  if (namespace !== KEY_NAMESPACE || !prefix || !secret) return null;
  return { prefix };
}

/** Constant-time check of a presented key against a stored hash. */
export function verifyApiKey(plaintext: string, storedHash: string): boolean {
  const presented = Buffer.from(hashApiKey(plaintext), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  // timingSafeEqual throws on a length mismatch, which a corrupt or truncated
  // stored hash would produce — that is a failed verification, not an error.
  if (presented.length !== stored.length) return false;
  return crypto.timingSafeEqual(presented, stored);
}

/** The credential out of an `Authorization: Bearer …` header, if there is one. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim() || null;
}
