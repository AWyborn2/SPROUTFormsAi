import { Router } from 'express';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@formai/db';
import { ROLES, type Role } from '@formai/shared';
import { requireTenant } from '../middleware/tenant.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { hasPermission } from '../lib/permissions.js';
import { recordAudit } from '../audit/record.js';
import { mintApiKey } from '../auth/api-key.js';
import { db } from '../db.js';

/**
 * API keys — the org's machine credentials.
 *
 * Managed from a session only. A key cannot mint or revoke keys, because the
 * router is mounted with `requireTenant` rather than the machine middleware:
 * a leaked credential must not be able to issue itself a stronger one.
 */
export const apiKeysRouter: Router = Router();

/**
 * How much authority a role carries, for the ceiling check below. Ordering is
 * the default matrix's own reading: owner and admin administer, builder and
 * assessor write, reviewer reads and exports, viewer only reads.
 */
const ROLE_RANK: Record<Role, number> = {
  owner: 5,
  admin: 4,
  builder: 3,
  assessor: 3,
  reviewer: 2,
  viewer: 1,
  candidate: 0,
};

/**
 * A candidate's grants are record-scoped (`'own'`), and a key has no records of
 * its own — a candidate key would resolve to "sees nothing" at best and to a
 * confusing partial grant at worst. Excluded outright rather than left to
 * behave oddly.
 */
const ISSUABLE_ROLES = ROLES.filter((r) => r !== 'candidate');

function keyDto(row: typeof schema.apiKeys.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

apiKeysRouter.get('/', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await hasPermission(tenant, 'team', 'view'))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const rows = await db.query.apiKeys.findMany({
    where: eq(schema.apiKeys.orgId, tenant.orgId),
    orderBy: (k, { desc }) => [desc(k.createdAt)],
  });
  // Neither the plaintext nor the hash appears in this list — the hash is a
  // verifier, and handing it out would let anyone who reads the response
  // confirm guesses offline.
  res.json(rows.map(keyDto));
}));

const createKeyBody = z.object({
  name: z.string().min(1).max(80),
  role: z.enum(ISSUABLE_ROLES as [Role, ...Role[]]).optional(),
});

apiKeysRouter.post('/', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await hasPermission(tenant, 'team', 'manage'))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const parsed = createKeyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
    return;
  }
  // Reviewer is the useful default for an agent: it can read submissions and
  // export them, which is what recording an induction booking is gated on,
  // without carrying any administrative grant.
  const role = parsed.data.role ?? 'reviewer';
  if (ROLE_RANK[role] > ROLE_RANK[tenant.role as Role]) {
    // An admin cannot mint an owner key. Issuing a credential stronger than
    // yourself is privilege escalation with an extra step.
    res.status(403).json({ error: 'role_exceeds_issuer' });
    return;
  }

  const minted = mintApiKey();
  const [row] = await db
    .insert(schema.apiKeys)
    .values({
      orgId: tenant.orgId,
      name: parsed.data.name,
      role,
      prefix: minted.prefix,
      hash: minted.hash,
      createdByUserId: tenant.userId,
    })
    .returning();
  if (!row) throw new Error('api_key_create_failed: insert returned no row');

  await recordAudit(db, tenant, {
    action: 'Created API key',
    target: `${parsed.data.name} (${minted.prefix})`,
    category: 'security',
    icon: 'key',
  });

  // The only time the plaintext exists outside the caller's request.
  res.status(201).json({ ...keyDto(row), key: minted.plaintext });
}));

apiKeysRouter.delete('/:id', requireTenant, withErrorHandling(async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'db_unavailable' });
    return;
  }
  const tenant = req.tenant!;
  if (!(await hasPermission(tenant, 'team', 'manage'))) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  const row = await db.query.apiKeys.findFirst({
    where: and(eq(schema.apiKeys.id, req.params.id!), eq(schema.apiKeys.orgId, tenant.orgId)),
  });
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (!row.revokedAt) {
    await db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.apiKeys.id, row.id), isNull(schema.apiKeys.revokedAt)));
    await recordAudit(db, tenant, {
      action: 'Revoked API key',
      target: `${row.name} (${row.prefix})`,
      category: 'security',
      icon: 'key',
    });
  }
  res.json({ ...keyDto(row), revokedAt: (row.revokedAt ?? new Date()).toISOString() });
}));
