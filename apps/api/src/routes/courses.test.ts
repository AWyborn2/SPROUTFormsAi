/**
 * Course packages, end to end: import (unzip, validate, detect the launch
 * page and kind), listing, archiving, and the token-credentialed content
 * door the player's sandboxed iframe loads through.
 *
 * The zip fixtures are BUILT here with the same fflate the route unpacks
 * with — testing against a hand-encoded base64 blob would freeze one
 * archiver's quirks into the suite.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import type { Db } from '@formai/db';
import { schema } from '@formai/db';
import { DEFAULT_ROLE_PERMISSIONS } from '@formai/shared';

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const admin = { userId: 'u-admin', orgId: ORG, role: 'admin' as const };
const candidate = { userId: 'u-cand', orgId: ORG, role: 'candidate' as const };

let sealSession: (t: { userId: string; orgId: string; role: string }) => string;

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

/** Unconfigured by default — each test that needs a bucket swaps one in. */
let mockStorage: unknown = null;
vi.mock('../storage/index.js', () => ({
  getStorageClient: () => mockStorage,
}));

const { createApp } = await import('../app.js');
({ sealSession } = await import('../auth/workos.js'));
const { deckSlideCount, mintCourseContentPath, normalizeCourseEntryPath, scormLaunchHref } =
  await import('./courses.js');

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

const auth = (t: { userId: string; orgId: string; role: string } = admin) => ({
  cookie: `fai_session=${sealSession(t)}`,
  'content-type': 'application/json',
});

/*
  The same value-matching fake the assessments suite uses: every filter in
  this router is equality on identifying string columns, so requiring each
  bound param to appear among the row's values is exact here. The walk skips
  drizzle's structural keys (they hold circular references) and is depth-
  capped for the same reason.
*/
const SKIP_KEYS = new Set(['table', 'config', 'encoder', 'decoder', 'session', 'dialect', 'default']);
function boundValues(node: unknown, out: string[] = [], depth = 0): string[] {
  if (!node || depth > 10) return out;
  if (Array.isArray(node)) {
    for (const n of node) boundValues(n, out, depth + 1);
    return out;
  }
  if (typeof node !== 'object') return out;
  const rec = node as Record<string, unknown>;
  if (typeof rec.value === 'string') out.push(rec.value);
  for (const [k, v] of Object.entries(rec)) if (!SKIP_KEYS.has(k)) boundValues(v, out, depth + 1);
  return out;
}
function matchesWhere(row: Record<string, unknown>, where: unknown): boolean {
  if (!where) return true;
  const wanted = new Set(boundValues(where));
  const present = new Set(Object.values(row).filter((v) => typeof v === 'string'));
  return [...wanted].every((w) => present.has(w));
}

