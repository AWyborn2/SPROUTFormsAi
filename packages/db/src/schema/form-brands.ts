import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { FormBrandKit } from '@formai/shared';
import { organizations } from './organizations.ts';

/**
 * A brand a form is presented in — usually a CLIENT's, not the org's own.
 *
 * WHY THIS IS A TABLE AND NOT A PER-FORM SETTING. `form_templates.themeOverride`
 * already lets one form deviate from the org's theme, on the assumption that the
 * org's brand is the baseline and a deviation is exceptional. That is wrong for
 * a SUBCONTRACTOR: they fill out their clients' documents, so most of their
 * forms carry somebody else's brand and their own is one among several. Storing
 * each client's colours per form means a copy in every form that client owns,
 * and changing that client's brand means finding all of them.
 *
 * Named and shared instead: six brands, dozens of forms, one place to edit each.
 */
export const formBrands = pgTable(
  'form_brands',
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /**
     * A SPARSE PATCH over the org's own branding kit — logo, colours, font and
     * theme tokens — where an absent key inherits. One jsonb rather than
     * columns for each because that is exactly what the org's own kit already
     * is, and `resolveBrandKit` is the single place that layers the two.
     *
     * Sparse matters: a brand that only sets a primary colour says only a
     * primary colour, and still picks up the org's font. Splitting it into
     * NULLable columns would make "unset" and "set to empty" the same value.
     */
    branding: jsonb().$type<FormBrandKit>().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('form_brands_org_idx').on(t.orgId),
    /*
      Two brands in one org cannot share a name, case-insensitively.

      A brand is chosen from a list by a person reading it, and two entries
      reading "BBM" and "bbm" is a coin flip about which client's colours a form
      renders in — the same reasoning the taxonomy's own name uniqueness carries.
    */
    uniqueIndex('form_brands_org_name_uq').on(t.orgId, sql`lower(${t.name})`),
  ],
);
