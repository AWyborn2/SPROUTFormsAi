import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { schema } from '@formai/db';
import type { CourseFileEntry } from '@formai/shared';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { hasPermission } from '../lib/permissions.js';
import { recordAudit } from '../audit/record.js';
import { sealSession, unsealSession } from '../auth/replit-auth.js';
import { getStorageClient } from '../storage/index.js';
import { db } from '../db.js';

/**
 * Course packages — the reading a candidate does before an assessment starts.
 *
 * A course arrives as ONE zip (an interactive deck export, a SCORM 1.2
 * package, or plain HTML content), is unpacked here, and every file is stored
 * individually in object storage under `{orgId}/course-{id}/{path}`. The row
 * in `courses` keeps the file list, and that list is the serving allowlist —
 * the content route answers only paths the import recorded.
 *
 * CONTENT IS SERVED BY CAPABILITY TOKEN, NOT SESSION. The player runs the
 * package inside a sandboxed iframe, and a sandboxed document has an opaque
 * origin — its subresource requests carry no cookies, so a session-gated
 * route would 401 every image the deck asks for. The token (same AES-GCM
 * sealer as the induction document links) names the org and course, rides in
 * the path, and expires on its own; it is minted by the case's course route,
 * which IS session-gated, so reaching the bytes still required a signed-in
 * member who can see the case.
 */
export const coursesRouter: Router = Router();

const GATE = [requireTenant, requirePlanFeature('assessments')] as const;

/** Upload caps — a course is a manual, not a media library. */
export const MAX_COURSE_ZIP_BYTES = 30 * 1024 * 1024;
const MAX_COURSE_UNPACKED_BYTES = 80 * 1024 * 1024;
const MAX_COURSE_FILES = 400;

/**
 * How long a minted content link stays usable. A reading session, not a
 * download click: the deck is opened once and paged through for as long as
 * the manual takes, so the induction documents' five minutes would strand a
 * reader mid-course when the iframe lazy-loads a later slide's image.
 */
const CONTENT_LINK_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Extension → served Content-Type, and the allowlist of what a package may
 * contain. Everything a self-contained HTML course legitimately ships —
 * markup, scripts, styles, images, fonts, captions, a little media — and
 * nothing executable server-side, because nothing here is ever executed
 * server-side: bytes go to object storage and come back with these types.
 */
export const COURSE_CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  vtt: 'text/vtt; charset=utf-8',
  map: 'application/json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/**
 * Normalizes one zip entry path, or returns null for anything that may not
 * be stored. The storage key is `{orgId}/course-{id}/{path}` with this PATH
 * embedded verbatim, so this is the only line of defence between an archive
 * built elsewhere and the org's storage prefix: no traversal, no absolute
 * paths, no control characters, no empty segments.
 */
export function normalizeCourseEntryPath(raw: string): string | null {
  let path = raw.replace(/\\/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  if (path.length === 0 || path.length > 300) return null;
  if (path.startsWith('/')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(path)) return null;
  const segments = path.split('/');
  if (segments.some((s) => s.length === 0 || s === '.' || s === '..')) return null;
  return path;
}

/** Junk archivers add that no package should be judged by. */
function isZipNoise(path: string): boolean {
  return (
    path.startsWith('__MACOSX/') ||
    path.split('/').pop() === '.DS_Store' ||
    path.split('/').pop() === 'Thumbs.db'
  );
}

/**
 * The SCO launch href from a SCORM 1.2 `imsmanifest.xml`, or null.
 *
 * Deliberately minimal packaging support, not a conforming CP parser: the
 * first `<item identifierref>` in document order names the resource whose
 * `href` launches, falling back to the first resource marked
 * `adlcp:scormtype="sco"`, falling back to the first resource with an href
 * at all. That resolves every single-SCO package — which is what a manual
 * is — and a multi-SCO course simply launches its first activity.
 */
export function scormLaunchHref(xml: string): string | null {
  const resources = new Map<string, string>();
  let firstHref: string | null = null;
  let firstScoHref: string | null = null;
  for (const tag of xml.match(/<resource\b[^>]*>/g) ?? []) {
    const id = /\bidentifier\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    const href = /\bhref\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    if (!href) continue;
    const decoded = href.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    if (id && !resources.has(id)) resources.set(id, decoded);
    if (firstHref === null) firstHref = decoded;
    if (firstScoHref === null && /scormtype\s*=\s*"sco"/i.test(tag)) firstScoHref = decoded;
  }
  const itemRef = /<item\b[^>]*\bidentifierref\s*=\s*"([^"]*)"/.exec(xml)?.[1];
  if (itemRef && resources.has(itemRef)) return resources.get(itemRef)!;
  return firstScoHref ?? firstHref;
}

/**
 * Slide census of a deck package's launch page: `<section>` elements minus
 * the ones the author marked `data-deck-skip`, which the viewer excludes
 * from navigation. Null when the page is not a deck at all — the completion
 * rule then has no slide stream to watch and falls back to an explicit
 * read-through confirmation.
 */
