import { describe, expect, it } from 'vitest';
import { bearerToken, hashApiKey, mintApiKey, parseApiKey, verifyApiKey } from './api-key.js';

describe('mintApiKey', () => {
  it('produces a namespaced three-part key whose prefix is embedded in the plaintext', () => {
    const minted = mintApiKey();
    expect(minted.plaintext.startsWith(`fai_${minted.prefix}_`)).toBe(true);
    expect(parseApiKey(minted.plaintext)).toEqual({ prefix: minted.prefix });
  });

  it('stores a hash, never the secret', () => {
    const minted = mintApiKey();
    expect(minted.hash).toBe(hashApiKey(minted.plaintext));
    expect(minted.hash).not.toContain(minted.plaintext);
    expect(minted.plaintext).not.toContain(minted.hash);
  });

  it('never repeats a key', () => {
    const keys = new Set(Array.from({ length: 50 }, () => mintApiKey().plaintext));
    expect(keys.size).toBe(50);
  });

  it('never emits the delimiter inside a segment', () => {
    // base64url would: its alphabet contains '_', so roughly a third of keys
    // would parse into four parts and be rejected as malformed.
    for (let i = 0; i < 200; i++) {
      const minted = mintApiKey();
      expect(minted.prefix).toMatch(/^[0-9a-f]+$/);
      expect(minted.plaintext.split('_')).toHaveLength(3);
    }
  });
});

describe('parseApiKey', () => {
  it.each([
    ['wrong namespace', 'xyz_abc_def'],
    ['missing secret', 'fai_abc'],
    ['empty secret', 'fai_abc_'],
    ['too many parts', 'fai_abc_def_ghi'],
    ['not a key at all', 'hello'],
  ])('rejects %s', (_label, raw) => {
    expect(parseApiKey(raw)).toBeNull();
  });
});

describe('verifyApiKey', () => {
  it('accepts the minted plaintext', () => {
    const minted = mintApiKey();
    expect(verifyApiKey(minted.plaintext, minted.hash)).toBe(true);
  });

  it('rejects a different key with the same prefix', () => {
    const minted = mintApiKey();
    const forged = `fai_${minted.prefix}_notthesecret`;
    expect(verifyApiKey(forged, minted.hash)).toBe(false);
  });

  it('rejects rather than throwing on a malformed stored hash', () => {
    const minted = mintApiKey();
    expect(verifyApiKey(minted.plaintext, 'deadbeef')).toBe(false);
    expect(verifyApiKey(minted.plaintext, '')).toBe(false);
  });
});

describe('bearerToken', () => {
  it('reads the value out of a Bearer header, case-insensitively', () => {
    expect(bearerToken('Bearer fai_a_b')).toBe('fai_a_b');
    expect(bearerToken('bearer fai_a_b')).toBe('fai_a_b');
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['another scheme', 'Basic abc'],
    ['scheme with no value', 'Bearer '],
  ])('returns null when the header is %s', (_label, header) => {
    expect(bearerToken(header)).toBeNull();
  });
});
