import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@formai/db';
import { FORM_BRAND_KIT_KEYS, type FormBrandKit } from '@formai/shared';
import { db } from '../db.js';
import { requireTenant } from '../middleware/tenant.js';
import { hasPermission } from '../lib/permissions.js';
import { recordAudit } from '../audit/record.js';
import { withErrorHandling } from '../lib/with-error-handling.js';

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
