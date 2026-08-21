import { relations, sql } from 'drizzle-orm';
import { date, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations.ts';

/**
 * Daily compliance snapshots (Training summary trend, U1/KTD5).
 *
 * Compliance state is DERIVED everywhere else in the product — grants plus
 * validity produce currency on demand — which means history is not derivable
 * at all: once a grant is renewed or a requirement changes, yesterday's
 * compliance number is gone. The trend chart on the Training summary needs
 * that history, so the expiry sweep captures one row per org per UTC day
 * after its existing pass. Rows are captured at every grain from day one
 * (org, per-location, per-department) even though v1 UI reads only the org
 * rows — a scoped trend asked for later cannot be backfilled, so the cheap
 * rows are written now.
 *
 * `capturedOn` is the UTC date of the sweep run: the sweep is externally
 * triggered (POST /internal/sweep), so pinning the date to UTC keeps an
 * irregular invocation time from double-filling or skipping a day. Missed
 * days simply have no row; the trend renders them as gaps, never fabricated
 * points.
 */
export const complianceSnapshots = pgTable(
  'compliance_snapshots',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** UTC date of the sweep run that captured this row. */
    capturedOn: date().notNull(),
    /**
     * Snapshot grain. Both null = the org row. A scoped row names the axis
     * ('location' | 'department') and the taxonomy id; retired scopes stop
     * getting new rows but keep their history.
     */
    scopeType: text().$type<'location' | 'department'>(),
    scopeId: uuid(),
    /** Members whose every required competency counted as held at capture. */
    compliantCount: integer().notNull(),
    /** Active members in the snapshot's scope at capture. */
    memberCount: integer().notNull(),
    /** Open required gaps (required, not counting as held) at capture. */
    requiredGapCount: integer().notNull(),
  },
  (t) => [
    // Idempotence per day and grain. Postgres treats NULLs as distinct, so a
    // plain unique over (org, scopeType, scopeId, capturedOn) would never
    // dedupe the org row — partial indexes per the 0060 precedent instead.
    uniqueIndex('compliance_snapshots_org_day_uq')
      .on(t.orgId, t.capturedOn)
      .where(sql`${t.scopeType} IS NULL`),
    uniqueIndex('compliance_snapshots_scope_day_uq')
      .on(t.orgId, t.scopeType, t.scopeId, t.capturedOn)
      .where(sql`${t.scopeType} IS NOT NULL`),
  ],
);

export const complianceSnapshotsRelations = relations(complianceSnapshots, ({ one }) => ({
  org: one(organizations, {
    fields: [complianceSnapshots.orgId],
    references: [organizations.id],
  }),
}));
