import { Router } from 'express';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '@formai/db';
import { competencyCurrency, countsAsHeld, expiryOf } from '@formai/shared';
import { requireTenant } from '../middleware/tenant.js';
import { requirePlanFeature } from '../middleware/plan.js';
import { withErrorHandling } from '../lib/with-error-handling.js';
import { requiredCompetencyIdsFor } from '../lib/standing.js';
import { db } from '../db.js';

export const gamificationRouter: Router = Router();

const XP_PER_CURRENT = 100;
const XP_PER_EXPIRED = 25;

const LEVELS = [
  { level: 1, min: 0 },
  { level: 2, min: 500 },
  { level: 3, min: 1000 },
  { level: 4, min: 2000 },
  { level: 5, min: 4000 },
] as const;

function levelFor(xp: number): { level: number; min: number; max: number } {
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (xp >= LEVELS[i]!.min) {
      const next = LEVELS[i + 1];
      return { level: LEVELS[i]!.level, min: LEVELS[i]!.min, max: next ? next.min : LEVELS[i]!.min + 2000 };
    }
  }
  return { level: 1, min: 0, max: 500 };
}

gamificationRouter.get(
  '/stats/:userId',
  requireTenant,
  requirePlanFeature('competencyGating'),
  withErrorHandling(async (req, res) => {
    if (!db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const tenant = req.tenant!;
    const targetUserId = req.params.userId!;

    const holders = await db.query.competencyHolders.findMany({
      where: and(
        eq(schema.competencyHolders.userId, targetUserId),
        eq(schema.competencyHolders.orgId, tenant.orgId),
        isNull(schema.competencyHolders.revokedAt),
      ),
    });

    const competencyIds = holders.map((h) => h.competencyId);
    const competencies =
      competencyIds.length > 0
        ? await db.query.competencies.findMany({
            where: eq(schema.competencies.orgId, tenant.orgId),
          })
        : [];
    const byId = new Map(competencies.map((c) => [c.id, c]));

    const now = new Date();
    let currentCount = 0;
    let expiredCount = 0;
    let oldestCurrentGrantDate: Date | null = null;

    for (const h of holders) {
      const competency = byId.get(h.competencyId);
      const validity = competency ?? {};
      const currency = competencyCurrency(h, validity, now, 'candidate');
      if (countsAsHeld(currency)) {
        currentCount++;
        if (h.grantedAt && (!oldestCurrentGrantDate || h.grantedAt < oldestCurrentGrantDate)) {
          oldestCurrentGrantDate = h.grantedAt;
        }
      } else {
        expiredCount++;
      }
    }

    const xp = currentCount * XP_PER_CURRENT + expiredCount * XP_PER_EXPIRED;
    const lvl = levelFor(xp);

    // --- Zero-lapse streak ---
    const required = await requiredCompetencyIdsFor(db, tenant.orgId, targetUserId);
    let streakDays = 0;
    if (required.size > 0) {
      const allRequiredCurrent = [...required].every((compId) => {
        const holder = holders.find((h) => h.competencyId === compId);
        if (!holder) return false;
        const comp = byId.get(compId);
        const currency = competencyCurrency(holder, comp ?? {}, now, 'candidate');
        return countsAsHeld(currency);
      });
      if (allRequiredCurrent && oldestCurrentGrantDate) {
        streakDays = Math.floor((now.getTime() - oldestCurrentGrantDate.getTime()) / (1000 * 60 * 60 * 24));
      }
    } else if (currentCount > 0 && oldestCurrentGrantDate) {
      streakDays = Math.floor((now.getTime() - oldestCurrentGrantDate.getTime()) / (1000 * 60 * 60 * 24));
    }

    // --- Leaderboard rank ---
    const orgHolders = await db
      .select({
        userId: schema.competencyHolders.userId,
        count: sql<number>`count(*)`.as('count'),
      })
      .from(schema.competencyHolders)
      .where(
        and(
          eq(schema.competencyHolders.orgId, tenant.orgId),
          isNull(schema.competencyHolders.revokedAt),
        ),
      )
      .groupBy(schema.competencyHolders.userId);

    const scored = orgHolders
      .map((row) => ({ userId: row.userId, xp: Number(row.count) * XP_PER_CURRENT }))
      .sort((a, b) => b.xp - a.xp);

    const rank = scored.findIndex((s) => s.userId === targetUserId) + 1;

    res.json({
      xp,
      level: lvl.level,
      levelMin: lvl.min,
      levelMax: lvl.max,
      currentCount,
      expiredCount,
      streakDays,
      leaderboardRank: rank || scored.length + 1,
      totalMembers: scored.length,
    });
  }),
);
