import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@formai/db';
import { FORM_BRAND_KIT_KEYS, MAX_LOGO_BYTES, type FormBrandKit } from '@formai/shared';
import { db } from '../db.js';
import { requireTenant } from '../middleware/tenant.js';
import { hasPermission } from '../lib/permissions.js';
import { recordAudit } from '../audit/record.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { getStorageClient } from '../storage/index.js';
import { getAnthropic } from '../anthropic.js';
import { env } from '../env.js';
import { proposeBrandEdit } from '../brand-chat/edit.js';
import { readBrandColors } from '../pdf/brand-colors.js';
import { readLogoCandidates } from '../pdf/brand-logo.js';

/**
 * Form brands — the client a form is presented as.
 *
 * A subcontractor fills out their clients' documents, so most of their forms
 * carry somebody else's brand and their own is one among several. Storing each
 * client's colours per form would mean a copy in every form that client owns,
 * and changing that client's brand would mean finding all of them. These are
 * named and shared: a form points at one.
 *
 * ORG-SCOPED IN THE QUERY, never checked after loading. A brand names a client,
 * so the list of brands an org holds is the list of companies it subcontracts
 * for — commercially sensitive in a way a colour is not.
 */
export const formBrandsRouter: Router = Router();

/**
 * The branding patch, key by key.
 *
 * `logoAssetUrl` is a RELATIVE path, not an absolute URL — `/api/assets/logo/…`,
 * exactly what `POST /org/logo` mints (see `logoPublicUrl`). Validating it as a
 * URL would reject every value the product actually produces, and accepting an
 * arbitrary absolute one would let a brand point a client's form at a remote
 * host that then sees every respondent who opens it.
 *
 * Unknown keys are dropped rather than rejected: this value ends up in CSS
 * custom properties, and `strict()` would turn a forward-compatible client into
 * a 400 while `passthrough()` would carry the junk through.
 */
const kitBody = z
  .object({
    logoAssetUrl: z
      .string()
      .refine((v) => v.startsWith('/api/assets/logo/'), 'must be an uploaded logo path')
      .nullable()
      .optional(),
    primaryColor: z.string().max(32).optional(),
    secondaryColor: z.string().max(32).optional(),
    accentColor: z.string().max(32).optional(),
    formFont: z.string().max(80).optional(),
    theme: z.record(z.string(), z.unknown()).optional(),
  })
  .transform((v) => v as FormBrandKit);

const brandBody = z.object({
  name: z.string().min(1).max(120),
  branding: kitBody.optional(),
});

type BrandRow = {
  id: string;
  name: string;
  branding: FormBrandKit;
  createdAt: Date;
};

