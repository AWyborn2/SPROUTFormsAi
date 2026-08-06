import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';
import { DEFAULT_ROLE_PERMISSIONS, type PermissionMatrix } from '@formai/shared';

const ORG = 'org-1';
const HOLDER = 'h-1';
const DOC = 'd-1';
const SUBJECT_USER = 'u-subject';
const KEY = `${ORG}/upload-abc123.jpg`;

const admin = { userId: 'u-admin', orgId: ORG, role: 'admin' as const };
const assessor = { userId: 'u-assessor', orgId: ORG, role: 'assessor' as const };
const subject = { userId: SUBJECT_USER, orgId: ORG, role: 'candidate' as const };
const otherCandidate = { userId: 'u-other', orgId: ORG, role: 'candidate' as const };

let sealSession: (t: { userId: string; orgId: string; role: string }) => string;

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

let mockStorage: {
  download: ReturnType<typeof vi.fn>;
  uploadAttachment: ReturnType<typeof vi.fn>;
} | null = null;
vi.mock('../storage/index.js', () => ({
  getStorageClient: () => mockStorage,
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

const BYTES = Buffer.from('\xff\xd8\xff\xe0 not really a jpeg', 'binary');

function fakeDb(opts: {
  matrix?: PermissionMatrix;
  doc?: Record<string, unknown> | null;
  docs?: unknown[];
} = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const doc =
    opts.doc === null
      ? undefined
      : {
          id: DOC,
          orgId: ORG,
          competencyHolderId: HOLDER,
          storageKey: KEY,
          fileName: 'licence.jpg',
          contentType: 'image/jpeg',
          state: 'held',
          ...(opts.doc ?? {}),
        };
  const db = {
    query: {
      organizations: {
        findFirst: vi.fn().mockResolvedValue({ id: ORG, planTier: 'business', displayIdentifier: 'employee_number' }),
      },
      rolePermissions: { findFirst: vi.fn().mockResolvedValue(opts.matrix ? { matrix: opts.matrix } : undefined) },
      competencyHolders: {
        findFirst: vi.fn().mockResolvedValue({ id: HOLDER, orgId: ORG, userId: SUBJECT_USER }),
      },
      memberships: {
        findFirst: vi.fn().mockResolvedValue({ id: 'm-1', userId: SUBJECT_USER, orgId: ORG }),
      },
      competencyDocuments: {
        findFirst: vi.fn().mockResolvedValue(doc),
        findMany: vi.fn().mockResolvedValue(opts.docs ?? []),
      },
      users: { findFirst: vi.fn().mockResolvedValue({ id: admin.userId, name: 'Admin' }) },
    },
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          updates.push(v);
        },
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        audits.push(v);
        const rows = [{ id: DOC, ...v }];
        return { returning: async () => rows, then: (r: (x: unknown) => void) => r(rows) };
      },
    }),
    /*
      Accepting a replacement supersedes the held row and promotes the pending
      one as ONE step (R31), so the double must run the callback rather than
      throw — a fixture without it would make the atomicity untestable.
    */
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  mockDbValue = db as unknown as Db;
  mockStorage = {
    download: vi.fn().mockResolvedValue(BYTES),
    // The attach and replacement paths go through the one validator, which
    // mints the key server-side.
    uploadAttachment: vi.fn().mockResolvedValue(KEY),
  };
  return { db, updates, audits };
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
  mockStorage = null;
});

/** Every refusal must be the SAME response, or the route becomes an oracle. */
async function expectNotFound(res: Response) {
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: 'not_found' });
}

