import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { schema } from '@formai/db';
import { requireTenant } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { getStorageClient } from '../storage/index.js';
import { db } from '../db.js';


export const badgeIconsRouter: Router = Router();

const MAX_BADGE_ICON_BYTES = 512 * 1024; // 512 KB — SVGs are small

const slugRe = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const createBody = z.object({
  fileBase64: z.string().min(1),
  slug: z.string().min(1).max(60).regex(slugRe, 'slug must be lowercase kebab-case'),
  displayName: z.string().min(1).max(120),
  keywords: z.array(z.string().min(1).max(120)).max(20).default([]),
});

const updateBody = z.object({
  displayName: z.string().min(1).max(120).optional(),
  keywords: z.array(z.string().min(1).max(120)).max(20).optional(),
  sortOrder: z.number().int().min(0).optional(),
});

function looksLikeSvg(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 512).toString('utf8').trim();
  return head.startsWith('<svg') || head.startsWith('<?xml') || head.includes('<svg');
}

// GET /badge-icons — list all icons for the org
badgeIconsRouter.get(
  '/',
  requireTenant,
  withErrorHandling(async (req, res) => {
    const { orgId } = req.tenant!;
    const rows = await db!
      .select()
      .from(schema.badgeIcons)
      .where(eq(schema.badgeIcons.orgId, orgId))
      .orderBy(asc(schema.badgeIcons.sortOrder), asc(schema.badgeIcons.displayName));

    const icons = rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      displayName: r.displayName,
      iconUrl: `/uploads/file/${r.storageKey}`,
      keywords: r.keywords,
      sortOrder: r.sortOrder,
    }));
    res.json(icons);
  }),
);

// POST /badge-icons — upload a new SVG icon
badgeIconsRouter.post(
  '/',
  requireTenant,
  withErrorHandling(async (req, res) => {
    const tenant = req.tenant!;
    if (tenant.role !== 'owner' && tenant.role !== 'admin') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }

    const { fileBase64, slug, displayName, keywords } = parsed.data;

    const bytes = Buffer.from(fileBase64, 'base64');
    if (bytes.length === 0) {
      res.status(400).json({ error: 'invalid_request', message: 'File data was empty.' });
      return;
    }
    if (bytes.length > MAX_BADGE_ICON_BYTES) {
      res.status(413).json({ error: 'file_too_large', message: 'Badge icons must be 512 KB or smaller.' });
      return;
    }
    if (!looksLikeSvg(bytes)) {
      res.status(400).json({ error: 'unsupported_file_type', message: 'Badge icons must be SVG files.' });
      return;
    }

    const client = getStorageClient();
    if (!client) {
      res.status(503).json({ error: 'storage_unavailable' });
      return;
    }

    const key = await client.uploadAttachment(tenant.orgId, bytes, 'image/svg+xml', 'svg');

    const [row] = await db!
      .insert(schema.badgeIcons)
      .values({
        orgId: tenant.orgId,
        slug,
        displayName,
        storageKey: key,
        keywords,
      })
      .returning();

    res.status(201).json({
      id: row!.id,
      slug: row!.slug,
      displayName: row!.displayName,
      iconUrl: `/uploads/file/${row!.storageKey}`,
      keywords: row!.keywords,
      sortOrder: row!.sortOrder,
    });
  }),
);

// PATCH /badge-icons/:id — update display name, keywords, or sort order
badgeIconsRouter.patch(
  '/:id',
  requireTenant,
  withErrorHandling(async (req, res) => {
    const tenant = req.tenant!;
    if (tenant.role !== 'owner' && tenant.role !== 'admin') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const parsed = updateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (parsed.data.displayName !== undefined) updates.displayName = parsed.data.displayName;
    if (parsed.data.keywords !== undefined) updates.keywords = parsed.data.keywords;
    if (parsed.data.sortOrder !== undefined) updates.sortOrder = parsed.data.sortOrder;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'invalid_request', message: 'Nothing to update.' });
      return;
    }

    const [row] = await db!
      .update(schema.badgeIcons)
      .set(updates)
      .where(
        and(eq(schema.badgeIcons.id, req.params.id!), eq(schema.badgeIcons.orgId, tenant.orgId)),
      )
      .returning();

    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    res.json({
      id: row.id,
      slug: row.slug,
      displayName: row.displayName,
      iconUrl: `/uploads/file/${row.storageKey}`,
      keywords: row.keywords,
      sortOrder: row.sortOrder,
    });
  }),
);

// DELETE /badge-icons/:id — remove an icon
badgeIconsRouter.delete(
  '/:id',
  requireTenant,
  withErrorHandling(async (req, res) => {
    const tenant = req.tenant!;
    if (tenant.role !== 'owner' && tenant.role !== 'admin') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    const existing = await db!.query.badgeIcons.findFirst({
      where: and(eq(schema.badgeIcons.id, req.params.id!), eq(schema.badgeIcons.orgId, tenant.orgId)),
    });
    if (!existing) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const client = getStorageClient();
    if (client) {
      try {
        await client.deleteObject(tenant.orgId, existing.storageKey);
      } catch {
        // Best-effort cleanup — the DB row is the authoritative record.
      }
    }

    await db!
      .delete(schema.badgeIcons)
      .where(
        and(eq(schema.badgeIcons.id, req.params.id!), eq(schema.badgeIcons.orgId, tenant.orgId)),
      );

    res.status(204).end();
  }),
);