/** The wire shape. One place, so the four endpoints cannot drift apart. */
function toFormBrand(row: BrandRow) {
  return {
    id: row.id,
    name: row.name,
    branding: row.branding,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Merge a patch into a stored kit, key by key.
 *
 * A PATCH not a replace, so editing the colours does not blank the logo — and
 * `undefined` (not mentioned) has to stay distinct from `null` on
 * `logoAssetUrl`, which means "this brand has no logo, show nothing". Collapsing
 * the two would make "remove the client's logo" unsayable, and the org's would
 * come back on their form.
 */
function mergeKit(stored: FormBrandKit, patch: FormBrandKit): FormBrandKit {
  const next: FormBrandKit = { ...stored };
  for (const key of FORM_BRAND_KIT_KEYS) {
    const value = (patch as Record<string, unknown>)[key];
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

/** Postgres reports the unique index by name; both write doors read it alike. */
function isDuplicateName(err: unknown): boolean {
  return err instanceof Error && /form_brands_org_name_uq/.test(err.message);
}

/**
 * POST /form-brands/scan — read a client's colours and logo off their document.
 *
 * SEEDS A BRAND, DECIDES NOTHING. What comes back is a proposal the author
 * confirms, which is the same posture every other thing this product reads off
 * a page takes: a document's most-used colour may be its table borders rather
 * than its letterhead, and its images are its logo, its hazard pictograms and
 * its site photographs alike. Nothing is stored, and no brand is created or
 * changed — the author picks, then saves through the ordinary edit path.
 *
 * NO MODEL IS INVOLVED. Colours are operators in the content stream and logos
 * are image XObjects, so both are read by exact parsing. A client's document is
 * a file somebody else authored; the less of it that reaches a model, the
 * smaller the surface.
 *
 * Logos come back as BASE64 rather than uploaded URLs. Uploading every
 * candidate would leave an orphaned object for each one the author declined,
 * and the existing upload door already takes exactly this shape — so the one
 * they choose goes through it and the rest are simply dropped.
 */
const scanBody = z
  .object({
    /** An org-scoped storage id — a form's own source PDF. */
    assetId: z.string().min(1).optional(),
    pdfBase64: z.string().min(1).optional(),
  })
  .refine((v) => !!v.assetId !== !!v.pdfBase64, {
    message: 'Provide exactly one of assetId or pdfBase64.',
  });

/** Candidates returned inline. Past this the response is a download. */
const MAX_INLINE_LOGOS = 4;

formBrandsRouter.post(
  '/scan',
  requireTenant,
  withErrorHandling(async (req, res) => {
    const tenant = req.tenant!;
    // Gated as an edit: this is the first step of authoring a brand, and it
    // reads a document out of the org's own storage.
    if (!(await hasPermission(tenant, 'forms', 'edit'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = scanBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }

    let bytes: Buffer;
    if (parsed.data.assetId) {
      /*
        The org id comes from the SESSION, not the body, and the storage client
        scopes the download by it — so an asset id belonging to another org
        resolves to nothing rather than to their document. This is the same
        contract `/pdf/extract` and `/answer-guides/match` already use.
      */
      const client = getStorageClient();
      if (!client) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const downloaded = await client.download(tenant.orgId, parsed.data.assetId);
      if (!downloaded) {
        res.status(404).json({ error: 'asset_not_found' });
        return;
      }
      bytes = downloaded;
    } else {
      bytes = Buffer.from(parsed.data.pdfBase64!, 'base64');
    }

    const { colors, notes } = await readBrandColors(bytes);
    const candidates = await readLogoCandidates(bytes);
    const logos = candidates
      .filter((c) => c.bytes.length <= MAX_LOGO_BYTES)
      .slice(0, MAX_INLINE_LOGOS)
      .map((c) => ({
        imageBase64: c.bytes.toString('base64'),
        mimeType: c.mimeType,
        width: c.width,
        height: c.height,
      }));

    if (candidates.length > 0 && logos.length === 0) {
      // Distinguished from "no images at all" on purpose: "we found one and it
      // was too big" is a different thing for the author to know.
      notes.push('The images in this document are too large to use as a logo.');
    }

    res.json({ colors, logos, notes });
  }),
);

/**
 * POST /form-brands/:id/edit — change a brand by describing the change.
 *
 * PROPOSES, NEVER WRITES. The patch comes back for the author to see in the
 * live preview and then save through the ordinary PATCH, exactly like the PDF
 * scan above. The model is guessing at intent, and a guess that writes itself
 * is a change somebody has to find and undo.
 *
 * The brand is loaded ORG-SCOPED and its current kit is what the model is shown,
 * so "a bit tighter" is relative to a real starting point — and so an id from
 * another org describes nothing, rather than leaking that org's colours back
 * through a summary sentence.
 */
const editBody = z.object({
  instruction: z.string().min(1).max(1000),
});

formBrandsRouter.post(
  '/:id/edit',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await hasPermission(tenant, 'forms', 'edit'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = editBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const brand = await db.query.formBrands.findFirst({
      where: and(eq(schema.formBrands.id, req.params.id!), eq(schema.formBrands.orgId, tenant.orgId)),
    });
    if (!brand) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    try {
      const result = await proposeBrandEdit(brand.branding, parsed.data.instruction, {
        anthropic: getAnthropic() ?? undefined,
        model: env.ANTHROPIC_EXTRACTION_MODEL,
      });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'brand_edit_failed';
      // A missing key is a configuration state, not a fault — same mapping the
      // extraction and answer-guide paths use.
      const status = message.startsWith('brand_edit_unavailable') ? 422 : 500;
      res.status(status).json({ error: message });
    }
  }),
);

formBrandsRouter.get(
  '/',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    // Reading is gated on `forms:view`, not `forms:edit`: the picker sits in
    // the form library beside the form itself, and someone who may look at a
    // form may see which client it is presented as.
    if (!(await hasPermission(tenant, 'forms', 'view'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const rows = await db.query.formBrands.findMany({
      where: eq(schema.formBrands.orgId, tenant.orgId),
    });
    // Sorted by name so the picker's order is stable between loads — a list
    // that reshuffles is a list somebody picks wrongly from.
    res.json(rows.map(toFormBrand).sort((a, b) => a.name.localeCompare(b.name)));
  }),
);

formBrandsRouter.post(
  '/',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await hasPermission(tenant, 'forms', 'edit'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = brandBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    try {
      const [row] = await db
        .insert(schema.formBrands)
        .values({
          orgId: tenant.orgId,
          name: parsed.data.name,
          branding: parsed.data.branding ?? {},
        })
        .returning();
      await recordAudit(db, tenant, {
        action: 'Created form brand',
        target: row!.name,
        category: 'forms',
        icon: 'palette',
      });
      res.status(201).json(toFormBrand(row!));
    } catch (err) {
      /*
        The unique index is what refuses a duplicate name, not a read-then-write
        check: two people adding "BBM" at once would both find nothing and both
        insert. A name collision is reported as one, because "BBM" and "bbm" in
        one picker is a coin flip about which client's colours a form renders in.
      */
      if (isDuplicateName(err)) {
        res.status(409).json({ error: 'duplicate_name' });
        return;
      }
      throw err;
    }
  }),
);

formBrandsRouter.patch(
  '/:id',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    if (!(await hasPermission(tenant, 'forms', 'edit'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const parsed = brandBody.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }

    // Read-then-merge, because the patch is per-key inside the jsonb. Scoped to
    // the org on the way in, so another org's id simply finds nothing.
    const existing = await db.query.formBrands.findFirst({
      where: and(eq(schema.formBrands.id, req.params.id!), eq(schema.formBrands.orgId, tenant.orgId)),
    });
    if (!existing) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    try {
      const [row] = await db
        .update(schema.formBrands)
        .set({
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.branding !== undefined
            ? { branding: mergeKit(existing.branding, parsed.data.branding) }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.formBrands.id, existing.id))
        .returning();
      await recordAudit(db, tenant, {
        action: 'Updated form brand',
        target: row!.name,
        category: 'forms',
        icon: 'palette',
      });
      res.json(toFormBrand(row!));
    } catch (err) {
      // Renaming into an existing name collides on the same index a create
      // does, and reports the same way.
      if (isDuplicateName(err)) {
        res.status(409).json({ error: 'duplicate_name' });
        return;
      }
      throw err;
    }
  }),
);

formBrandsRouter.delete(
  '/:id',
  requireTenant,
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    // Deleting a brand reaches every form that used it, unstyling all of them
    // at once. That is a delete-shaped act even though nothing named a form,
    // so it is gated as one.
    if (!(await hasPermission(tenant, 'forms', 'delete'))) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const [row] = await db
      .delete(schema.formBrands)
      .where(and(eq(schema.formBrands.id, req.params.id!), eq(schema.formBrands.orgId, tenant.orgId)))
      .returning();

    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await recordAudit(db, tenant, {
      action: 'Deleted form brand',
      target: row.name,
      category: 'forms',
      icon: 'palette',
    });
    /*
      Forms that used it are NOT deleted — the column is `on delete set null`,
      so they fall back to the org's own branding. Visible, recoverable, and
      nothing like the alternative, which is deleting a client's forms because
      somebody tidied up a colour scheme.
    */
    res.status(204).end();
  }),
);
