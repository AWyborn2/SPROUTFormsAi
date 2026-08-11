import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@formai/db';
import type { db as dbType } from '../db.js';

type Database = NonNullable<typeof dbType>;

/*
  `validForMonths` and `gracePeriodDays` are both optional and both default to
  NULL — never expires. That is deliberate: a qualification does not start
  lapsing because someone created it, only because someone stated how long it
  lasts. 600 months is a sanity ceiling, not a policy.
*/
export const competencyValidityFields = {
  validForMonths: z.number().int().positive().max(600).nullable().optional(),
  gracePeriodDays: z.number().int().nonnegative().max(365).nullable().optional(),
};

/*
  A CODE IS OPTIONAL, AND STRONGLY PREFERRED. It is the identifier an operator
  cross-references against their external LMS, so where one exists it is stored
  and shown exactly as before. But an internal competency — a contractor
  endorsement form, an in-house equipment induction — has none, and the only way
  past a required field was to invent one. A fabricated code is wrong quietly
  and permanently, so the rule changed rather than the data.

  Absent, blank and whitespace all mean the same thing and all become NULL. The
  register holds ONE spelling of "no code": an empty string in one row and a
  null in the next is two ways to say it, and every reader would then have to
  know both.
*/
export const optionalCompetencyCode = z
  .string()
  .nullish()
  .transform((value) => value?.trim() || null);

export const createCompetencyBody = z.object({
  name: z.string().min(1),
  code: optionalCompetencyCode,
  holders: z.number().int().nonnegative().optional(),
  ...competencyValidityFields,
});

export type CreateCompetencyInput = z.infer<typeof createCompetencyBody>;

export type CompetencyRow = typeof schema.competencies.$inferSelect;

/**
 * Create one competency in an org — the single writer.
 *
 * Extracted from `POST /competencies` when the bulk seeder arrived. A second
 * copy of the insert is how the two paths drift: the route enforces the name,
 * code and validity bounds above, and a hand-rolled bulk insert bypassing them
 * would write rows the API itself would have refused. Both callers now go
 * through the same schema and the same defaults.
 *
 * NOTE THE NULL COALESCING ON VALIDITY. `?? null` and not `?? 0`: zero months
 * would mean "expires the instant it is granted", which is the opposite of what
 * a blank validity means. Blank means the qualification never expires, and NULL
 * is how the schema says so.
 */
export async function createCompetency(
  database: Database,
  orgId: string,
  input: CreateCompetencyInput,
): Promise<CompetencyRow> {
  const [row] = await database
    .insert(schema.competencies)
    .values({
      orgId,
      name: input.name,
      // Already normalised by the schema above — blank is NULL, never ''.
      code: input.code ?? null,
      holders: input.holders ?? 0,
      validForMonths: input.validForMonths ?? null,
      gracePeriodDays: input.gracePeriodDays ?? null,
    })
    .returning();
  if (!row) throw new Error('competency_create_failed: insert returned no row');
  return row;
}

/** The shape every competency route and the seeder report back. */
export function competencyDto(row: CompetencyRow) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    holders: row.holders,
    validForMonths: row.validForMonths,
    gracePeriodDays: row.gracePeriodDays,
  };
}

/**
 * Every competency in one org, keyed by lowercased name.
 *
 * The key is `name.toLowerCase()` because that is exactly how the workforce
 * import resolves a competency line against the register
 * (`awardedCompetenciesByName`). Seeding under any other fold would create rows
 * the import then fails to find, which is the whole reason the register is being
 * seeded at all.
 */
export async function competencyIdsByLowercaseName(
  database: Database,
  orgId: string,
): Promise<Map<string, CompetencyRow>> {
  const rows = await database.query.competencies.findMany({
    where: eq(schema.competencies.orgId, orgId),
  });
  return new Map(rows.map((r) => [r.name.trim().toLowerCase(), r]));
}
