/**
 * The member profile's field inventory and its derived values (R2, R3, R12–R15).
 *
 * PURE: no database, no clock. Four consumers read this one description of the
 * record and must agree with each other — creation validates required presence
 * against it, the export redacts against its sensitive marks, a bulk-import row
 * is flagged for what it left empty against it, and the screen renders from it.
 * A column list cannot express any of that: "required at creation", "optional
 * indefinitely", "may follow and stays owed", "derived" and "generated" are five
 * different things (R12, R18) and a `NOT NULL` only knows about one.
 *
 * THE INVENTORY SPANS THE WHOLE RECORD, not one table. `storedOn` says where
 * each field actually lives — the profile row, the product-wide `users` row, the
 * membership's placement join tables, or nowhere at all because it is derived on
 * read. Consumers filter to the slice they own rather than each keeping a
 * private list that can drift.
 *
 * THE RECORD SERVES EVERY MEMBER. Only the `candidate` entry in `editableBy` is
 * a candidate's alone (R51); the inventory itself is any member's.
 */
import { CHC_ETHNICITIES, CHC_GENDERS, CHC_STARTER_TYPES, isIndigenousEthnicity } from './chc-intake.js';

/**
 * The demographic value sets (R14).
 *
 * Re-exported under product-neutral names rather than redefined, so there is one
 * list rather than two. They currently originate in the CHC intake module, which
 * is where they were first defined and where the intake form still reads them;
 * whether they are fixed product-wide or configurable per organisation is an
 * open question, and keeping the alias here is what makes answering it a change
 * to this module rather than to every consumer.
 */
export const PROFILE_GENDERS = CHC_GENDERS;
export const PROFILE_ETHNICITIES = CHC_ETHNICITIES;
export const PROFILE_STARTER_TYPES = CHC_STARTER_TYPES;

/** Where a field's value actually lives. */
export type ProfileFieldStorage =
  /** A column on `member_profiles`. */
  | 'profile'
  /** A column on the product-wide `users` row — the email address and the username. */
  | 'user'
  /** The membership's placement join tables, owned by the Organisation Settings work. */
  | 'membership'
  /** Computed on read and stored nowhere (KTD19). */
  | 'derived';

/**
 * What the field's presence means at creation (R12).
 *
 * `required` must carry a value before the profile exists; `optional` may stay
 * empty indefinitely and is never reported as outstanding; `may_follow` is owed
 * until it arrives and lists the record for follow-up without blocking anything
 * (R18); `derived` and `generated` are never entered by anybody.
 */
export type ProfilePresence = 'required' | 'optional' | 'may_follow' | 'derived' | 'generated';

/** Who may write a field where the organisation's matrix admits the writer at all (R51, R53). */
export type ProfileEditor = 'admin' | 'candidate';

export interface ProfileFieldSpec {
  key: string;
  label: string;
  storedOn: ProfileFieldStorage;
  presence: ProfilePresence;
  /**
   * Drives redaction in exports and agent-facing reads (R8). It does NOT decide
   * who sees the field on the profile itself — that is the organisation's own
   * matrix setting, a separate axis (R39, KTD26).
   */
  sensitive: boolean;
  /** Empty where nobody enters the value. The candidate's three are R51's, and theirs alone. */
  editableBy: readonly ProfileEditor[];
  /** The closed value set, where the field has one (R14). */
  options?: readonly string[];
}

const ADMIN: readonly ProfileEditor[] = ['admin'];
const ADMIN_AND_CANDIDATE: readonly ProfileEditor[] = ['admin', 'candidate'];
const NOBODY: readonly ProfileEditor[] = [];

/**
 * The inventory, in the contract's own order.
 *
 * The employee and swipe card numbers and the profile picture are appended by
 * the units that add their storage; every entry below is either stored by this
 * unit or lives somewhere this unit does not own.
 */
