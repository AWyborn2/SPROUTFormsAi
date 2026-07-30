import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '@formai/db';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { recordAudit } from '../audit/record.js';
import { BCRYPT_COST } from './auth.js';
import { db } from '../db.js';

/**
 * Redeeming a password reset — the half an administrator never touches.
 *
 * An admin can issue a reset (see `POST /team/members/:id/password-reset`) but
 * cannot complete one: the new password is chosen here, by whoever holds the
 * link. That separation is what stops an assessor from being able to sign in as
 * a candidate whose assessments they also mark.
 *
 * Public by necessity — someone who has lost their password has no session.
 */
export const passwordResetRouter: Router = Router();

/** Unused, unexpired, and matching the token — the only redeemable reset. */
function redeemableWhere(token: string) {
  return and(
    eq(schema.passwordResets.token, token),
    isNull(schema.passwordResets.usedAt),
    sql`${schema.passwordResets.expiresAt} > now()`,
  );
}

/**
 * Confirms a link is live before showing the form.
 *
 * Answers with a NAME and nothing else — no email address, no org. A reset link
 * may be handed over on paper and could be found by anyone, so it must not turn
 * into a lookup tool for who works where.
 */
passwordResetRouter.get(
  '/:token',
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const reset = await db.query.passwordResets.findFirst({
      where: redeemableWhere(req.params.token!),
    });
    if (!reset) {
      res.status(404).json({ error: 'reset_not_found' });
      return;
    }
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, reset.userId) });
    res.json({ name: user?.name ?? '' });
  }),
);

const completeBody = z.object({
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

passwordResetRouter.post(
  '/:token',
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = completeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }

    const reset = await db.query.passwordResets.findFirst({
      where: redeemableWhere(req.params.token!),
    });
    if (!reset) {
      res.status(404).json({ error: 'reset_not_found' });
      return;
    }

    // Burn the token FIRST, with `usedAt IS NULL` in the WHERE. If two requests
    // race, only one proceeds — and a token that fails to burn must never go on
    // to change a password.
    const [burned] = await db
      .update(schema.passwordResets)
      .set({ usedAt: new Date() })
      .where(and(eq(schema.passwordResets.id, reset.id), isNull(schema.passwordResets.usedAt)))
      .returning();
    if (!burned) {
      res.status(404).json({ error: 'reset_not_found' });
      return;
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, BCRYPT_COST);
    await db
      .update(schema.users)
      .set({ passwordHash })
      .where(eq(schema.users.id, reset.userId));

    // Recorded against the ISSUING org so the reset is visible to the admins who
    // raised it, and attributed to the user themselves — they chose it.
    await recordAudit(
      db,
      { userId: reset.userId, orgId: reset.orgId, role: 'viewer' },
      { action: 'Set a new password', target: '', category: 'team', icon: 'key-round' },
    );

    // Deliberately NO session cookie. Setting the password should not sign you
    // in: the link may have been printed and handed over, and possession of a
    // slip of paper shouldn't become a live session on whatever device scans it.
    res.status(200).json({ ok: true });
  }),
);
