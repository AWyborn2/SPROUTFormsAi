import { relations } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations.ts';
import { formTemplates } from './forms.ts';

/**
 * A public fill link for a form template. The token is the only credential:
 * anyone holding the URL can GET the form and POST a submission — no session.
 *
 * A link points at the *template*, not a version: the public fill route
 * resolves the template's current published version at request time, so
 * publishing a fix propagates to every distributed link. Auditability is
 * preserved because each submission pins the exact version the visitor was
 * served (echoed back by the client on submit).
 */
export const fillLinks = pgTable(
  'fill_links',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Crypto-random URL-safe token (base64url, 32 chars). Never guessable. */
    token: text().notNull(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    templateId: uuid()
      .notNull()
      .references(() => formTemplates.id, { onDelete: 'cascade' }),
    /** Optional hard expiry; null = never expires. */
    expiresAt: timestamp({ withTimezone: true }),
    /** Revoked links flip to false (row kept for audit), and 404 publicly. */
    active: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('fill_links_token_uq').on(t.token),
    index('fill_links_template_idx').on(t.templateId),
    index('fill_links_org_idx').on(t.orgId),
  ],
);

export const fillLinksRelations = relations(fillLinks, ({ one }) => ({
  org: one(organizations, {
    fields: [fillLinks.orgId],
    references: [organizations.id],
  }),
  template: one(formTemplates, {
    fields: [fillLinks.templateId],
    references: [formTemplates.id],
  }),
}));