export const PROFILE_FIELDS: readonly ProfileFieldSpec[] = [
  { key: 'firstName', label: 'First name', storedOn: 'profile', presence: 'required', sensitive: false, editableBy: ADMIN },
  { key: 'middleName', label: 'Middle name', storedOn: 'profile', presence: 'optional', sensitive: false, editableBy: ADMIN },
  { key: 'lastName', label: 'Last name', storedOn: 'profile', presence: 'required', sensitive: false, editableBy: ADMIN },
  { key: 'displayName', label: 'Display name', storedOn: 'derived', presence: 'derived', sensitive: false, editableBy: NOBODY },
  { key: 'username', label: 'Username', storedOn: 'user', presence: 'generated', sensitive: false, editableBy: NOBODY },
  { key: 'gender', label: 'Gender', storedOn: 'profile', presence: 'required', sensitive: false, editableBy: ADMIN, options: PROFILE_GENDERS },
  { key: 'ethnicity', label: 'Ethnicity', storedOn: 'profile', presence: 'required', sensitive: true, editableBy: ADMIN, options: PROFILE_ETHNICITIES },
  { key: 'indigenousStatus', label: 'Indigenous status', storedOn: 'derived', presence: 'derived', sensitive: true, editableBy: NOBODY },
  { key: 'dateOfBirth', label: 'Date of birth', storedOn: 'profile', presence: 'required', sensitive: true, editableBy: ADMIN },
  { key: 'addressStreet', label: 'Street address', storedOn: 'profile', presence: 'required', sensitive: true, editableBy: ADMIN_AND_CANDIDATE },
  { key: 'suburb', label: 'Suburb', storedOn: 'profile', presence: 'required', sensitive: true, editableBy: ADMIN_AND_CANDIDATE },
  { key: 'postcode', label: 'Postcode', storedOn: 'profile', presence: 'required', sensitive: true, editableBy: ADMIN_AND_CANDIDATE },
  { key: 'mobile', label: 'Mobile', storedOn: 'profile', presence: 'required', sensitive: false, editableBy: ADMIN_AND_CANDIDATE },
  /*
    On `users`, where it is unique across the whole product and is the person-record
    lookup key (R16). Admin's to correct and never the candidate's, which is the
    whole reason sign-in hangs off a generated username instead (R21).
  */
  { key: 'email', label: 'Email', storedOn: 'user', presence: 'required', sensitive: false, editableBy: ADMIN },
  /*
    Not sensitive, departing deliberately from the induction pattern which
    withholds both: a next-of-kin contact is what an organisation needs to reach
    in the moment it matters.
  */
  { key: 'emergencyContactName', label: 'Emergency contact name', storedOn: 'profile', presence: 'required', sensitive: false, editableBy: ADMIN_AND_CANDIDATE },
  { key: 'emergencyContactPhone', label: 'Emergency contact phone', storedOn: 'profile', presence: 'required', sensitive: false, editableBy: ADMIN_AND_CANDIDATE },
  { key: 'starterType', label: 'Starter type', storedOn: 'profile', presence: 'required', sensitive: false, editableBy: ADMIN, options: PROFILE_STARTER_TYPES },
  { key: 'department', label: 'Department', storedOn: 'membership', presence: 'required', sensitive: false, editableBy: ADMIN },
  { key: 'roles', label: 'Roles', storedOn: 'membership', presence: 'required', sensitive: false, editableBy: ADMIN },
  { key: 'location', label: 'Location', storedOn: 'membership', presence: 'required', sensitive: false, editableBy: ADMIN },
  { key: 'inductionDate', label: 'Induction date', storedOn: 'profile', presence: 'optional', sensitive: false, editableBy: ADMIN },
];

const FIELD_BY_KEY = new Map(PROFILE_FIELDS.map((f) => [f.key, f]));

export function profileField(key: string): ProfileFieldSpec | undefined {
  return FIELD_BY_KEY.get(key);
}

/** Keys a value must be supplied for before the profile exists (R12). */
export function requiredProfileFieldKeys(storage?: ProfileFieldStorage): string[] {
  return PROFILE_FIELDS.filter((f) => f.presence === 'required' && (!storage || f.storedOn === storage)).map((f) => f.key);
}

