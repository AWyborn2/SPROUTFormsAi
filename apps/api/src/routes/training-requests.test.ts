import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@formai/db';

const admin = { userId: 'admin-1', orgId: 'org-1', role: 'admin' as const };
const candidate = { userId: 'cand-1', orgId: 'org-1', role: 'candidate' as const };
let sealSession: (t: { userId: string; orgId: string; role: string }) => string;

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

const { createApp } = await import('../app.js');
({ sealSession } = await import('../auth/workos.js'));

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}
function authHeader(t: { userId: string; orgId: string; role: string }) {
  return { cookie: `fai_session=${sealSession(t)}` };
}

const TOOL = '00000000-0000-4000-8000-0000000000a1';
const COMP = 'comp-x';
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

function fakeDb(opts: {
  planTier?: string;
  tool?: Record<string, unknown>;
  existingRequest?: unknown;
  requests?: unknown[];
  membership?: unknown;
  templates?: unknown[];
  heldLocations?: unknown[];
  openCases?: unknown[];
  competencyHolders?: unknown[];
  competencies?: unknown[];
  insertedRequest?: unknown;
  insertedCase?: unknown;
  updatedRequest?: unknown;
}) {
  const insertValues = vi.fn();
  const updateSet = vi.fn();
  const db = {
    query: {
      organizations: {
        findFirst: vi.fn().mockResolvedValue({ id: 'org-1', planTier: opts.planTier ?? 'business' }),
      },
      assessmentTools: {
        findFirst: vi.fn().mockResolvedValue(opts.tool),
        findMany: vi.fn().mockResolvedValue(opts.tool ? [opts.tool] : []),
      },
      trainingRequests: {
        findFirst: vi.fn().mockResolvedValue(opts.existingRequest),
        findMany: vi.fn().mockResolvedValue(opts.requests ?? []),
      },
      memberships: { findFirst: vi.fn().mockResolvedValue(opts.membership) },
      users: { findFirst: vi.fn().mockResolvedValue({ id: 'admin-1', name: 'Ada Admin' }) },
      formTemplates: { findMany: vi.fn().mockResolvedValue(opts.templates ?? []) },
      membershipLocations: { findMany: vi.fn().mockResolvedValue(opts.heldLocations ?? []) },
      membershipRoles: { findMany: vi.fn().mockResolvedValue([]) },
      roleRequiredAssessments: { findMany: vi.fn().mockResolvedValue([]) },
      assessmentCases: { findMany: vi.fn().mockResolvedValue(opts.openCases ?? []) },
      competencyHolders: { findMany: vi.fn().mockResolvedValue(opts.competencyHolders ?? []) },
      competencies: { findMany: vi.fn().mockResolvedValue(opts.competencies ?? []) },
    },
    insert: vi.fn((table: unknown) => ({
      values: (v: unknown) => {
        insertValues(table, v);
        return {
          returning: vi
            .fn()
            .mockResolvedValue([
              table === schema.trainingRequests ? opts.insertedRequest : opts.insertedCase,
            ]),
        };
      },
    })),
    update: vi.fn((table: unknown) => ({
      set: (v: unknown) => {
        updateSet(table, v);
        return { where: () => ({ returning: vi.fn().mockResolvedValue([opts.updatedRequest]) }) };
      },
    })),
  } as unknown as Db;
  return { db, insertValues, updateSet };
}

afterEach(() => {
  mockDbValue = null;
  vi.restoreAllMocks();
});

const orgTool = { id: TOOL, orgId: 'org-1', name: 'Working at Heights' };

describe('POST /training-requests (U22, R37, R94)', () => {
  it('records a member’s request for a tool (R94)', async () => {
    const { db, insertValues } = fakeDb({
      tool: orgTool,
      existingRequest: undefined,
      insertedRequest: { id: 'tr-1', userId: candidate.userId, toolId: TOOL, state: 'pending', createdAt: new Date() },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(candidate) },
      body: JSON.stringify({ toolId: TOOL }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ userId: candidate.userId, toolId: TOOL, state: 'pending' });
    // The subject written is the caller — never someone else (R37).
    expect(insertValues).toHaveBeenCalledWith(
      schema.trainingRequests,
      expect.objectContaining({ userId: candidate.userId, toolId: TOOL }),
    );
    server.close();
  });

  it('succeeds for a Candidate — the matrix grants nothing outside their own record (R37)', async () => {
    const { db } = fakeDb({
      tool: orgTool,
      insertedRequest: { id: 'tr-1', userId: candidate.userId, toolId: TOOL, state: 'pending', createdAt: new Date() },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(candidate) },
      body: JSON.stringify({ toolId: TOOL }),
    });
    expect(res.status).toBe(201);
    server.close();
  });

  it('is idempotent while one is still pending — no duplicate on the working list', async () => {
    const existing = { id: 'tr-1', userId: candidate.userId, toolId: TOOL, state: 'pending', createdAt: new Date() };
    const { db, insertValues } = fakeDb({ tool: orgTool, existingRequest: existing });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(candidate) },
      body: JSON.stringify({ toolId: TOOL }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'tr-1', state: 'pending' });
    expect(insertValues).not.toHaveBeenCalled();
    server.close();
  });

  it('404s for a tool outside the caller org', async () => {
    const { db } = fakeDb({ tool: undefined });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(candidate) },
      body: JSON.stringify({ toolId: TOOL }),
    });
    expect(res.status).toBe(404);
    server.close();
  });
});