describe('GET /competency-documents/file/:id — the refusals', () => {
  it('serves the file itself to a caller the organisation admits', async () => {
    // AE13 / R25–R27: the document, not a note that one exists.
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.assessor });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-documents/file/${DOC}`, { headers: authHeader(assessor) });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      expect(Buffer.from(await res.arrayBuffer()).length).toBe(BYTES.length);
    } finally {
      server.close();
    }
  });

  it('refuses a caller holding no grant, indistinguishably from a document that does not exist', async () => {
    // AE14 / R30: a key is not a permission, and the refusal leaks nothing.
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.viewer });
    const { server, base } = startApp();
    try {
      const denied = await fetch(`${base}/competency-documents/file/${DOC}`, { headers: authHeader(otherCandidate) });
      await expectNotFound(denied);
    } finally {
      server.close();
    }

    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.assessor, doc: null });
    const { server: s2, base: b2 } = startApp();
    try {
      const absent = await fetch(`${b2}/competency-documents/file/${DOC}`, { headers: authHeader(assessor) });
      await expectNotFound(absent);
    } finally {
      s2.close();
    }
  });

  it('refuses a document belonging to another organisation', async () => {
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin, doc: { orgId: 'org-2' } });
    const { server, base } = startApp();
    try {
      await expectNotFound(await fetch(`${base}/competency-documents/file/${DOC}`, { headers: authHeader(admin) }));
    } finally {
      server.close();
    }
  });

  it('refuses a key outside the attachment namespace before any storage call', async () => {
    const { db } = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin, doc: { storageKey: `${ORG}/logo-abc.png` } });
    const { server, base } = startApp();
    try {
      await expectNotFound(await fetch(`${base}/competency-documents/file/${DOC}`, { headers: authHeader(admin) }));
      expect(mockStorage!.download).not.toHaveBeenCalled();
      void db;
    } finally {
      server.close();
    }
  });

  it('refuses a key whose org prefix is not the caller’s', async () => {
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin, doc: { storageKey: 'org-2/upload-abc123.jpg' } });
    const { server, base } = startApp();
    try {
      await expectNotFound(await fetch(`${base}/competency-documents/file/${DOC}`, { headers: authHeader(admin) }));
      expect(mockStorage!.download).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('refuses an access level holding view on FIELDS but not on documents (R44)', async () => {
    // The distinction `view_documents` exists for. Gating this route on `view`
    // would make the new action decorative.
    fakeDb({
      matrix: {
        ...DEFAULT_ROLE_PERMISSIONS.assessor,
        profiles: { view: true, edit: false, approve: false, view_documents: false, view_competencies: true },
      } as PermissionMatrix,
    });
    const { server, base } = startApp();
    try {
      await expectNotFound(await fetch(`${base}/competency-documents/file/${DOC}`, { headers: authHeader(assessor) }));
    } finally {
      server.close();
    }
  });

  it('serves an access level holding view on DOCUMENTS but not on fields (R44)', async () => {
    fakeDb({
      matrix: {
        ...DEFAULT_ROLE_PERMISSIONS.assessor,
        profiles: { view: false, edit: false, approve: false, view_documents: true, view_competencies: false },
      } as PermissionMatrix,
    });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-documents/file/${DOC}`, { headers: authHeader(assessor) });
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('opens a document on their own record to the subject candidate, with no grant at all (R50)', async () => {
    fakeDb({
      matrix: {
        ...DEFAULT_ROLE_PERMISSIONS.candidate,
        profiles: { view: false, edit: false, approve: false, view_documents: false, view_competencies: false },
      } as PermissionMatrix,
    });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-documents/file/${DOC}`, { headers: authHeader(subject) });
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('carries the nosniff and sandbox headers and is not shared-cacheable', async () => {
    // Respondent-supplied bytes: never let a browser sniff to a scriptable type,
    // and never let a licence image sit in a shared cache.
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-documents/file/${DOC}`, { headers: authHeader(admin) });
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toContain('sandbox');
      expect(res.headers.get('cache-control')).toContain('private');
    } finally {
      server.close();
    }
  });
});