export function deckSlideCount(html: string): number | null {
  if (!html.includes('deck-stage')) return null;
  const sections = html.match(/<section\b[^>]*>/g) ?? [];
  const skipped = sections.filter((tag) => /\bdata-deck-skip\b/.test(tag)).length;
  const count = sections.length - skipped;
  return count > 0 ? count : null;
}

function courseDto(row: typeof schema.courses.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    launchPath: row.launchPath,
    slideCount: row.slideCount,
    fileCount: row.files.length,
    totalBytes: row.totalBytes,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

// ── POST /courses — import a package ───────────────────────────────────────

const uploadBody = z.object({
  title: z.string().min(1).max(200),
  /** Base64 of the zip bytes (no data: prefix — the client strips it). */
  zipBase64: z.string().min(1),
});

coursesRouter.post(
  '/',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    // Importing a course is authoring work — the same grant that creates tools.
    if (!(await hasPermission(tenant, 'assessments', 'create'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const client = getStorageClient();
    if (!client) {
      res.status(503).json({ error: 'storage_unavailable' });
      return;
    }
    const parsed = uploadBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }

    const zipBytes = Buffer.from(parsed.data.zipBase64, 'base64');
    if (zipBytes.length === 0) {
      res.status(400).json({ error: 'invalid_request', message: 'The file was empty.' });
      return;
    }
    if (zipBytes.length > MAX_COURSE_ZIP_BYTES) {
      res.status(413).json({
        error: 'file_too_large',
        message: 'Course packages must be 30 MB or smaller.',
      });
      return;
    }

    let unzipped: Record<string, Uint8Array>;
    try {
      unzipped = unzipSync(zipBytes);
    } catch {
      res.status(400).json({ error: 'invalid_zip', message: 'That file is not a readable zip.' });
      return;
    }

    const files = new Map<string, Uint8Array>();
    const entries: CourseFileEntry[] = [];
    let totalBytes = 0;
    for (const [rawPath, bytes] of Object.entries(unzipped)) {
      if (rawPath.endsWith('/')) continue; // directory marker
      if (isZipNoise(rawPath)) continue;
      const path = normalizeCourseEntryPath(rawPath);
      if (!path) {
        res.status(400).json({ error: 'invalid_course_path', path: rawPath });
        return;
      }
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
      const contentType = path.includes('.') ? COURSE_CONTENT_TYPES[ext] : undefined;
      if (!contentType) {
        res.status(400).json({
          error: 'unsupported_course_file',
          path,
          message: `"${path}" is not a file type a course package may contain.`,
        });
        return;
      }
      totalBytes += bytes.length;
      if (totalBytes > MAX_COURSE_UNPACKED_BYTES) {
        res.status(413).json({
          error: 'course_too_large',
          message: 'The package unpacks to more than 80 MB.',
        });
        return;
      }
      files.set(path, bytes);
      entries.push({ path, size: bytes.length, contentType });
      if (files.size > MAX_COURSE_FILES) {
        res.status(413).json({
          error: 'too_many_files',
          message: `A course package may contain at most ${MAX_COURSE_FILES} files.`,
        });
        return;
      }
    }
    if (files.size === 0) {
      res.status(400).json({ error: 'invalid_zip', message: 'The zip contains no files.' });
      return;
    }

    // Where the player starts: a SCORM manifest's SCO when the package has
    // one, otherwise the conventional index.html, otherwise the only page.
    let launchPath: string | null = null;
    const scormManifest = files.get('imsmanifest.xml');
    if (scormManifest) {
      const href = scormLaunchHref(Buffer.from(scormManifest).toString('utf-8'));
      if (href && files.has(href)) launchPath = href;
    }
    if (!launchPath && files.has('index.html')) launchPath = 'index.html';
    if (!launchPath) {
      const rootPages = entries
        .map((e) => e.path)
        .filter((p) => !p.includes('/') && /\.html?$/i.test(p));
      if (rootPages.length === 1) launchPath = rootPages[0]!;
    }
    if (!launchPath) {
      res.status(400).json({
        error: 'launch_not_found',
        message:
          'No launch page found — the zip needs an imsmanifest.xml, an index.html, or a single top-level HTML page.',
      });
      return;
    }

    const launchHtml = Buffer.from(files.get(launchPath)!).toString('utf-8');
    const slideCount = deckSlideCount(launchHtml);
    const kind = slideCount !== null ? 'deck' : scormManifest ? 'scorm' : 'html';

    // Bytes first, row second: a course row is the promise that its files are
    // servable, so it must not exist until they are. A failure mid-upload
    // leaves orphaned objects (harmless, unreachable) rather than a course
    // that 404s half its pages.
    const courseId = randomUUID();
    for (const [path, bytes] of files) {
      const entry = entries.find((e) => e.path === path)!;
      await client.uploadCourseFile(tenant.orgId, courseId, path, bytes, entry.contentType);
    }

    const [row] = await db
      .insert(schema.courses)
      .values({
        id: courseId,
        orgId: tenant.orgId,
        title: parsed.data.title,
        kind,
        launchPath,
        slideCount,
        files: entries,
        totalBytes,
        // Explicit rather than left to the column default: every reader of
        // this row gates on status, so the insert should say it in full.
        status: 'active',
        createdByUserId: tenant.userId,
      })
      .returning();
    if (!row) throw new Error('course_create_failed: insert returned no row');

    await recordAudit(db, tenant, {
      action: 'Uploaded course package',
      target: `${row.title} — ${entries.length} files${slideCount ? `, ${slideCount} slides` : ''}`,
      category: 'settings',
      icon: 'book-open',
    });

    res.status(201).json(courseDto(row));
  }),
);

// ── GET /courses — the active packages, for the builder's picker ───────────

coursesRouter.get(
  '/',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await hasPermission(tenant, 'assessments', 'view'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const rows = await db.query.courses.findMany({
      where: and(eq(schema.courses.orgId, tenant.orgId), eq(schema.courses.status, 'active')),
      orderBy: (c, { desc }) => [desc(c.createdAt)],
    });
    res.json({ courses: rows.map(courseDto) });
  }),
);

