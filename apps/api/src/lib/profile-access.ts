import { and, eq } from 'drizzle-orm';
import { PLAN_CONFIG, schema, type Db, type PlanTier } from '@formai/db';
import { PROFILE_FIELDS, candidateEditableFieldKeys, type PermissionAction } from '@formai/shared';
import { permissionScope } from './permissions.js';

/**
 * Who may read and write what on a member's profile (R39, R49, R50, R51, R55).
 *
 * ONE resolution, called by every surface that touches a profile — the routes,
 * the document serving route, the export. Written once because the rule has two
 * branches that must not drift apart, and because a second implementation is a
 * second place for a candidate's protection to be missed.
 *
 * THE TWO BRANCHES:
 *
 *  - The SUBJECT branch, and it is the candidate's alone. A candidate reads
 *    every field on their own record including the sensitive ones (R49), opens
 *    every document held on it (R50) and writes their own mobile, address and
 *    emergency contact (R51). Fixed rather than configured: no setting of the
 *    matrix takes it away, because a candidate reading the record their employer
 *    holds about them is not a permission an organisation grants itself out of.
 *
 *  - The MATRIX branch, for everybody else — INCLUDING a non-candidate reading
 *    their OWN record. Scoping the fixed rule to the Candidate access level is
 *    what keeps it a protection rather than a hole in the configuration: an
 *    assessor reading their own profile goes through the matrix like any other
 *    caller, because whatever an organisation admits an access level to includes
 *    that access level's own record.
 *
 * THE CATEGORY DIVIDES BY OBJECT (KTD26): `view` covers the profile's fields,
 * `view_competencies` the competencies and assessment history, `view_documents`
 * the documents, `edit` the writable fields and `approve` the approval verb.
 * R44 and R41 both require the split — one `view` cannot say that restricting
 * fields leaves documents alone.
 *
 * SENSITIVITY IS NOT AN AXIS HERE. R8's mark drives redaction in exports and
 * agent-facing reads, not who sees a field on the profile itself.
 */

/** What a caller wants to do. */
export type ProfileCapability =
  | 'view'
  | 'edit'
  | 'approve'
  | 'view_documents'
  | 'view_competencies';

export interface ProfileAccess {
  /** Whether the caller reaches this profile at all. */
  canView: boolean;
  canViewDocuments: boolean;
  canViewCompetencies: boolean;
  canApprove: boolean;
  /** Field keys the caller may write. Empty when they may write none. */
  editableFields: string[];
  /** True on the fixed candidate-own-record branch, which the matrix cannot narrow. */
  isSubject: boolean;
}

/**
 * Every field an Admin may enter, from the inventory (R2).
 *
 * Derived here rather than listed, so the route, the screen and this resolution
 * read ONE description of the record. Derived and generated fields are nobody's
 * to write and are excluded by the inventory itself.
 */
const ADMIN_EDITABLE_FIELDS: string[] = PROFILE_FIELDS.filter(
  (f) => f.storedOn === 'profile' && f.editableBy.includes('admin'),
).map((f) => f.key);

const DENIED: ProfileAccess = {
  canView: false,
  canViewDocuments: false,
  canViewCompetencies: false,
  canApprove: false,
  editableFields: [],
  isSubject: false,
};

/**
 * Whether this organisation's tier carries profiles at all.
 *
 * Gated to the tier that carries assessments, matching the taxonomy a profile's
 * placement depends on — a profile points at Locations, Departments and Roles
 * that a tier below cannot create. Placed HERE rather than on each route so
 * every surface inherits it from one place; six units each remembering their own
 * gate is six chances to forget.
 */
export function tierCarriesProfiles(planTier: string): boolean {
  return PLAN_CONFIG[planTier as PlanTier]?.features.assessments ?? false;
}

/**
 * The organisation row when `orgId` is on a tier that carries profiles, else
 * null — the tier gate as a value, so a caller can both gate on it and read the
 * columns it returns (the display identifier the export needs).
 *
 * The tier gate `resolveProfileAccess` applies to every matrix-gated read and
 * write, extracted so the two Admin-only routes that resolve no matrix (the
 * unreachable mark and the export) apply the SAME rule directly rather than each
 * repeating the org lookup. An organisation below the assessments tier holds no
 * profiles at all, and neither route may be its way in.
 */
export async function profileTierOrg(db: Db, orgId: string) {
  const org = await db.query.organizations.findFirst({
    where: eq(schema.organizations.id, orgId),
  });
  return org && tierCarriesProfiles(org.planTier) ? org : null;
}

/**
 * Resolve what `tenant` may do on the profile belonging to `subjectMembership`.
 *
 * `subjectMembership` is the membership the profile hangs off, so the subject
 * test is a membership comparison rather than a user comparison — the same
 * person in two organisations is two memberships and two profiles, and only the
 * one they are looking at is theirs.
 */
export async function resolveProfileAccess(
  db: Db,
  tenant: { orgId: string; userId: string; role: string },
  subjectMembership: { id: string; userId: string; orgId: string },
): Promise<ProfileAccess> {
  // Cross-organisation reads never resolve, whatever the matrix says.
  if (subjectMembership.orgId !== tenant.orgId) return DENIED;

  const org = await db.query.organizations.findFirst({
    where: eq(schema.organizations.id, tenant.orgId),
  });
  if (!org || !tierCarriesProfiles(org.planTier)) return DENIED;

  /*
    The subject branch (R49, R50, R51). Scoped to the Candidate access level:
    every other member's read of their own record is a matrix setting like
    anybody else's, which is what keeps this a protection rather than a hole.
  */
  if (tenant.role === 'candidate' && subjectMembership.userId === tenant.userId) {
    return {
      canView: true,
      canViewDocuments: true,
      canViewCompetencies: true,
      // Approving is never the subject's — a replacement they supply waits for
      // somebody the matrix admits (R52).
      canApprove: false,
      editableFields: candidateEditableFieldKeys(),
      isSubject: true,
    };
  }

  const granted = async (action: PermissionAction) =>
    (await permissionScope(tenant, 'profiles', action)) === 'all';

  const [canView, canViewDocuments, canViewCompetencies, canApprove, canEdit] = await Promise.all([
    granted('view'),
    granted('view_documents'),
    granted('view_competencies'),
    granted('approve'),
    granted('edit'),
  ]);

  return {
    canView,
    canViewDocuments,
    canViewCompetencies,
    canApprove,
    /*
      The matrix says whether this access level edits at all; WHICH fields is the
      inventory's answer, so the screen and the route read one description
      instead of each keeping a list. An access level admitted to edit writes
      every entered field — the candidate's narrower three are the subject
      branch above, and are theirs alone (R51).
    */
    editableFields: canEdit ? ADMIN_EDITABLE_FIELDS : [],
    isSubject: false,
  };
}


/**
 * Load the membership a profile hangs off, by the profile's own id.
 *
 * Returns null rather than throwing for a profile in another organisation, so a
 * caller answers "not found" and a probe cannot tell an existing record in
 * somebody else's organisation from one that does not exist.
 */
export async function membershipForProfile(
  db: Db,
  orgId: string,
  membershipId: string,
): Promise<{ id: string; userId: string; orgId: string; photoKey: string | null } | null> {
  const membership = await db.query.memberships.findFirst({
    where: and(eq(schema.memberships.id, membershipId), eq(schema.memberships.orgId, orgId)),
  });
  return membership ?? null;
}
