import crypto from 'node:crypto';
import { env } from '../env.js';

export interface UserProfile {
  name: string;
  email: string;
  orgName?: string;
  /** 'individual' = solo workspace; 'team' = org with teammates. Defaults to 'team'. */
  accountKind?: 'individual' | 'team';
}

// ─── Session sealing (AES-256-GCM) ──────────────────────────────────────────

const SESSION_ALGORITHM = 'aes-256-gcm';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let cachedSessionKey: Buffer | null = null;

function sessionKey(): Buffer {
  if (!cachedSessionKey) {
    cachedSessionKey = crypto.scryptSync(env.SESSION_SECRET, 'formai-session-salt', 32);
  }
  return cachedSessionKey;
}

export function sealSession(payload: unknown, ttlMs = SESSION_TTL_MS): string {
  const envelope = { payload, exp: Date.now() + ttlMs };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(SESSION_ALGORITHM, sessionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(envelope), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString('base64url')).join('.');
}

export function unsealSession<T>(token: string): T | null {
  try {
    const [ivB64, tagB64, dataB64] = token.split('.');
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const decipher = crypto.createDecipheriv(
      SESSION_ALGORITHM,
      sessionKey(),
      Buffer.from(ivB64, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]);
    const envelope = JSON.parse(plaintext.toString('utf8')) as { payload: T; exp: number };
    if (typeof envelope.exp !== 'number' || envelope.exp < Date.now()) return null;
    return envelope.payload;
  } catch {
    return null;
  }
}
