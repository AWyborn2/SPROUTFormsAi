/**
 * /form-brands — the clients a form can be presented as.
 *
 * A brand names a client and carries their logo, so the property this file
 * exists to pin is that ONE ORG CANNOT SEE ANOTHER'S. The list of brands an org
 * holds is the list of companies it subcontracts for, which is commercially
 * sensitive in a way a colour is not — every query here is org-scoped in its
 * WHERE clause, and the tests below check the scope reaches the query rather
 * than checking it after the row has already been loaded.
 *
 * The other property is that a duplicate name is refused. Two entries reading
 * "BBM" and "bbm" in one picker is a coin flip about which client's colours a
 * form renders in.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';

const admin = { userId: 'u1', orgId: 'org-1', role: 'admin' as const };
const builder = { userId: 'u2', orgId: 'org-1', role: 'builder' as const };
const viewer = { userId: 'u3', orgId: 'org-1', role: 'viewer' as const };

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

let mockStorage: { download: (orgId: string, key: string) => Promise<Buffer | null> } | null = null;
vi.mock('../storage/index.js', () => ({
  getStorageClient: () => mockStorage,
}));

const { createApp } = await import('../app.js');
const { sealSession } = await import('../auth/workos.js');

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

function authHeader(t: { userId: string; orgId: string; role: string }) {
  return { cookie: `fai_session=${sealSession(t)}`, 'content-type': 'application/json' };
}

function returningResult(rows: unknown[]) {
  const awaitable = Promise.resolve(undefined) as Promise<undefined> & {
    returning: () => Promise<unknown[]>;
  };
  awaitable.returning = vi.fn().mockResolvedValue(rows);
  return awaitable;
}

const BBM = {
  id: 'b-1',
  name: 'BBM',
  branding: {
    logoAssetUrl: '/api/assets/logo/org-1/logo-x.png',
    primaryColor: '#0044cc',
    theme: { radius: 4 },
  },
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

function fakeDb(opts: {
  findMany?: unknown[];
  findFirst?: unknown;
  inserted?: unknown;
  updated?: unknown;
  deleted?: unknown;
  /** Thrown by insert/update, to stand in for the unique index firing. */
  writeError?: Error;
} = {}) {
  const findManyArgs = vi.fn();
  const updateSet = vi.fn();
  const deleteWhere = vi.fn();
  const db = {
    query: {
      // `hasPermission` reads this first; undefined falls back to the shipped
      // default matrix, which is what every role assertion below relies on.
      rolePermissions: { findFirst: vi.fn().mockResolvedValue(undefined) },
      users: { findFirst: vi.fn().mockResolvedValue({ name: 'Ada' }) },
      formBrands: {
        findMany: vi.fn((args: unknown) => {
          findManyArgs(args);
          return Promise.resolve(opts.findMany ?? []);
        }),
        findFirst: vi.fn().mockResolvedValue(opts.findFirst),
      },
    },
    insert: vi.fn(() => ({
      values: () => {
        if (opts.writeError) throw opts.writeError;
        return returningResult([opts.inserted]);
      },
    })),
    update: vi.fn(() => ({
      set: (v: unknown) => {
        updateSet(v);
        return {
          where: () => {
            if (opts.writeError) throw opts.writeError;
            return returningResult([opts.updated]);
          },
        };
      },
    })),
    delete: vi.fn(() => ({
      where: (w: unknown) => {
        deleteWhere(w);
        return returningResult([opts.deleted]);
      },
    })),
  } as unknown as Db;
  return { db, findManyArgs, updateSet, deleteWhere };
}

afterEach(() => {
  mockDbValue = null;
  mockStorage = null;
  vi.restoreAllMocks();
});