describe('the ungated attachment route no longer serves these bytes', () => {
  it('refuses a competency document key replayed through GET /uploads/file/*, before any storage call', async () => {
    /*
      R30, R44. The keys are deliberately indistinguishable — reusing the one
      validator is the point — so the attachment route, which authorises on
      tenancy alone, would otherwise serve a licence image to any member of the
      organisation and make `view_documents` decorative.
    */
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/uploads/file/${KEY}`, { headers: authHeader(admin) });
      await expectNotFound(res);
      expect(mockStorage!.download).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('still serves an ordinary submission attachment', async () => {
    // The refusal must be scoped to keys this table claims, not to the route.
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin, doc: null });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/uploads/file/${KEY}`, { headers: authHeader(admin) });
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });
});

describe('the candidate’s replacement document (R52)', () => {
  const upload = { fileBase64: BYTES.toString('base64'), mimeType: 'image/jpeg', fileName: 'clear.jpg' };

  it('lands as PENDING rather than as the record’s evidence', async () => {
    /*
      AE15: the dark photograph stays the record's evidence until an approver
      accepts the replacement. Expressed as a state rather than a new door,
      which is what keeps R51 true — a pending row is a submission for review,
      not a write, so the candidate has still written only their three fields.
    */
    const { audits } = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.candidate });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-documents/${HOLDER}/replacement`, {
        method: 'POST',
        headers: { ...authHeader(subject), 'content-type': 'application/json' },
        body: JSON.stringify(upload),
      });
      expect(res.status).toBe(201);
      expect(audits.some((a) => a.state === 'pending')).toBe(true);
      expect(audits.some((a) => a.state === 'held')).toBe(false);
    } finally {
      server.close();
    }
  });

  it('refuses a replacement on somebody ELSE’s record', async () => {
    // R52 is the subject's rule; nobody supplies one on another's behalf.
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.candidate });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-documents/${HOLDER}/replacement`, {
        method: 'POST',
        headers: { ...authHeader(otherCandidate), 'content-type': 'application/json' },
        body: JSON.stringify(upload),
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('refuses an ADMIN using the replacement path — theirs is the attach route', async () => {
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-documents/${HOLDER}/replacement`, {
        method: 'POST',
        headers: { ...authHeader(admin), 'content-type': 'application/json' },
        body: JSON.stringify(upload),
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('rate-limits repeated submissions from one membership', async () => {
    /*
      The least-privileged actor gets a permanent write into storage and into
      the queue humans work, every rejected one is retained by design, and the
      only removal verb is Admin-only. Unbounded means unbounded.
    */
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.candidate });
    const { server, base } = startApp();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 14; i++) {
        const res = await fetch(`${base}/competency-documents/${HOLDER}/replacement`, {
          method: 'POST',
          headers: { ...authHeader(subject), 'content-type': 'application/json' },
          body: JSON.stringify(upload),
        });
        codes.push(res.status);
      }
      expect(codes).toContain(429);
    } finally {
      server.close();
    }
  });

  it('accepting one supersedes the document it replaced, in one step (R31)', async () => {
    // AE15: once accepted the clear photograph is what is held, and the dark one
    // is retained as evidence of what was sighted at the time. Never a moment
    // with two held documents or none.
    const { updates } = fakeDb({
      matrix: DEFAULT_ROLE_PERMISSIONS.admin,
      doc: { state: 'pending' },
      docs: [{ id: 'd-old', state: 'held' }],
    });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-documents/${DOC}/approve`, {
        method: 'POST',
        headers: { ...authHeader(admin), 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(204);
      expect(updates.some((u) => u.state === 'superseded')).toBe(true);
      expect(updates.some((u) => u.state === 'held')).toBe(true);
    } finally {
      server.close();
    }
  });

  it('rejecting one leaves the held document in force and keeps the submission', async () => {
    // The deliberate difference from rejecting a HELD document: this one never
    // became evidence, so the record is exactly as it was.
    const { updates } = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin, doc: { state: 'pending' } });
    const { server, base } = startApp();
    try {
      await fetch(`${base}/competency-documents/${DOC}/reject`, {
        method: 'POST',
        headers: { ...authHeader(admin), 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'still unreadable' }),
      });
      // Retained as a record of what was submitted, not discarded.
      expect(updates[0]).toMatchObject({ state: 'rejected', rejectedReason: 'still unreadable' });
      expect(updates.some((u) => u.state === 'superseded')).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe('approval and rejection, and what neither changes', () => {
  it('lets an assessor approve on the shipped defaults (R42, R55)', async () => {
    // AE1: viewing and approving a candidate's documents is the default reach.
    const { updates } = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.assessor });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-documents/${DOC}/approve`, {
        method: 'POST',
        headers: { ...authHeader(assessor), 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(204);
      expect(updates[0]).toMatchObject({ approvedByUserId: assessor.userId });
      expect(updates[0]!.approvedAt).toBeInstanceOf(Date);
    } finally {
      server.close();
    }
  });

  it('refuses an access level granted view but NOT approve (R39)', async () => {
    // Approving is a verb of its own: a document is approved without being
    // changed, so viewing one does not admit you to accept it.
    fakeDb({
      matrix: {
        ...DEFAULT_ROLE_PERMISSIONS.assessor,
        profiles: { view: true, edit: false, approve: false, view_documents: true, view_competencies: true },
      } as PermissionMatrix,
    });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-documents/${DOC}/approve`, {
        method: 'POST',
        headers: { ...authHeader(assessor), 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('never lets the subject candidate approve their own document (R52)', async () => {
    // Their read of it is fixed (R50); accepting it is not theirs.
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.candidate });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-documents/${DOC}/approve`, {
        method: 'POST',
        headers: { ...authHeader(subject), 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('writes NOTHING to the competency grant when approving (R43)', async () => {
    /*
      AE17: an approval changes neither currency, nor standing, nor whether the
      competency satisfies a prerequisite. The strongest form of that assertion
      is that the grant row is never touched at all.
    */
    const { updates } = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin });
    const { server, base } = startApp();
    try {
      await fetch(`${base}/competency-documents/${DOC}/approve`, {
        method: 'POST',
        headers: { ...authHeader(admin), 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const touched = updates.flatMap((u) => Object.keys(u));
      expect(touched).not.toContain('revokedAt');
      expect(touched).not.toContain('expiresAt');
      expect(touched).not.toContain('grantedAt');
    } finally {
      server.close();
    }
  });

  it('rejects with a reason and revokes no competency (R47)', async () => {
    // AE17: revocation means the qualification was withdrawn, and an illegible
    // photograph is not that.
    const { updates } = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.assessor });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-documents/${DOC}/reject`, {
        method: 'POST',
        headers: { ...authHeader(assessor), 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'photograph too dark to read' }),
      });
      expect(res.status).toBe(204);
      expect(updates[0]).toMatchObject({ rejectedReason: 'photograph too dark to read' });
      const touched = updates.flatMap((u) => Object.keys(u));
      expect(touched).not.toContain('revokedAt');
      expect(touched).not.toContain('revokedReason');
    } finally {
      server.close();
    }
  });

  it('refuses a rejection carrying no reason', async () => {
    // The reason is what an Admin resolves the document against.
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.assessor });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-documents/${DOC}/reject`, {
        method: 'POST',
        headers: { ...authHeader(assessor), 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('clears an earlier rejection when the same document is later approved', async () => {
    const { updates } = fakeDb({
      matrix: DEFAULT_ROLE_PERMISSIONS.admin,
      doc: { rejectedAt: new Date(), rejectedReason: 'too dark' },
    });
    const { server, base } = startApp();
    try {
      await fetch(`${base}/competency-documents/${DOC}/approve`, {
        method: 'POST',
        headers: { ...authHeader(admin), 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(updates[0]).toMatchObject({ rejectedAt: null, rejectedReason: null });
    } finally {
      server.close();
    }
  });

  it('leaves an unapproved document held and listed rather than blocking (R46)', async () => {
    /*
      AE17: not checked yet is not the same as in doubt. Nothing about a
      document's approval state changes what the competency is worth, which is
      why the list returns it in `held` with a null approval and no other
      qualification.
    */
    fakeDb({
      matrix: DEFAULT_ROLE_PERMISSIONS.assessor,
      docs: [{ id: 'd-1', fileName: 'a.jpg', contentType: 'image/jpeg', state: 'held', uploadedAt: new Date() }],
    });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-documents/${HOLDER}`, { headers: authHeader(assessor) });
      const body = (await res.json()) as Array<{ state: string; approvedAt: string | null }>;
      expect(body[0]).toMatchObject({ state: 'held', approvedAt: null });
    } finally {
      server.close();
    }
  });
});