let idSeq = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, '0')}`;

function makeDb() {
  const store: Record<string, Record<string, unknown>[]> = {
    organizations: [
      { id: ORG, planTier: 'business', seatLimit: 15, candidateSeatLimit: 200 },
      { id: OTHER_ORG, planTier: 'business', seatLimit: 15, candidateSeatLimit: 200 },
    ],
    rolePermissions: [
      { id: nextId(), orgId: ORG, role: 'admin', matrix: DEFAULT_ROLE_PERMISSIONS.admin },
      { id: nextId(), orgId: ORG, role: 'candidate', matrix: DEFAULT_ROLE_PERMISSIONS.candidate },
    ],
    courses: [],
    assessmentTools: [],
    auditLogEntries: [],
    users: [],
    // requireTenant resolves the caller's membership when a db is present.
    memberships: [
      { id: nextId(), orgId: ORG, userId: admin.userId, role: 'admin', status: 'active' },
      { id: nextId(), orgId: ORG, userId: candidate.userId, role: 'candidate', status: 'active' },
    ],
  };

  const nameOf = (table: unknown) =>
    Object.keys(schema).find((k) => (schema as Record<string, unknown>)[k] === table) ?? '';

  const query = Object.fromEntries(
    Object.keys(store).map((name) => [
      name,
      {
        findFirst: async (args?: { where?: unknown }) =>
          store[name]!.find((r) => matchesWhere(r, args?.where)),
        findMany: async (args?: { where?: unknown }) =>
          store[name]!.filter((r) => matchesWhere(r, args?.where)),
      },
    ]),
  );

  const db = {
    query,
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown> | Record<string, unknown>[]) => {
        const rows = (Array.isArray(v) ? v : [v]).map((r) => ({
          id: nextId(),
          createdAt: new Date(),
          ...r,
        }));
        store[nameOf(table)]?.push(...rows);
        const p = Promise.resolve(undefined) as Promise<undefined> & {
          returning: () => Promise<unknown[]>;
        };
        p.returning = () => Promise.resolve(rows);
        return p;
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async (w: unknown) => {
          for (const row of store[nameOf(table)] ?? [])
            if (matchesWhere(row, w)) Object.assign(row, patch);
        },
      }),
    }),
  } as unknown as Db;

  return { db, store };
}

/** Fake storage capturing course-file uploads and serving stored bytes back. */
function fakeStorage() {
  const objects = new Map<string, Buffer>();
  const uploadCourseFile = vi.fn(
    async (orgId: string, courseId: string, path: string, bytes: Uint8Array) => {
      const key = `${orgId}/course-${courseId}/${path}`;
      objects.set(key, Buffer.from(bytes));
      return key;
    },
  );
  const download = vi.fn(async (_orgId: string, key: string) => objects.get(key) ?? null);
  const client = {
    upload: vi.fn(),
    uploadImage: vi.fn(),
    uploadAttachment: vi.fn(),
    uploadCourseFile,
    download,
    deleteObject: vi.fn(),
    deletePrefix: vi.fn(),
  };
  return { client, objects, uploadCourseFile, download };
}

const DECK_HTML = [
  '<!DOCTYPE html><html><head><script src="./deck-stage.js"></script></head><body>',
  '<deck-stage width="1920" height="1080">',
  '<section data-label="One">1</section>',
  '<section data-label="Two">2</section>',
  '<section data-label="Notes" data-deck-skip>hidden</section>',
  '<section data-label="Three">3</section>',
  '</deck-stage></body></html>',
].join('\n');

function deckZip(): string {
  return Buffer.from(
    zipSync({
      'index.html': strToU8(DECK_HTML),
      'deck-stage.js': strToU8('/* viewer */'),
      'img/cover.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    }),
  ).toString('base64');
}

async function postCourse(
  base: string,
  body: unknown,
  tenant: { userId: string; orgId: string; role: string } = admin,
) {
  return fetch(`${base}/courses`, {
    method: 'POST',
    headers: auth(tenant),
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  mockStorage = null;
  mockDbValue = null;
  vi.restoreAllMocks();
});

describe('course package plumbing', () => {
  it('normalizes safe entry paths and rejects everything traversal-shaped', () => {
    expect(normalizeCourseEntryPath('img/cover.png')).toBe('img/cover.png');
    expect(normalizeCourseEntryPath('./index.html')).toBe('index.html');
    // Windows-built archives arrive with backslashes; they read as separators.
    expect(normalizeCourseEntryPath('img\\cover.png')).toBe('img/cover.png');
    expect(normalizeCourseEntryPath('../evil.js')).toBeNull();
    expect(normalizeCourseEntryPath('img/../../evil.js')).toBeNull();
    expect(normalizeCourseEntryPath('/etc/passwd')).toBeNull();
    expect(normalizeCourseEntryPath('a//b.png')).toBeNull();
    expect(normalizeCourseEntryPath('')).toBeNull();
    expect(normalizeCourseEntryPath('a/./b.png')).toBeNull();
  });

  it('reads the SCORM launch from the item ref, falling back to the sco resource', () => {
    const manifest = `
      <manifest><organizations default="ORG"><organization identifier="ORG">
        <item identifier="I1" identifierref="R2"><title>Course</title></item>
      </organization></organizations>
      <resources>
        <resource identifier="R1" type="webcontent" href="wrong.html"/>
        <resource identifier="R2" type="webcontent" adlcp:scormtype="sco" href="content/sco.html"/>
      </resources></manifest>`;
    expect(scormLaunchHref(manifest)).toBe('content/sco.html');
    const noItems = `
      <manifest><resources>
        <resource identifier="R1" type="webcontent" href="asset.html"/>
        <resource identifier="R2" adlcp:scormtype="sco" href="the-sco.html"/>
      </resources></manifest>`;
    expect(scormLaunchHref(noItems)).toBe('the-sco.html');
    expect(scormLaunchHref('<manifest/>')).toBeNull();
  });

  it('counts a deck page in sections, skipping the skipped', () => {
    expect(deckSlideCount(DECK_HTML)).toBe(3);
    expect(deckSlideCount('<html><section>no viewer here</section></html>')).toBeNull();
  });
});

describe('POST /courses', () => {
  it('imports a deck package: files stored per path, slide census recorded', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    const storage = fakeStorage();
    mockStorage = storage.client;
    const { server, base } = startApp();
    try {
      const res = await postCourse(base, { title: 'SME Manual', zipBase64: deckZip() });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        title: 'SME Manual',
        kind: 'deck',
        launchPath: 'index.html',
        slideCount: 3,
        fileCount: 3,
        status: 'active',
      });
      expect(storage.uploadCourseFile).toHaveBeenCalledTimes(3);
      const paths = storage.uploadCourseFile.mock.calls.map((c) => c[2]).sort();
      expect(paths).toEqual(['deck-stage.js', 'img/cover.png', 'index.html']);
      const row = store.courses![0] as { files: { path: string; contentType: string }[] };
      expect(row.files.find((f) => f.path === 'index.html')!.contentType).toContain('text/html');
    } finally {
      server.close();
    }
  });

  it('imports a SCORM package by its manifest, with no slide stream', async () => {
    const { db } = makeDb();
    mockDbValue = db;
    mockStorage = fakeStorage().client;
    const { server, base } = startApp();
    try {
      const zip = Buffer.from(
        zipSync({
          'imsmanifest.xml': strToU8(
            '<manifest><organizations default="O"><organization identifier="O">' +
              '<item identifier="I" identifierref="R"/></organization></organizations>' +
              '<resources><resource identifier="R" adlcp:scormtype="sco" href="content/sco.html"/></resources></manifest>',
          ),
          'content/sco.html': strToU8('<html><body>lesson</body></html>'),
        }),
      ).toString('base64');
      const res = await postCourse(base, { title: 'Vendor module', zipBase64: zip });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({
        kind: 'scorm',
        launchPath: 'content/sco.html',
        slideCount: null,
      });
    } finally {
      server.close();
    }
  });

  it('refuses traversal paths, unsupported types, and zips with no launch page', async () => {
    const { db } = makeDb();
    mockDbValue = db;
    mockStorage = fakeStorage().client;
    const { server, base } = startApp();
    try {
      const traversal = Buffer.from(
        zipSync({ '../evil.js': strToU8('x'), 'index.html': strToU8('<html/>') }),
      ).toString('base64');
      const r1 = await postCourse(base, { title: 'T', zipBase64: traversal });
      expect(r1.status).toBe(400);
      expect(((await r1.json()) as { error: string }).error).toBe('invalid_course_path');

      const exe = Buffer.from(
        zipSync({ 'index.html': strToU8('<html/>'), 'run.exe': strToU8('MZ') }),
      ).toString('base64');
      const r2 = await postCourse(base, { title: 'T', zipBase64: exe });
      expect(r2.status).toBe(400);
      expect(((await r2.json()) as { error: string }).error).toBe('unsupported_course_file');

      const noLaunch = Buffer.from(zipSync({ 'styles.css': strToU8('body{}') })).toString('base64');
      const r3 = await postCourse(base, { title: 'T', zipBase64: noLaunch });
      expect(r3.status).toBe(400);
      expect(((await r3.json()) as { error: string }).error).toBe('launch_not_found');

      const r4 = await postCourse(base, { title: 'T', zipBase64: Buffer.from('junk').toString('base64') });
      expect(r4.status).toBe(400);
      expect(((await r4.json()) as { error: string }).error).toBe('invalid_zip');
    } finally {
      server.close();
    }
  });

  it('macOS junk is skipped rather than judged', async () => {
    const { db } = makeDb();
    mockDbValue = db;
    const storage = fakeStorage();
    mockStorage = storage.client;
    const { server, base } = startApp();
    try {
      const zip = Buffer.from(
        zipSync({
          'index.html': strToU8('<html/>'),
          '__MACOSX/._index.html': strToU8('junk'),
          'img/.DS_Store': strToU8('junk'),
        }),
      ).toString('base64');
      const res = await postCourse(base, { title: 'T', zipBase64: zip });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { fileCount: number }).fileCount).toBe(1);
    } finally {
      server.close();
    }
  });

  it('is authoring work: a candidate may not import', async () => {
    const { db } = makeDb();
    mockDbValue = db;
    mockStorage = fakeStorage().client;
    const { server, base } = startApp();
    try {
      const res = await postCourse(base, { title: 'T', zipBase64: deckZip() }, candidate);
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });
});

describe('GET /courses and DELETE /courses/:id', () => {
  it('lists active packages only, and archiving hides one unless a tool still points at it', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    mockStorage = fakeStorage().client;
    const { server, base } = startApp();
    try {
      const created = (await (
        await postCourse(base, { title: 'SME Manual', zipBase64: deckZip() })
      ).json()) as { id: string };

      // A tool holding the link blocks the archive with the tools' names.
      store.assessmentTools!.push({
        id: nextId(),
        orgId: ORG,
        name: 'Mine Site SME Theory',
        manifest: { parts: [], course: { courseId: created.id, required: true } },
      });
      const blocked = await fetch(`${base}/courses/${created.id}`, {
        method: 'DELETE',
        headers: auth(),
      });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({
        error: 'course_in_use',
        tools: ['Mine Site SME Theory'],
      });

      store.assessmentTools!.length = 0;
      const archived = await fetch(`${base}/courses/${created.id}`, {
        method: 'DELETE',
        headers: auth(),
      });
      expect(archived.status).toBe(200);

      const list = (await (await fetch(`${base}/courses`, { headers: auth() })).json()) as {
        courses: unknown[];
      };
      expect(list.courses).toHaveLength(0);

      // Archiving twice is a 404 — the row is no longer an active course.
      const again = await fetch(`${base}/courses/${created.id}`, {
        method: 'DELETE',
        headers: auth(),
      });
      expect(again.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('GET /courses/content/:token/*', () => {
  async function importedCourse(base: string) {
    const res = await postCourse(base, { title: 'SME Manual', zipBase64: deckZip() });
    return (await res.json()) as { id: string };
  }

  it('serves allowlisted files with the sandboxing headers, HTML scripts allowed', async () => {
    const { db } = makeDb();
    mockDbValue = db;
    const storage = fakeStorage();
    mockStorage = storage.client;
    const { server, base } = startApp();
    try {
      const course = await importedCourse(base);
      const { prefix } = mintCourseContentPath(ORG, course.id);

      const page = await fetch(`${base}${prefix}/index.html`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(page.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
      expect(page.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await page.text()).toContain('deck-stage');

      // Non-page bytes are inert, exactly like a served attachment.
      const img = await fetch(`${base}${prefix}/img/cover.png`);
      expect(img.status).toBe(200);
      expect(img.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    } finally {
      server.close();
    }
  });

  it('answers an identical 404 for a forged token, a stray path, and an archived course', async () => {
    const { db, store } = makeDb();
    mockDbValue = db;
    mockStorage = fakeStorage().client;
    const { server, base } = startApp();
    try {
      const course = await importedCourse(base);
      const { prefix } = mintCourseContentPath(ORG, course.id);

      const forged = await fetch(`${base}/courses/content/not-a-token/index.html`);
      expect(forged.status).toBe(404);

      const stray = await fetch(`${base}${prefix}/secrets.txt`);
      expect(stray.status).toBe(404);

      // A token minted for one org must not read another's course.
      const crossOrg = mintCourseContentPath(OTHER_ORG, course.id);
      const cross = await fetch(`${base}${crossOrg.prefix}/index.html`);
      expect(cross.status).toBe(404);

      (store.courses![0] as { status: string }).status = 'archived';
      const archived = await fetch(`${base}${prefix}/index.html`);
      expect(archived.status).toBe(404);
    } finally {
      server.close();
    }
  });
});
