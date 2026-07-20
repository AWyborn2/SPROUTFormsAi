import { Router } from 'express';
import { z } from 'zod';
import { requireTenant } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { recordAudit } from '../audit/record.js';
import { getStorageClient } from '../storage/index.js';
import { db } from '../db.js';

/**
 * Org logo upload and public serving.
 *
 * POST /org/logo          — owner/admin; `{ imageBase64, mimeType }` → `{ url }`.
 * GET  /assets/logo/*     — PUBLIC, unauthenticated: logged-out respondents on
 *                           a fill page must be able to load the org's logo.
 *
 * The public GET is why the storage key namespace matters. PDF asset ids and
 * logo keys live in the same bucket under the same `${orgId}/` prefix, so the
 * GET restricts itself to `${orgId}/logo-${uuid}.{ext}` BEFORE it touches
 * storage — otherwise a leaked or guessed PDF asset id could be replayed
 * through this route with no session at all.
 */
export const orgLogoRouter: Router = Router();
export const publicAssetsRouter: Router = Router();

import { MAX_LOGO_BYTES } from '@formai/shared';

export { MAX_LOGO_BYTES };

/**
 * The only key shape the public route will serve. Single path segment for the
 * org (no nesting — see the adapters' `uploadImage`), a literal `logo-` infix,
 * and a raster extension. SVG is absent by construction: serving user-supplied
 * SVG from the app origin is a stored-XSS vector, so the client rasterises it
 * to PNG before upload.
 */
const LOGO_KEY_RE = /^[^/]+\/logo-[^/]+\.(png|jpe?g|webp)$/;

/** Whitelisted upload types → the extension the key gets. */
const ALLOWED_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Key extension → response `Content-Type`. The adapters store bare bytes. */
const EXT_CONTENT_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * Confirms the decoded bytes really are the declared format. The client's
 * `mimeType` is attacker-controlled, so it only selects which signature to
 * check — it never decides what gets stored on its own.
 */
function magicBytesMatch(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/png') {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === 'image/webp') {
    return (
      bytes.length >= 12 &&
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP'
    );
  }
  return false;
}

/**
 * The browser-usable relative URL for a logo key. `/api` is the same-origin
 * prefix the web app proxies to this API (see `apps/web/src/lib/data/api-client.ts`),
 * so the value stored in `branding.logoAssetUrl` drops straight into an
 * `<img src>` on both authed and public surfaces, with no absolute host to
 * configure and nothing provider-specific baked in.
 */
export function logoPublicUrl(key: string): string {
  return `/api/assets/logo/${key}`;
}

/**
 * Inverse of `logoPublicUrl`, used when reaping a superseded logo. Returns
 * null for anything that isn't a URL we minted — a stored value pointing at
 * some other host or shape is left alone rather than parsed into a delete.
 */
export function logoKeyFromPublicUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const prefix = '/api/assets/logo/';
  if (!url.startsWith(prefix)) return null;
  const key = url.slice(prefix.length);
  return LOGO_KEY_RE.test(key) ? key : null;
}

/**
 * Best-effort removal of a logo object superseded by a branding update.
 * Never throws: a storage hiccup must not fail the settings write that
 * already succeeded — the worst case is one orphaned object, which the
 * org-deletion `deletePrefix` sweep still collects.
 */
export async function deleteSupersededLogo(
  orgId: string,
  previousUrl: string | null,
): Promise<void> {
  const key = logoKeyFromPublicUrl(previousUrl);
  if (!key || !key.startsWith(`${orgId}/`)) return;
  try {
    const client = getStorageClient();
    if (!client) return;
    await client.deleteObject(orgId, key);
  } catch (err) {
    console.error('[assets] superseded logo cleanup failed', err);
  }
}

// ── POST /org/logo ────────────────────────────────────────────────────────

const uploadLogoBody = z.object({
  imageBase64: z.string().min(1),
  mimeType: z.string().min(1),
});

orgLogoRouter.post(
  '/',
  requireTenant,
  withErrorHandling(async (req, res) => {
    const tenant = req.tenant!;
    if (tenant.role !== 'owner' && tenant.role !== 'admin') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const client = getStorageClient();
    if (!client) {
      res.status(503).json({ error: 'storage_unavailable' });
      return;
    }
    const parsed = uploadLogoBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const { imageBase64, mimeType } = parsed.data;

    const ext = ALLOWED_TYPES[mimeType];
    if (!ext) {
      res.status(400).json({
        error: 'unsupported_image_type',
        message: 'Logos must be PNG, JPEG or WebP.',
      });
      return;
    }

    const bytes = Buffer.from(imageBase64, 'base64');
    if (bytes.length === 0) {
      res.status(400).json({ error: 'invalid_request', message: 'Image data was empty.' });
      return;
    }
    if (bytes.length > MAX_LOGO_BYTES) {
      res.status(413).json({ error: 'file_too_large', message: 'Logos must be 2 MB or smaller.' });
      return;
    }
    // Declared type vs. actual content — the client's MIME is a hint, not proof.
    if (!magicBytesMatch(bytes, mimeType)) {
      res.status(400).json({
        error: 'unsupported_image_type',
        message: "That file's contents don't match a PNG, JPEG or WebP image.",
      });
      return;
    }

    const key = await client.uploadImage(tenant.orgId, bytes, mimeType, ext);

    if (db) {
      await recordAudit(db, tenant, {
        action: 'Uploaded organisation logo',
        target: 'Branding kit',
        category: 'settings',
        icon: 'settings',
      });
    }

    res.status(201).json({ url: logoPublicUrl(key) });
  }),
);

// ── GET /assets/logo/* (PUBLIC) ───────────────────────────────────────────
// Deliberately outside `requireTenant`: public fill pages are viewed by
// logged-out respondents, and the org's logo has to render for them.

publicAssetsRouter.get(
  '/logo/*',
  withErrorHandling(async (req, res) => {
    const key = req.params[0] as string;
    // Namespace check FIRST — before any storage call — so keys outside the
    // logo namespace (a PDF asset id, a nested path) are indistinguishable
    // from a nonexistent object and never reach the bucket.
    if (!LOGO_KEY_RE.test(key)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const client = getStorageClient();
    if (!client) {
      res.status(503).json({ error: 'storage_unavailable' });
      return;
    }
    const orgId = key.slice(0, key.indexOf('/'));
    const bytes = await client.download(orgId, key);
    if (!bytes) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
    res.setHeader('Content-Type', EXT_CONTENT_TYPE[ext] ?? 'application/octet-stream');
    // The stored bytes are user-supplied: never let a browser sniff its way
    // to a different, scriptable type than the extension promises.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(bytes);
  }),
);
