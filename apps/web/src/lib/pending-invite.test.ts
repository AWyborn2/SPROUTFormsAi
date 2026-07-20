import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rememberPendingInvite, takePendingInvite } from './pending-invite.js';

/**
 * The suite runs on `node` (see vitest.config.ts — "node is enough"), so
 * there is no real `sessionStorage`. A five-line in-memory stand-in keeps it
 * that way rather than pulling jsdom in for one module.
 */
function installStorage(impl?: Partial<Storage>) {
  const data = new Map<string, string>();
  const storage: Storage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
    ...impl,
  };
  vi.stubGlobal('sessionStorage', storage);
}

beforeEach(() => installStorage());
afterEach(() => vi.unstubAllGlobals());

describe('pending invite hand-off', () => {
  it('round-trips a token across the sign-in redirect', () => {
    rememberPendingInvite('tok-abc');
    expect(takePendingInvite()).toBe('tok-abc');
  });

  it('returns null when nothing is pending — a normal sign-in still lands in /app', () => {
    expect(takePendingInvite()).toBeNull();
  });

  it('clears on read, so one invite redirects once and not on every later visit to /', () => {
    rememberPendingInvite('tok-abc');
    expect(takePendingInvite()).toBe('tok-abc');
    expect(takePendingInvite()).toBeNull();
  });

  it('degrades to null rather than throwing when storage is unavailable', () => {
    // Private mode / embedded webviews throw on access. The invitee re-opens
    // the emailed link instead; the app must not white-screen.
    installStorage({
      setItem: () => {
        throw new Error('storage disabled');
      },
      getItem: () => {
        throw new Error('storage disabled');
      },
    });
    expect(() => rememberPendingInvite('tok-abc')).not.toThrow();
    expect(takePendingInvite()).toBeNull();
  });
});