describe('GET /form-brands', () => {
  it('refuses an unauthenticated caller', async () => {
    // The brand list names the org's clients. A URL is not a credential for it.
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands`);
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('scopes the query to the caller’s org', async () => {
    /*
      THE TEST THAT MATTERS MOST. The route never re-checks orgId after loading,
      by design — so if the scope ever leaves the WHERE clause, nothing
      downstream would catch it. This asserts the `findMany` is given a filter
      at all, which is the only place the scope lives.
    */
    const { db, findManyArgs } = fakeDb({ findMany: [BBM] });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands`, { headers: authHeader(admin) });
      expect(res.status).toBe(200);
      expect(findManyArgs).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.anything() }),
      );
    } finally {
      server.close();
    }
  });

  it('sorts by name, so the picker does not reshuffle between loads', async () => {
    // A list that reorders itself is a list somebody picks wrongly from.
    const { db } = fakeDb({
      findMany: [
        { ...BBM, id: 'b-2', name: 'Zenith' },
        { ...BBM, id: 'b-3', name: 'Acme' },
      ],
    });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands`, { headers: authHeader(admin) });
      const body = (await res.json()) as { name: string }[];
      expect(body.map((br) => br.name)).toEqual(['Acme', 'Zenith']);
    } finally {
      server.close();
    }
  });

  it('lets a Viewer read the list', async () => {
    // Reading is gated on forms:view, not forms:edit — the picker sits beside
    // a form somebody is already allowed to look at.
    mockDbValue = fakeDb({ findMany: [BBM] }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands`, { headers: authHeader(viewer) });
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });
});

describe('POST /form-brands', () => {
  it('creates a brand', async () => {
    mockDbValue = fakeDb({ inserted: BBM }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands`, {
        method: 'POST',
        headers: authHeader(admin),
        body: JSON.stringify({ name: 'BBM', branding: { primaryColor: '#0044cc' } }),
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ id: 'b-1', name: 'BBM' });
    } finally {
      server.close();
    }
  });

  it('reports a duplicate name as 409, from the index rather than a pre-read', async () => {
    /*
      A read-then-write check would let two people adding "BBM" at once both
      find nothing and both insert. The unique index is what refuses it, so the
      route's job is to recognise that failure — this asserts it does.
    */
    mockDbValue = fakeDb({
      writeError: new Error(
        'duplicate key value violates unique constraint "form_brands_org_name_uq"',
      ),
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands`, {
        method: 'POST',
        headers: authHeader(admin),
        body: JSON.stringify({ name: 'bbm' }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'duplicate_name' });
    } finally {
      server.close();
    }
  });

  it('lets any other write failure surface as a 500 rather than a 409', async () => {
    // Reporting an unrelated failure as "that name is taken" would send the
    // author renaming a brand that was never the problem.
    mockDbValue = fakeDb({ writeError: new Error('connection terminated') }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands`, {
        method: 'POST',
        headers: authHeader(admin),
        body: JSON.stringify({ name: 'BBM' }),
      });
      expect(res.status).toBe(500);
    } finally {
      server.close();
    }
  });

  it('refuses a logo pointing at another host', async () => {
    /*
      `logoAssetUrl` is a path we minted, not a URL a caller chose. An absolute
      one would make every respondent's browser fetch a client's form asset from
      somewhere else, handing that host the IP of everyone who opens the form.
    */
    mockDbValue = fakeDb({ inserted: BBM }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands`, {
        method: 'POST',
        headers: authHeader(admin),
        body: JSON.stringify({
          name: 'BBM',
          branding: { logoAssetUrl: 'https://evil.example/logo.png' },
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('refuses a Viewer', async () => {
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands`, {
        method: 'POST',
        headers: authHeader(viewer),
        body: JSON.stringify({ name: 'BBM' }),
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });
});

describe('PATCH /form-brands/:id', () => {
  it('MERGES THE PATCH INTO THE STORED KIT rather than replacing it', async () => {
    /*
      An edit that changes the colours must not blank the logo. The patch is
      per-key inside one jsonb column, so a plain write of the body would drop
      every key the author did not happen to re-send — including a client's
      logo, which would put ours back on their form.
    */
    const { db, updateSet } = fakeDb({ findFirst: BBM, updated: BBM });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands/b-1`, {
        method: 'PATCH',
        headers: authHeader(admin),
        body: JSON.stringify({ branding: { primaryColor: '#111111' } }),
      });
      expect(res.status).toBe(200);
      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          branding: {
            logoAssetUrl: '/api/assets/logo/org-1/logo-x.png',
            primaryColor: '#111111',
            theme: { radius: 4 },
          },
        }),
      );
    } finally {
      server.close();
    }
  });

  it('lets an explicit null REMOVE the brand’s logo', async () => {
    // `undefined` (not mentioned) and `null` ("this brand has no logo") have to
    // stay different, or "remove the client's logo" becomes unsayable and the
    // org's comes back on their form.
    const { db, updateSet } = fakeDb({ findFirst: BBM, updated: BBM });
    mockDbValue = db;
    const { server, base } = startApp();
    try {
      await fetch(`${base}/form-brands/b-1`, {
        method: 'PATCH',
        headers: authHeader(admin),
        body: JSON.stringify({ branding: { logoAssetUrl: null } }),
      });
      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          branding: expect.objectContaining({ logoAssetUrl: null, primaryColor: '#0044cc' }),
        }),
      );
    } finally {
      server.close();
    }
  });

  it('404s when the lookup matched nothing — including another org’s brand', async () => {
    /*
      The org filter is in the lookup's own WHERE, so another org's id simply
      matches no row. Indistinguishable from a nonexistent id on purpose: a
      different status would turn this route into a way to confirm that some
      other company uses the product.
    */
    mockDbValue = fakeDb({ findFirst: undefined }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands/someone-elses`, {
        method: 'PATCH',
        headers: authHeader(admin),
        body: JSON.stringify({ name: 'Renamed' }),
      });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('reports a rename onto an existing name as 409', async () => {
    mockDbValue = fakeDb({
      findFirst: BBM,
      writeError: new Error('unique constraint "form_brands_org_name_uq"'),
    }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands/b-1`, {
        method: 'PATCH',
        headers: authHeader(admin),
        body: JSON.stringify({ name: 'Acme' }),
      });
      expect(res.status).toBe(409);
    } finally {
      server.close();
    }
  });
});