describe('DELETE /competency-documents/:id', () => {
  it('refuses an assessor and admits an Admin, recording the reason (R32)', async () => {
    // AE16: the assessor asks, the Admin removes.
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.assessor });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-documents/${DOC}`, {
        method: 'DELETE',
        headers: { ...authHeader(assessor), 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'wrong person' }),
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }

    const { updates, audits } = fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin });
    const { server: s2, base: b2 } = startApp();
    try {
      const res = await fetch(`${b2}/competency-documents/${DOC}`, {
        method: 'DELETE',
        headers: { ...authHeader(admin), 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'attached to the wrong person' }),
      });
      expect(res.status).toBe(204);
      // A STATE CHANGE, not a delete — the row and the object both stay (R31).
      expect(updates[0]).toMatchObject({ state: 'removed', removedReason: 'attached to the wrong person' });
      expect(audits.some((a) => a.category === 'profiles')).toBe(true);
    } finally {
      s2.close();
    }
  });

  it('refuses a removal carrying no reason', async () => {
    // An unexplained removal is what the audit line exists to prevent.
    fakeDb({ matrix: DEFAULT_ROLE_PERMISSIONS.admin });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-documents/${DOC}`, {
        method: 'DELETE',
        headers: { ...authHeader(admin), 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });
});

