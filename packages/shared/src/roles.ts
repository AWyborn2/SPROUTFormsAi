/**
 * Roles & permissions.
 *
 * The prototype exercises a 5-role model (Owner/Admin/Builder/Reviewer/Viewer)
 * with a capability matrix. We adopt it as the source of truth (see the
 * implementation plan's "prototype vs brief" note). `assessor` and `candidate`
 * were added for multi-part assessments.
 *
 * SCOPE IS A MATRIX VALUE, NOT A NEW ROLE FLAG. Every one of the original five
 * roles can read every submission in the org, so none of them could be narrowed
 * to a candidate who must see only their own records. Rather than bolt a
 * parallel ownership concept beside the matrix, an action's value widened from
 * `boolean` to `boolean | 'own'`.
 *
 * That widening is deliberately fail-closed: every pre-existing call site tests
 * the value with `=== true`, so a scoped grant reads as DENIED to code that
 * predates scoping. A new call site that understands ownership asks
 * `resolveScope` instead and filters by owner. The failure mode of a missed
 * call site is therefore "candidate sees nothing", never "candidate sees
 * everything".
 *
 * Do not read matrix values for truthiness — `'own'` is a truthy string, so
 * `if (matrix.x.y)` grants full access to a scoped role. Use `matrixAllows`.
 */

export const ROLES = [
  'owner',
  'admin',
  'builder',
  'reviewer',
  'viewer',
  'assessor',
  'candidate',
] as const;
export type Role = (typeof ROLES)[number];

/** Human-facing labels, matching the prototype's casing. */
export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  builder: 'Builder',
  reviewer: 'Reviewer',
  viewer: 'Viewer',
  assessor: 'Assessor',
  candidate: 'Candidate',
};

/**
 * Roles that consume a staff seat. A candidate is a workforce member being
 * assessed, not a staff user: an operation with 15 trainers may enrol several
 * hundred candidates, so counting them against the same limit would exhaust
 * every plan at a single site.
 */
export const STAFF_ROLES: readonly Role[] = ROLES.filter((r) => r !== 'candidate');

/** Whether a role counts against the org's staff seat limit. */
export function countsAgainstStaffSeats(role: Role): boolean {
  return role !== 'candidate';
}

/** Capability categories and the actions each supports. */
export const PERMISSION_CATEGORIES = [
  'forms',
  'submissions',
  'team',
  'billing',
  'audit',
  'assessments',
  // Member profiles and personal information (R33). The matrix carried no such
  // category before — this is new work, not a switch that already existed. It
  // reaches ANY member's profile, not a candidate's alone.
  'profiles',
] as const;
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

export type PermissionAction =
  | 'view'
  | 'create'
  | 'edit'
  | 'delete'
  | 'export'
  | 'invite'
  | 'manage'
  // Approving a document is distinct from viewing or editing it (R34): a
  // document is approved without being changed, and a reader admitted to view
  // one is not thereby admitted to approve it. Used by the `profiles` category.
  | 'approve';

/**
 * What a role may do with an action. `'own'` means "only records this user
 * owns" — see the module docstring for why it is a value rather than a flag.
 */
export type PermissionValue = boolean | 'own';

/** The resolved breadth of a grant. */
export type PermissionScope = 'all' | 'own' | 'none';

/** A role's full capability matrix: category -> action -> value. */
export type PermissionMatrix = Record<
  PermissionCategory,
  Partial<Record<PermissionAction, PermissionValue>>
>;

export type RolePermissions = Record<Role, PermissionMatrix>;

/**
 * How broadly `category.action` is granted. Anything unrecognised resolves to
 * `none` rather than being guessed at — an unknown value in a stored matrix is
 * corruption or a downgrade, and neither should widen access.
 */
export function resolveScope(
  matrix: PermissionMatrix | undefined,
  category: PermissionCategory,
  action: PermissionAction,
): PermissionScope {
  const value = matrix?.[category]?.[action];
  if (value === true) return 'all';
  if (value === 'own') return 'own';
  return 'none';
}

/**
 * Whether `category.action` is granted org-wide. This is the boolean question
 * every pre-scoping call site was already asking; a scoped grant answers false.
 */
export function matrixAllows(
  matrix: PermissionMatrix | undefined,
  category: PermissionCategory,
  action: PermissionAction,
): boolean {
  return resolveScope(matrix, category, action) === 'all';
}