describe('DELETE /form-brands/:id', () => {
  it('deletes the brand and answers 204', async () => {
    mockDbValue = fakeDb({ deleted: BBM }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands/b-1`, {
        method: 'DELETE',
        headers: authHeader(admin),
      });
      expect(res.status).toBe(204);
    } finally {
      server.close();
    }
  });

  it('refuses a Builder, who may edit forms but not delete', async () => {
    /*
      Deleting a brand reaches every form that used it, unstyling all of them at
      once. That is a delete-shaped act even though nothing named a form, so it
      is gated as one.
    */
    mockDbValue = fakeDb({ deleted: BBM }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands/b-1`, {
        method: 'DELETE',
        headers: authHeader(builder),
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('404s on another org’s brand rather than deleting it', async () => {
    mockDbValue = fakeDb({ deleted: undefined }).db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands/someone-elses`, {
        method: 'DELETE',
        headers: authHeader(admin),
      });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

/**
 * POST /form-brands/scan — reading a client's colours and logo off their PDF.
 *
 * A PROPOSAL, NEVER A DECISION: nothing is stored and no brand is created or
 * changed, which is what makes it safe to run against a document somebody else
 * authored. The tests below pin that, and pin the org scoping on the asset
 * path — the id is a key into storage, and it must never be the caller's word
 * for which org's document to read.
 */
describe('POST /form-brands/scan', () => {
  /** A one-page PDF drawing a rectangle in the given colour. */
  async function colouredPdf(): Promise<Buffer> {
    const { PDFDocument, rgb } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]).drawRectangle({
      x: 20,
      y: 700,
      width: 200,
      height: 40,
      color: rgb(0, 0.266, 0.8),
    });
    return Buffer.from(await doc.save());
  }

  async function scan(
    base: string,
    body: unknown,
    t: { userId: string; orgId: string; role: string } = admin,
  ) {
    return fetch(`${base}/form-brands/scan`, {
      method: 'POST',
      headers: authHeader(t),
      body: JSON.stringify(body),
    });
  }

  it('proposes the colours a document draws with', async () => {
    mockDbValue = fakeDb().db;
    const pdf = await colouredPdf();
    const { server, base } = startApp();
    try {
      const res = await scan(base, { pdfBase64: pdf.toString('base64') });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { colors: string[] }).colors).toContain('#0044cc');
    } finally {
      server.close();
    }
  });

  it('CHANGES NOTHING — no brand is created or written', async () => {
    /*
      The whole reason this is safe to point at a client's document. A scan that
      wrote its guesses would put a table-border colour on a brand and the author
      would have to undo it.
    */
    const { db, updateSet } = fakeDb();
    mockDbValue = db;
    const pdf = await colouredPdf();
    const { server, base } = startApp();
    try {
      await scan(base, { pdfBase64: pdf.toString('base64') });
      expect(db.insert).not.toHaveBeenCalled();
      expect(updateSet).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('READS THE ASSET UNDER THE SESSION’S ORG, not one named in the body', async () => {
    // The id is a key into storage. If the org came from the request, a caller
    // could read another org's document by supplying their id alongside it.
    const seen: string[] = [];
    mockStorage = {
      download: async (orgId, key) => {
        seen.push(`${orgId}/${key}`);
        return colouredPdf();
      },
    };
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      const res = await scan(base, { assetId: 'some-doc.pdf', orgId: 'org-2' });
      expect(res.status).toBe(200);
      expect(seen).toEqual(['org-1/some-doc.pdf']);
    } finally {
      server.close();
    }
  });

  it('404s for an asset that is not in the org’s storage', async () => {
    mockStorage = { download: async () => null };
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      expect((await scan(base, { assetId: 'missing.pdf' })).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('refuses a body carrying both an assetId and inline bytes', async () => {
    // Two sources means one is ignored, and which one is not visible to the
    // caller — the same refusal /answer-guides/match makes.
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      const res = await scan(base, { assetId: 'a.pdf', pdfBase64: 'eA==' });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('reports a monochrome document rather than inventing a colour', async () => {
    // A black-and-white form is a normal outcome. Making one up would be worse
    // than saying so.
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      const body = (await (
        await scan(base, { pdfBase64: Buffer.from(await doc.save()).toString('base64') })
      ).json()) as { colors: string[]; notes: string[] };
      expect(body.colors).toEqual([]);
      expect(body.notes.join(' ')).toMatch(/black and white/i);
    } finally {
      server.close();
    }
  });

  it('returns logo candidates as base64 the upload door already accepts', async () => {
    /*
      Base64 rather than uploaded URLs on purpose: uploading every candidate
      would leave an orphaned object for each one the author declined. The
      chosen one goes through the existing POST /org/logo, which is why the
      shape here matches what that route takes.
    */
    const { PDFDocument } = await import('pdf-lib');
    const { encodePng } = await import('../pdf/brand-logo.js');
    const samples = Buffer.alloc(120 * 60 * 3, 0x44);
    const doc = await PDFDocument.create();
    const img = await doc.embedPng(encodePng(samples, 120, 60, 3));
    doc.addPage([600, 800]).drawImage(img, { x: 20, y: 700, width: 120, height: 60 });

    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      const body = (await (
        await scan(base, { pdfBase64: Buffer.from(await doc.save()).toString('base64') })
      ).json()) as { logos: { imageBase64: string; mimeType: string; width: number }[] };
      expect(body.logos).toHaveLength(1);
      expect(body.logos[0]).toMatchObject({ mimeType: 'image/png', width: 120, height: 60 });
      // PNG magic, so the upload door's own magic-bytes check will pass.
      expect([...Buffer.from(body.logos[0]!.imageBase64, 'base64').subarray(0, 4)]).toEqual([
        0x89, 0x50, 0x4e, 0x47,
      ]);
    } finally {
      server.close();
    }
  });

  it('refuses a Viewer', async () => {
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      expect((await scan(base, { pdfBase64: 'eA==' }, viewer)).status).toBe(403);
    } finally {
      server.close();
    }
  });

  it('refuses an unauthenticated caller', async () => {
    mockDbValue = fakeDb().db;
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/form-brands/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pdfBase64: 'eA==' }),
      });
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });
});