/** Keys the export and agent-facing reads redact (R8). Document files are exempt (R29). */
export function sensitiveProfileFieldKeys(): string[] {
  return PROFILE_FIELDS.filter((f) => f.sensitive).map((f) => f.key);
}

/** The three fields a candidate writes on their own record, and nothing else (R51). */
export function candidateEditableFieldKeys(): string[] {
  return PROFILE_FIELDS.filter((f) => f.editableBy.includes('candidate')).map((f) => f.key);
}

/** Whether `editor` may write `key` at all, before any matrix question is asked. */
export function canEditProfileField(key: string, editor: ProfileEditor): boolean {
  return FIELD_BY_KEY.get(key)?.editableBy.includes(editor) ?? false;
}

// ── Derived values (KTD19) ──────────────────────────────────────────────────

/**
 * The display name (R3) — first and last, never the middle.
 *
 * Two workers share a name often enough that this is not an identification on
 * its own; U26 pairs it with an organisation-assigned identifier. The middle
 * name does not help on a screen, which is why it takes no part.
 */
export function displayNameOf(profile: { firstName: string; lastName: string }): string {
  return [profile.firstName, profile.lastName].map((p) => p.trim()).filter(Boolean).join(' ');
}

/**
 * Indigenous status (R15) — three values, entered by nobody.
 *
 * Derived from the ethnicity answer so the two can never contradict each other,
 * and carrying `not_stated` so a declined or absent ethnicity is never reported
 * as a fact about the person that nobody supplied.
 */
export type IndigenousStatus = 'indigenous' | 'not_indigenous' | 'not_stated';

export function indigenousStatusOf(ethnicity: string | null | undefined): IndigenousStatus {
  const derived = isIndigenousEthnicity(ethnicity ?? '');
  if (derived === null) return 'not_stated';
  return derived ? 'indigenous' : 'not_indigenous';
}

// ── Creation validation (R12, R13, R14) ─────────────────────────────────────

export type ProfileFieldFailure =
  /** A required field carries no value. */
  | { key: string; reason: 'missing' }
  /** A value outside the field's closed option set. */
  | { key: string; reason: 'not_an_option'; value: string };

export type ProfileValidationResult = { ok: true } | { ok: false; failures: ProfileFieldFailure[] };

/**
 * Whether the supplied values are enough to create a profile.
 *
 * Scoped to the fields this record stores: the email lives on `users` and the
 * placement on the membership, each validated by the path that writes it, so
 * validating them here would be a second implementation of a rule that already
 * has one. A required field answered with a decline counts as answered (R13) —
 * Undisclosed and Unknown are values, not blanks, which is the entire reason
 * they exist.
 */
export function validateProfileFields(values: Record<string, unknown>): ProfileValidationResult {
  const failures: ProfileFieldFailure[] = [];

  for (const field of PROFILE_FIELDS) {
    if (field.storedOn !== 'profile') continue;

    const raw = values[field.key];
    const value = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw);

    if (field.presence === 'required' && value.length === 0) {
      failures.push({ key: field.key, reason: 'missing' });
      continue;
    }
    // An optional field left empty is not checked against its options — absent
    // is a legitimate answer for it, unlike a required one.
    if (value.length > 0 && field.options && !field.options.includes(value)) {
      failures.push({ key: field.key, reason: 'not_an_option', value });
    }
  }

  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

/**
 * Which fields a landed record left empty, for the follow-up an import row
 * raises (R19) and the owed-file list (R18).
 *
 * Optional and may-follow fields only: a required one missing means no profile
 * was created at all, so it is a rejection rather than a gap.
 */
export function emptyOptionalProfileFields(values: Record<string, unknown>): string[] {
  return PROFILE_FIELDS.filter((f) => f.storedOn === 'profile')
    .filter((f) => f.presence === 'optional' || f.presence === 'may_follow')
    .filter((f) => {
      const raw = values[f.key];
      const value = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw);
      return value.length === 0;
    })
    .map((f) => f.key);
}