export type MembershipStatus = 'active' | 'invited' | 'suspended';

/** Every action denied. The base every role's matrix is built from. */
const NONE: Partial<Record<PermissionAction, PermissionValue>> = {
  view: false,
  create: false,
  edit: false,
  delete: false,
  export: false,
  invite: false,
  manage: false,
  approve: false,
};

/**
 * Default role capability matrix, seeded per-org into `role_permissions` on org
 * creation. Lives here rather than in `@formai/db` so it sits beside the types
 * and scope resolvers it describes; `@formai/db` re-exports it, so existing
 * import paths are unchanged.
 */
export const DEFAULT_ROLE_PERMISSIONS: RolePermissions = {
  owner: {
    forms: { view: true, create: true, edit: true, delete: true },
    submissions: { view: true, export: true, delete: true },
    team: { view: true, invite: true, manage: true },
    billing: { view: true, manage: true },
    audit: { view: true },
    assessments: { view: true, create: true, edit: true, delete: true, export: true },
    profiles: { view: true, edit: true, approve: true },
  },
  admin: {
    forms: { view: true, create: true, edit: true, delete: true },
    submissions: { view: true, export: true, delete: true },
    team: { view: true, invite: true, manage: true },
    billing: { view: true, manage: false },
    audit: { view: true },
    assessments: { view: true, create: true, edit: true, delete: true, export: true },
    profiles: { view: true, edit: true, approve: true },
  },
  builder: {
    forms: { view: true, create: true, edit: true, delete: false },
    submissions: { view: true, export: true, delete: false },
    team: { view: true, invite: false, manage: false },
    billing: { view: false, manage: false },
    audit: { view: false },
    assessments: { view: true, create: false, edit: false, delete: false, export: false },
    profiles: { view: false, edit: false, approve: false },
  },
  reviewer: {
    forms: { view: true, create: false, edit: false, delete: false },
    submissions: { view: true, export: true, delete: false },
    team: { view: true, invite: false, manage: false },
    billing: { view: false, manage: false },
    audit: { view: true },
    assessments: { view: true, create: false, edit: false, delete: false, export: true },
    profiles: { view: false, edit: false, approve: false },
  },
  viewer: {
    forms: { view: true, create: false, edit: false, delete: false },
    submissions: { view: true, export: false, delete: false },
    team: { view: false, invite: false, manage: false },
    billing: { view: false, manage: false },
    audit: { view: false },
    assessments: { view: true, create: false, edit: false, delete: false, export: false },
    profiles: { view: false, edit: false, approve: false },
  },
  /**
   * Runs assessments but does not administer the org. Eligibility to assess a
   * PARTICULAR tool is a competency question, not a role one — this grant says
   * "may run assessments at all", and the tool's required assessor competencies
   * say "on which equipment".
   */
  assessor: {
    forms: { view: true, create: false, edit: false, delete: false },
    submissions: { view: true, export: true, delete: false },
    team: { view: true, invite: false, manage: false },
    billing: { view: false, manage: false },
    audit: { view: false },
    assessments: { view: true, create: true, edit: true, delete: false, export: true },
    // R35: on the shipped default an assessor may view member profiles and the
    // documents on them, and approve those documents — so they can judge
    // eligibility and accept training evidence. Not edit. The candidate profile
    // artifact owns tightening or loosening this per organisation.
    profiles: { view: true, edit: false, approve: true },
  },
  /**
   * The workforce member being assessed. Scoped to their own cases and denied
   * everything else outright — a candidate reaches their assessment through
   * their case, never through the org's form or submission lists.
   */
  candidate: {
    forms: { ...NONE },
    submissions: { ...NONE },
    team: { ...NONE },
    billing: { ...NONE },
    audit: { ...NONE },
    assessments: { view: 'own', edit: 'own', create: false, delete: false, export: false },
    // A candidate's access to their OWN record sits outside this category and is
    // fixed by the candidate profile artifact (R36); the matrix cannot grant or
    // take it away, so the category itself grants a candidate nothing.
    profiles: { ...NONE },
  },
};

export function defaultMatrixFor(role: Role): PermissionMatrix {
  return DEFAULT_ROLE_PERMISSIONS[role];
}