describe('GET /training-requests (U22)', () => {
  it('lists pending requests for an Admin', async () => {
    const { db } = fakeDb({
      requests: [{ id: 'tr-1', userId: candidate.userId, toolId: TOOL, state: 'pending', createdAt: new Date() }],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests`, { headers: authHeader(admin) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(1);
    server.close();
  });

  it('refuses a non-Admin the org-wide list', async () => {
    const { db } = fakeDb({});
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests`, { headers: authHeader(candidate) });
    expect(res.status).toBe(403);
    server.close();
  });
});

describe('POST /training-requests/:id/approve (U22, R94, R96)', () => {
  const pending = { id: 'tr-1', orgId: 'org-1', userId: candidate.userId, toolId: TOOL, state: 'pending', createdAt: new Date() };
  const assignableTool = {
    id: TOOL,
    orgId: 'org-1',
    name: 'Working at Heights',
    templateId: 'tpl-1',
    awardedCompetencyIds: [COMP],
    manifest: { parts: [{ key: 'p1' }] },
    locationPartKeys: {},
    assessorStreamCompetencyIds: {},
  };

  it('assigns the tool through the ordinary assignment path (R94)', async () => {
    const { db, insertValues, updateSet } = fakeDb({
      existingRequest: pending,
      tool: assignableTool,
      membership: { id: 'm-1', userId: candidate.userId, orgId: 'org-1' },
      templates: [{ id: 'tpl-1', currentVersionId: 'ver-1' }],
      heldLocations: [{ locationId: 'loc-1' }],
      openCases: [],
      competencyHolders: [], // holds nothing → the awarded competency is unmet → a case is created
      insertedCase: { id: 'case-1' },
      updatedRequest: { ...pending, state: 'approved' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests/tr-1/approve`, {
      method: 'POST',
      headers: authHeader(admin),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'approved', createdCaseIds: ['case-1'] });
    // A case was created through the assignment path…
    expect(insertValues).toHaveBeenCalledWith(schema.assessmentCases, expect.anything());
    // …and the request is marked approved.
    expect(updateSet).toHaveBeenCalledWith(
      schema.trainingRequests,
      expect.objectContaining({ state: 'approved' }),
    );
    server.close();
  });

  it('creates no case when the person already holds the competency current (R45)', async () => {
    const { db, insertValues } = fakeDb({
      existingRequest: pending,
      tool: assignableTool,
      membership: { id: 'm-1', userId: candidate.userId, orgId: 'org-1' },
      templates: [{ id: 'tpl-1', currentVersionId: 'ver-1' }],
      heldLocations: [{ locationId: 'loc-1' }],
      openCases: [],
      competencyHolders: [{ competencyId: COMP, userId: candidate.userId, grantedAt: daysAgo(30), revokedAt: null }],
      competencies: [{ id: COMP, validForMonths: 36 }],
      updatedRequest: { ...pending, state: 'approved' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests/tr-1/approve`, {
      method: 'POST',
      headers: authHeader(admin),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'approved', createdCaseIds: [] });
    expect(insertValues).not.toHaveBeenCalledWith(schema.assessmentCases, expect.anything());
    server.close();
  });

  it('refuses a non-Admin', async () => {
    const { db } = fakeDb({ existingRequest: pending });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests/tr-1/approve`, {
      method: 'POST',
      headers: authHeader(candidate),
    });
    expect(res.status).toBe(403);
    server.close();
  });

  it('409s a request already decided', async () => {
    const { db } = fakeDb({ existingRequest: { ...pending, state: 'approved' } });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests/tr-1/approve`, {
      method: 'POST',
      headers: authHeader(admin),
    });
    expect(res.status).toBe(409);
    server.close();
  });
});

describe('POST /training-requests/:id/decline (U22)', () => {
  const pending = { id: 'tr-1', orgId: 'org-1', userId: candidate.userId, toolId: TOOL, state: 'pending', createdAt: new Date() };

  it('declines without assigning anything (Admin)', async () => {
    const { db, insertValues, updateSet } = fakeDb({
      existingRequest: pending,
      updatedRequest: { ...pending, state: 'declined' },
    });
    mockDbValue = db;
    const { server, base } = startApp();
    const res = await fetch(`${base}/training-requests/tr-1/decline`, {
      method: 'POST',
      headers: authHeader(admin),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'declined' });
    expect(updateSet).toHaveBeenCalledWith(
      schema.trainingRequests,
      expect.objectContaining({ state: 'declined' }),
    );
    expect(insertValues).not.toHaveBeenCalled();
    server.close();
  });
});
