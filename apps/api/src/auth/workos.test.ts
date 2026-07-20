/**
 * Session sealing round-trip tests. These live here for historical continuity;
 * the workos.ts module is now a thin shim that re-exports from replit-auth.ts.
 */
import { describe, expect, it } from 'vitest';
import { sealSession, unsealSession } from './workos.js';

describe('sealSession / unsealSession', () => {
  it('round-trips the same payload', () => {
    const payload = { userId: 'u1', orgId: 'o1', role: 'owner' };
    const token = sealSession(payload);
    expect(unsealSession(token)).toEqual(payload);
  });

  it('returns null for a tampered token', () => {
    const token = sealSession({ userId: 'u1', orgId: 'o1', role: 'owner' });
    const [iv, tag, data] = token.split('.');
    const tampered = [iv, tag, `${(data ?? '').slice(0, -2)}zz`].join('.');
    expect(unsealSession(tampered)).toBeNull();
  });

  it('returns null for a malformed token', () => {
    expect(unsealSession('not-a-valid-token')).toBeNull();
  });

  it('returns null for an expired token', () => {
    const token = sealSession({ userId: 'u1', orgId: 'o1', role: 'owner' }, -1000);
    expect(unsealSession(token)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(unsealSession('')).toBeNull();
  });
});