// ── DELETE /courses/:id — archive a package ────────────────────────────────

coursesRouter.delete(
  '/:id',
  ...GATE,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await hasPermission(tenant, 'assessments', 'create'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const row = await db.query.courses.findFirst({
      where: and(eq(schema.courses.id, req.params.id!), eq(schema.courses.orgId, tenant.orgId)),
    });
    // Another org's course is NOT FOUND, not FORBIDDEN — same cross-tenant
    // reasoning as everywhere else.
    if (!row || row.status !== 'active') {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // A course a live tool still points at must not silently vanish from its
    // assessments — the runtime degrades a dangling link to unenforced, so
    // archiving here would quietly stop gating those tools.
    const tools = await db.query.assessmentTools.findMany({
      where: eq(schema.assessmentTools.orgId, tenant.orgId),
    });
    const using = tools.filter((t) => t.manifest.course?.courseId === row.id);
    if (using.length > 0) {
      res.status(409).json({ error: 'course_in_use', tools: using.map((t) => t.name) });
      return;
    }

    await db
      .update(schema.courses)
      .set({ status: 'archived' })
      .where(eq(schema.courses.id, row.id));

    await recordAudit(db, tenant, {
      action: 'Archived course package',
      target: row.title,
      category: 'settings',
      icon: 'book-open',
    });

    res.json({ ok: true });
  }),
);

// ── GET /courses/content/:token/* — the bytes behind a minted link ─────────

/** What a minted content token authorises: one course's files, read-only. */
export interface CourseContentGrant {
  orgId: string;
  courseId: string;
}

/** Mints the path prefix a player loads a course's files under. */
export function mintCourseContentPath(orgId: string, courseId: string): {
  prefix: string;
  expiresAt: string;
} {
  const token = sealSession({ orgId, courseId } satisfies CourseContentGrant, CONTENT_LINK_TTL_MS);
  return {
    prefix: `/courses/content/${encodeURIComponent(token)}`,
    expiresAt: new Date(Date.now() + CONTENT_LINK_TTL_MS).toISOString(),
  };
}

/**
 * Deliberately unauthenticated: the token IS the credential, which is what
 * lets a sandboxed (opaque-origin, cookie-less) iframe load the package.
 * Every rejection is an identical 404 — an expired token, a forged one, and
 * a path the package does not contain must be indistinguishable, or the
 * route becomes a way to probe what exists.
 */
coursesRouter.get(
  '/content/:token/*',
  withErrorHandling(async (req, res) => {
    const grant = unsealSession<CourseContentGrant>(req.params.token!);
    if (!grant || !grant.orgId || !grant.courseId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const course = await db.query.courses.findFirst({
      where: and(eq(schema.courses.id, grant.courseId), eq(schema.courses.orgId, grant.orgId)),
    });
    if (!course || course.status !== 'active') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const path = req.params[0] as string;
    // The import's file list is the allowlist — nothing else under the org's
    // prefix is reachable through this token, whatever the key shape.
    const entry = course.files.find((f) => f.path === path);
    if (!entry) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const client = getStorageClient();
    if (!client) {
      res.status(503).json({ error: 'storage_unavailable' });
      return;
    }
    const bytes = await client.download(grant.orgId, `${grant.orgId}/course-${course.id}/${path}`);
    if (!bytes) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    res.setHeader('Content-Type', entry.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Pages run their scripts but do so from an opaque origin, with no forms,
    // no popups and no reach into the embedding app; everything else is inert
    // bytes exactly like a served attachment.
    const isPage = entry.contentType.startsWith('text/html');
    res.setHeader(
      'Content-Security-Policy',
      isPage ? 'sandbox allow-scripts' : "default-src 'none'; sandbox",
    );
    // The URL embeds a capability token: cacheable privately for the reading
    // session, never in a shared cache.
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(bytes);
  }),
);
