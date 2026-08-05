/**
 * The organisation's taxonomy — Locations, Departments, and the Roles each
 * Department offers — as app-side projections plus the tier gate that decides
 * whether an organisation carries a taxonomy at all.
 *
 * NAMING: the job a person does is a `JobRole` here. The ACCESS-LEVEL concept
 * keeps the name `Role` (see `roles.ts`), because the product renames the
 * vocabulary on screen (R19) without renaming the `role` column or enum. Two
 * names in code keep the two concepts apart where they would otherwise collide.
 */

/** Whether a taxonomy value may still be chosen for new records (R15, R16). */
export type TaxonomyStatus = 'active' | 'retired';

/** Which workforce number identifies a person on screen (R40). */
export type DisplayIdentifier = 'employee_number' | 'swipe_card_number';

export interface Location {
  id: string;
  orgId: string;
  name: string;
  status: TaxonomyStatus;
  createdAt: string;
}

export interface Department {
  id: string;
  orgId: string;
  name: string;
  /** R5: may a person placed here hold several of this Department's Roles? */
  allowsMultipleRoles: boolean;
  status: TaxonomyStatus;
  createdAt: string;
}

export interface JobRole {
  id: string;
  orgId: string;
  /** The Department that offers this Role (R5). */
  departmentId: string;
  name: string;
  status: TaxonomyStatus;
  createdAt: string;
}

/**
 * Plan tiers that carry a taxonomy (R13, R14). An organisation below Business
 * holds no candidate seats and no assessments feature, so Locations,
 * Departments and Roles would have nothing to drive. This mirrors the gate the
 * `assessments` / `competencyGating` features already sit behind, and is a
 * self-contained predicate so the web app can show or hide the settings area
 * without a round-trip. Kept here rather than deriving from `PLAN_CONFIG`
 * because `@formai/shared` cannot import from `@formai/db` (db depends on
 * shared, not the reverse).
 */
export const TAXONOMY_TIERS = ['business', 'enterprise'] as const;

/** Whether the given plan tier carries a taxonomy at all (R13, R14). */
export function taxonomyAvailableForTier(tier: string): boolean {
  return (TAXONOMY_TIERS as readonly string[]).includes(tier);
}

export const DISPLAY_IDENTIFIERS: readonly DisplayIdentifier[] = [
  'employee_number',
  'swipe_card_number',
];

/** Human-facing labels for the display-identifier choice. */
export const DISPLAY_IDENTIFIER_LABELS: Record<DisplayIdentifier, string> = {
  employee_number: 'Employee number',
  swipe_card_number: 'Swipe card number',
};
