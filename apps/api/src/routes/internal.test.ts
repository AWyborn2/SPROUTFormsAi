import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

// A mutable SWEEP_SECRET layered over the real parsed env, so each test can set
// it (or leave it unset) without re-parsing the environment.
let sweepSecret: string | undefined;
vi.mock('../env.js', async () => {
  const actual = await vi.importActual<typeof import('../env.js')>('../env.js');
  return {
    get env() {
      return { ...actual.env, SWEEP_SECRET: sweepSecret };
    },
  };
});

const { createApp } = await import('../app.js');

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

/** A database whose only need here is to answer organizations.findMany for the sweep. */
function fakeDb() {
  return { query: { organizations: { findMany: vi.fn().mockResolvedValue([]) } } } as unknown as Db;
}

afterEach(() => {
  mockDbValue = null;
  sweepSecret = undefined;
  vi.clearAllMocks();
});

describe('POST /internal/sweep — the shared-secret trigger (U21)', () => {
  it('FAILS CLOSED: with the secret unset it refuses every caller (503)', async () => {
    mockDbValue = fakeDb();
    sweepSecret = undefined; // not configured
    const { server, base } = startApp();
    // Even presenting an empty secret — the danger case undefined === undefined.
    const res = await fetch(`${base}/internal/sweep`, {
      method: 'POST',
      headers: { 'x-sweep-secret': '' },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'sweep_not_configured' });
    server.close();
  });

  it('refuses a caller presenting the wrong secret (401)', async () => {
    mockDbValue = fakeDb();
    sweepSecret = 'the-real-secret';
    const { server, base } = startApp();
    const res = await fetch(`${base}/internal/sweep`, {
      method: 'POST',
      headers: { 'x-sweep-secret': 'not-it' },
    });
    expect(res.status).toBe(401);
    server.close();
  });

  it('refuses a caller presenting no secret at all (401)', async () => {
    mockDbValue = fakeDb();
    sweepSecret = 'the-real-secret';
    const { server, base } = startApp();
    const res = await fetch(`${base}/internal/sweep`, { method: 'POST' });
    expect(res.status).toBe(401);
    server.close();
  });

  it('accepts the correct secret and runs the sweep', async () => {
    mockDbValue = fakeDb();
    sweepSecret = 'the-real-secret';
    const { server, base } = startApp();
    const res = await fetch(`${base}/internal/sweep`, {
      method: 'POST',
      headers: { 'x-sweep-secret': 'the-real-secret' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
    server.close();
  });
});
