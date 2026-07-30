import { Router } from 'express';
import { z } from 'zod';
import {
  ALLOWED_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  type SubmissionFileRef,
} from '@formai/shared';
import { requireTenant } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { getStorageClient } from '../storage/index.js';

/**
 * Submission attachments — the bytes behind a `file_upload` answer.
 *
 * POST /uploads            — authed; `{ imageBase64, mimeType, fileName }` → a
 *                            `SubmissionFileRef` the fill surface stores as the
 *                            field's value.
 * GET  /uploads/file/*     — authed, org-scoped; streams one attachment back.
 *
 * The public door lives in `fill-links.ts` (`POST /fill/:token/uploads`), where
 * the link token is the credential and `resolveLiveLink` already exists — it
 * calls `storeAttachment` below, so both doors share one validator and one
 * storage namespace.
 *
 * THE SERVING ROUTE IS AUTHENTICATED, and that is the deliberate difference
 * from `assets.ts`. An org logo is public because logged-out respondents must
 * render it. An attachment is a driver's licence, a passport page, a photo of a
 * person — serving those from an unauthenticated route would make a UUID the
 * only thing between a scraper and a pile of identity documents. Anonymous
 * fillers never need to read one back: the fill screen previews the file from
 * the local `File` object it already holds.
 */
export const uploadsRouter: Router = Router();

/**
 * The only key shape this module will read or write. Mirrors `LOGO_KEY_RE` in
 * assets.ts but on the `upload-` infix, which is what keeps the two namespaces
 * from being interchangeable: a logo key fails this test, and an attachment key
 * fails the public logo route's test.
 */
/**
 * The attachment key namespace. Exported so the induction document-link route
 * checks the same shape rather than writing a second regex that could drift
 * into accepting a PDF asset id or a logo key.
 */
export const ATTACHMENT_KEY_RE = /^[^/]+\/upload-[^/]+\.(png|jpe?g|webp|pdf)$/;

/** Key extension → response `Content-Type`. The adapters store bare bytes. */
export const EXT_CONTENT_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

/**
 * Confirms the decoded bytes really are the declared format. Same reasoning as
 * `magicBytesMatch` in assets.ts: `mimeType` arrives from the client, so it only
 * chooses which signature to check — it never decides what gets stored on its
 * own. Without this, `image/png` is just a claim, and the stored object could be
 * anything at all.
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
  if (mimeType === 'application/pdf') {
    return bytes.length >= 5 && bytes.toString('ascii', 0, 5) === '%PDF-';
  }
  return false;
}

/**
 * Strips everything that could make a client-supplied name behave like a path
 * or like markup. The name is display-only — it is never a path component, since
 * the storage key is minted server-side from a UUID — but it is echoed into the
 * submission record, the submission detail table and the export, so it must not
 * carry separators, control characters or angle brackets.
 */
export function sanitizeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // Control characters (incl. NUL and DEL) — never legitimate in a name.
    .replace(/[\u0000-\u001F\u007F]/g, '')
    // Reserved path / quoting characters, plus angle brackets, so the name can
    // never open a tag or a quote wherever it ends up rendered.
    .replace(/[<>:"|?*`']/g, '')
    .trim();
  // Length-capped so one absurd name can't dominate a stored record.
  return cleaned.slice(0, 120) || 'attachment';
}

export const attachmentUploadBody = z.object({
  /** Base64 of the raw file bytes (no data: prefix — the client strips it). */
  fileBase64: z.string().min(1),
  mimeType: z.string().min(1),
  fileName: z.string().min(1).max(400),
});

/** A refusal to store: the HTTP status plus the JSON body to send verbatim. */
interface StoreFailure {
  status: number;
  body: { error: string; message?: string };
}

/**
 * Validates and stores one attachment for `orgId`, returning the ref to record
 * or the refusal to send. Shared verbatim by the authed and token-credentialed
 * doors so the two can never drift on size, type, or magic-number checks —
 * a public route that validated more loosely than the authed one would be the
 * only one that mattered, since it is the one anyone can reach.
 */
export async function storeAttachment(
  orgId: string,
  body: unknown,
): Promise<{ ok: true; ref: SubmissionFileRef } | { ok: false; failure: StoreFailure }> {
  const client = getStorageClient();
  if (!client) {
    return { ok: false, failure: { status: 503, body: { error: 'storage_unavailable' } } };
  }

  const parsed = attachmentUploadBody.safeParse(body);
  if (!parsed.success) {
    return { ok: false, failure: { status: 400, body: { error: 'invalid_request' } } };
  }
  const { fileBase64, mimeType, fileName } = parsed.data;

  const ext = ALLOWED_ATTACHMENT_TYPES[mimeType];
  if (!ext) {
    return {
      ok: false,
      failure: {
        status: 400,
        body: {
          error: 'unsupported_file_type',
          message: 'Attachments must be a PNG, JPEG, WebP or PDF.',
        },
      },
    };
  }

  const bytes = Buffer.from(fileBase64, 'base64');
  if (bytes.length === 0) {
    return {
      ok: false,
      failure: { status: 400, body: { error: 'invalid_request', message: 'File data was empty.' } },
    };
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      failure: {
        status: 413,
        body: { error: 'file_too_large', message: 'Attachments must be 10 MB or smaller.' },
      },
    };
  }
  if (!magicBytesMatch(bytes, mimeType)) {
    return {
      ok: false,
      failure: {
        status: 400,
        body: {
          error: 'unsupported_file_type',
          message: "That file's contents don't match the type it claims to be.",
        },
      },
    };
  }

  const key = await client.uploadAttachment(orgId, bytes, mimeType, ext);

  return {
    ok: true,
    ref: {
      kind: 'file',
      key,
      fileName: sanitizeFileName(fileName),
      // The SERVER's verified type, not the client's claim — the two agree only
      // because the magic-number check above already passed.
      contentType: mimeType,
      size: bytes.length,
    },
  };
}

// ── POST /uploads ─────────────────────────────────────────────────────────

uploadsRouter.post(
  '/',
  requireTenant,
  withErrorHandling(async (req, res) => {
    const result = await storeAttachment(req.tenant!.orgId, req.body);
    if (!result.ok) {
      res.status(result.failure.status).json(result.failure.body);
      return;
    }
    res.status(201).json(result.ref);
  }),
);

// ── GET /uploads/file/* ───────────────────────────────────────────────────

uploadsRouter.get(
  '/file/*',
  requireTenant,
  withErrorHandling(async (req, res) => {
    const key = req.params[0] as string;
    // Namespace check FIRST, before any storage call — so a PDF asset id or a
    // logo key replayed through this route is indistinguishable from a
    // nonexistent object, exactly as in assets.ts.
    if (!ATTACHMENT_KEY_RE.test(key)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Then the tenant check. `download` re-checks the prefix itself, but doing
    // it here too means a cross-org key never reaches storage at all.
    const { orgId } = req.tenant!;
    if (!key.startsWith(`${orgId}/`)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const client = getStorageClient();
    if (!client) {
      res.status(503).json({ error: 'storage_unavailable' });
      return;
    }
    const bytes = await client.download(orgId, key);
    if (!bytes) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
    res.setHeader('Content-Type', EXT_CONTENT_TYPE[ext] ?? 'application/octet-stream');
    // The stored bytes are respondent-supplied: never let a browser sniff its
    // way to a scriptable type, and never let a PDF open as an active document
    // in the app's own origin.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    // Attachments are private: no shared-cache copies, unlike the immutable
    // public logo objects.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(bytes);
  }),
);