describe('GET /competency-documents/:holderId', () => {
  it('lists several documents on one competency (R28)', async () => {
    fakeDb({
      matrix: DEFAULT_ROLE_PERMISSIONS.assessor,
      docs: [
        { id: 'd-1', fileName: 'a.jpg', contentType: 'image/jpeg', state: 'held', uploadedAt: new Date() },
        { id: 'd-2', fileName: 'b.pdf', contentType: 'application/pdf', state: 'held', uploadedAt: new Date() },
      ],
    });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-documents/${HOLDER}`, { headers: authHeader(assessor) });
      expect(res.status).toBe(200);
      expect((await res.json()) as unknown[]).toHaveLength(2);
    } finally {
      server.close();
    }
  });

  it('keeps a removed document retrievable beside the held ones (R31, R32)', async () => {
    fakeDb({
      matrix: DEFAULT_ROLE_PERMISSIONS.admin,
      docs: [
        { id: 'd-1', fileName: 'a.jpg', contentType: 'image/jpeg', state: 'held', uploadedAt: new Date() },
        { id: 'd-2', fileName: 'old.jpg', contentType: 'image/jpeg', state: 'removed', uploadedAt: new Date() },
        { id: 'd-3', fileName: 'sup.jpg', contentType: 'image/jpeg', state: 'superseded', uploadedAt: new Date() },
      ],
    });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-documents/${HOLDER}`, { headers: authHeader(admin) });
      const body = (await res.json()) as Array<{ state: string }>;
      expect(body.map((d) => d.state).sort()).toEqual(['held', 'removed', 'superseded']);
    } finally {
      server.close();
    }
  });

  it('refuses the list to an access level without the document grant (R44)', async () => {
    fakeDb({
      matrix: {
        ...DEFAULT_ROLE_PERMISSIONS.assessor,
        profiles: { view: true, edit: false, approve: false, view_documents: false, view_competencies: true },
      } as PermissionMatrix,
    });
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/competency-documents/${HOLDER}`, { headers: authHeader(assessor) });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });
});
