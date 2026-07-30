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

const { createApp } = await import('../app.js');
const { mintApiKey } = await import('../auth/api-key.js');
const { sealSession } = await import('../auth/replit-auth.js');

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

function fakeDb(apiKey?: unknown) {
  return {
    query: {
      apiKeys: { findFirst: vi.fn().mockResolvedValue(apiKey) },
      users: { findFirst: vi.fn().mockResolvedValue({ id: 'u-owner', name: 'Ash Wyborn' }) },
    },
    update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve() }) })),
  } as unknown as Db;
}

function liveKey() {
  const minted = mintApiKey();
  return {
    minted,
    row: {
      id: 'key-1',
      orgId: 'org-1',
      name: 'Cowork agent',
      role: 'reviewer' as const,
      prefix: minted.prefix,
      hash: minted.hash,
      createdByUserId: 'u-owner',
      revokedAt: null,
    },
  };
}

/** Streamable HTTP requires the client to accept both JSON and the event stream. */
const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1' },
  },
};

/** The transport may answer as JSON or as a single SSE frame; both carry the same payload. */
async function rpcResult(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: ')) ?? text;
  return JSON.parse(line.replace(/^data: /, '')) as Record<string, unknown>;
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

describe('POST /mcp', () => {
  it('completes the MCP handshake for a caller holding a live key', async () => {
    const { minted, row } = liveKey();
    mockDbValue = fakeDb(row);
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { ...MCP_HEADERS, authorization: `Bearer ${minted.plaintext}` },
        body: JSON.stringify(INITIALIZE),
      });
      expect(res.status).toBe(200);

      const body = await rpcResult(res);
      const result = body.result as { serverInfo: { name: string } };
      expect(result.serverInfo.name).toBe('formai-inductions');
    } finally {
      server.close();
    }
  });

  it('advertises the induction toolset', async () => {
    const { minted, row } = liveKey();
    mockDbValue = fakeDb(row);
    const { server, base } = startApp();
    try {
      // Stateless: each POST stands alone, so tools/list needs no prior session.
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { ...MCP_HEADERS, authorization: `Bearer ${minted.plaintext}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      });
      expect(res.status).toBe(200);

      const body = await rpcResult(res);
      const names = (body.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'get_induction_candidate',
        'get_induction_document_link',
        'list_induction_bookings',
        'list_induction_candidates',
        'next_induction_dates',
        'plan_induction_cohort',
        'record_induction_booking',
      ]);
    } finally {
      server.close();
    }
  });

  it('refuses the handshake outright when the key is missing or revoked', async () => {
    const { minted, row } = liveKey();

    mockDbValue = fakeDb(row);
    const noKey = startApp();
    try {
      const res = await fetch(`${noKey.base}/mcp`, {
        method: 'POST',
        headers: MCP_HEADERS,
        body: JSON.stringify(INITIALIZE),
      });
      // Rejected before the protocol starts, so the client gets a credential
      // error rather than a tool failure several round trips in.
      expect(res.status).toBe(401);
    } finally {
      noKey.server.close();
    }

    mockDbValue = fakeDb(undefined); // revoked keys are filtered out by the query
    const revoked = startApp();
    try {
      const res = await fetch(`${revoked.base}/mcp`, {
        method: 'POST',
        headers: { ...MCP_HEADERS, authorization: `Bearer ${minted.plaintext}` },
        body: JSON.stringify(INITIALIZE),
      });
      expect(res.status).toBe(401);
    } finally {
      revoked.server.close();
    }
  });

  it('does not accept a browser session in place of a key', async () => {
    // requireMachineOrTenant lets a cookie through, but the tools need a key to
    // forward — so the router refuses rather than acting with no credential.
    mockDbValue = fakeDb(undefined);
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          ...MCP_HEADERS,
          cookie: `fai_session=${sealSession({ userId: 'u1', orgId: 'org-1', role: 'owner' })}`,
        },
        body: JSON.stringify(INITIALIZE),
      });
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('tells a client plainly that the stateless endpoint has no event stream', async () => {
    const { minted, row } = liveKey();
    mockDbValue = fakeDb(row);
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/mcp`, {
        headers: { ...MCP_HEADERS, authorization: `Bearer ${minted.plaintext}` },
      });
      expect(res.status).toBe(405);
      expect(((await res.json()) as { error: string }).error).toBe('method_not_allowed');
    } finally {
      server.close();
    }
  });

  it('does not leak the key path under the header mount', async () => {
    // The URL door is mounted first; the header door must not also answer it.
    const { minted, row } = liveKey();
    mockDbValue = fakeDb(row);
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/mcp/key/${encodeURIComponent(minted.plaintext)}`, {
        method: 'POST',
        headers: MCP_HEADERS,
        body: JSON.stringify(INITIALIZE),
      });
      // Authenticated purely by the path — no Authorization header sent.
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });
});

describe('POST /mcp/key/:key — the connector door', () => {
  it('completes the handshake with the key in the URL and no header', async () => {
    const { minted, row } = liveKey();
    mockDbValue = fakeDb(row);
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/mcp/key/${encodeURIComponent(minted.plaintext)}`, {
        method: 'POST',
        headers: MCP_HEADERS,
        body: JSON.stringify(INITIALIZE),
      });
      expect(res.status).toBe(200);
      const body = await rpcResult(res);
      expect((body.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
        'formai-inductions',
      );
      // Whatever else it does, the response must not echo the credential back.
      expect(JSON.stringify(body)).not.toContain(minted.plaintext);
    } finally {
      server.close();
    }
  });

  it('serves the same toolset as the header door', async () => {
    const { minted, row } = liveKey();
    mockDbValue = fakeDb(row);
    const { server, base } = startApp();
    try {
      const list = { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} };
      const viaPath = await fetch(`${base}/mcp/key/${encodeURIComponent(minted.plaintext)}`, {
        method: 'POST',
        headers: MCP_HEADERS,
        body: JSON.stringify(list),
      });
      const viaHeader = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { ...MCP_HEADERS, authorization: `Bearer ${minted.plaintext}` },
        body: JSON.stringify(list),
      });
      expect(await rpcResult(viaPath)).toEqual(await rpcResult(viaHeader));
    } finally {
      server.close();
    }
  });

  it('401s on a revoked, forged, or malformed key in the path', async () => {
    const { minted } = liveKey();
    for (const [label, key, row] of [
      ['revoked', minted.plaintext, undefined],
      ['forged', 'fai_deadbeef_notarealsecret', undefined],
      ['malformed', 'not-a-key', undefined],
    ] as const) {
      mockDbValue = fakeDb(row);
      const { server, base } = startApp();
      try {
        const res = await fetch(`${base}/mcp/key/${encodeURIComponent(key)}`, {
          method: 'POST',
          headers: MCP_HEADERS,
          body: JSON.stringify(INITIALIZE),
        });
        expect(res.status, label).toBe(401);
      } finally {
        server.close();
      }
    }
  });

  it('refuses an empty key segment rather than falling through unauthenticated', async () => {
    mockDbValue = fakeDb(undefined);
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/mcp/key/`, {
        method: 'POST',
        headers: MCP_HEADERS,
        body: JSON.stringify(INITIALIZE),
      });
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });
});
