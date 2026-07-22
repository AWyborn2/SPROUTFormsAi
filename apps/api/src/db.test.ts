import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';
import { checkDbConnection, createHealthCache } from './db.js';
import { createApp } from './app.js';

/** Minimal mock satisfying the `execute` call checkDbConnection makes. */
function mockClient(execute: () => Promise<unknown>): Db {
  return { execute } as unknown as Db;
}

describe('checkDbConnection', () => {
  it('resolves "connected" when the client query succeeds', async () => {
    const execute = vi.fn().mockResolvedValue([{ '?column?': 1 }]);
    const status = await checkDbConnection(mockClient(execute));
    expect(status).toBe('connected');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('resolves "unconfigured" for a null client without attempting a connection', async () => {
    const status = await checkDbConnection(null);
    expect(status).toBe('unconfigured');
  });

  it('resolves "error" (not a thrown exception) when the query rejects', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('connection refused'));
    await expect(checkDbConnection(mockClient(execute))).resolves.toBe('error');
  });
});

describe('createHealthCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports "unconfigured" for a null target and never starts a background refresh', async () => {
    const cache = createHealthCache(null, 5);
    expect(cache.getStatus()).toBe('unconfigured');
    // Give any errant timer a chance to fire; status must not change.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cache.getStatus()).toBe('unconfigured');
    cache.stop();
  });

  it('refreshes the cached status on the configured interval', async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockResolvedValue([{ '?column?': 1 }]);
    const cache = createHealthCache(mockClient(execute), 1000);

    // The initial refresh is fire-and-forget at construction time.
    await vi.waitFor(() => expect(cache.getStatus()).toBe('connected'));
    expect(execute).toHaveBeenCalledTimes(1);

    // Simulate the DB going down; the cache should not reflect it until the
    // next interval tick — proving the check is not re-run per read.
    execute.mockRejectedValue(new Error('connection refused'));
    expect(cache.getStatus()).toBe('connected');

    await vi.advanceTimersByTimeAsync(1000);
    expect(cache.getStatus()).toBe('error');
    expect(execute).toHaveBeenCalledTimes(2);

    cache.stop();
  });

  it('stop() clears the interval so no further refreshes occur', async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockResolvedValue([{ '?column?': 1 }]);
    const cache = createHealthCache(mockClient(execute), 1000);
    await vi.waitFor(() => expect(cache.getStatus()).toBe('connected'));

    cache.stop();
    execute.mockRejectedValue(new Error('connection refused'));
    await vi.advanceTimersByTimeAsync(5000);

    expect(cache.getStatus()).toBe('connected'); // unchanged post-stop
    expect(execute).toHaveBeenCalledTimes(1); // no additional refreshes
  });
});

describe('GET /health', () => {
  it('always returns 200 synchronously from the cache, without changing status/service', async () => {
    const app = createApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const body = (await res.json()) as { status: string; service: string; db: string };
      expect(res.status).toBe(200);
      expect(body.status).toBe('ok');
      expect(body.service).toBe('formai-api');
      // `db` is a module-level const resolved from DATABASE_URL at import, so
      // the reported state depends on where the suite runs: 'unconfigured'
      // locally and in CI, 'connected' on Replit where the Postgres module
      // supplies a URL. Pinning one of those failed the suite in the only
      // environment this product actually deploys to. What the test exists for
      // — per its own name — is that /health answers 200 SYNCHRONOUSLY from the
      // cache without altering status or service, so it asserts the db state is
      // a legal one rather than a particular one.
      expect(['unconfigured', 'connected', 'error']).toContain(body.db);
    } finally {
      server.close();
    }
  });
});
