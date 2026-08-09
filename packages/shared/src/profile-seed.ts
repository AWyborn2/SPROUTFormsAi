import type { StarterProfile } from './induction.js';
import { indigenousStatusOf, profileField } from './profile.js';

/**
 * An induction submission → a member profile (U40, R87–R94).
 *
 * PURE, and it lives here rather than in the route because the intake's field
 * ids and the profile's fields are TWO VOCABULARIES. The translation between
 * them is a fact worth testing on its own, and a route that did it inline would
 * be the only record of what maps to what.
 *
 * Reads `readStarterProfile`'s output rather than the raw submission, so the
 * intake's own extraction — including which questions a template version asked
 * at all — is not reimplemented here.
 *
 * WHAT DOES NOT CARRY ACROSS, and each for its own reason:
 *
 *  - DOCUMENTS. A submission holds only a marker that a file was supplied; the
 *    bytes were never kept, so there is nothing to attach and pretending
 *    otherwise would record evidence nobody holds.
 *  - EMPLOYEE and SWIPE CARD NUMBERS. No submission asks for them — they are
 *    the organisation's to issue, and Admin's to enter afterwards (R53).
 *  - INDIGENOUS STATUS. Derived from the ethnicity answer by the same
 *    derivation every other reader uses (R15), never mapped as a value of its
 *    own — a mapped copy could disagree with the derivation.
 */

/** The profile fields a submission can fill, keyed by the inventory's own keys. */
export type ProfileSeedFields = Record<string, string>;

export interface ProfileSeed {
  /** Inventory-keyed values ready for the profile create route. */
  fields: ProfileSeedFields;
  /** The Department the submission named, for the placement picker. */
  department: string;
  /** The Roles it named. Always an array — Operations may hold several. */
  roles: string[];
  /** The address, which is how a repeat submission is matched to a person. */
  email: string;
  /**
   * Derived, never seeded — surfaced so the create screen can render it
   * read-only beside the ethnicity it comes from (R15).
   */
  indigenousStatus: 'indigenous' | 'not_indigenous' | 'not_stated';
  /**
   * Values the submission carries that the organisation's current lists do not
   * offer (R94).
   *
   * Reaches only a HISTORICAL submission: one raised since the organisation's
   * lists exist can carry only values those lists hold. For an older one the
   * answer is a SUGGESTION and an Admin picks from the current lists, which is
   * why these are reported rather than written.
   */
  unmatched: Array<{ key: string; value: string }>;
}

/** Everything the seed writes, so a caller cannot silently widen it. */
const SEEDED_KEYS = [
  'firstName',
  'middleName',
  'lastName',
  'gender',
  'ethnicity',
  'dateOfBirth',
  'addressStreet',
  'suburb',
  'postcode',
  'mobile',
  'emergencyContactName',
  'emergencyContactPhone',
  'starterType',
  'inductionDate',
] as const;

/**
 * Build the seed from an extracted starter.
 *
 * `taxonomy` is the organisation's current option lists, where the caller has
 * them. Supplying none skips the R94 check entirely rather than reporting every
 * value as unmatched — an absent list is not evidence that a value is wrong.
 */
export function seedProfileFromStarter(
  starter: StarterProfile,
  taxonomy?: { departments?: readonly string[]; roles?: readonly string[] },
): ProfileSeed {
  const raw: Record<string, string> = {
    firstName: starter.firstName,
    middleName: starter.middleName,
    lastName: starter.lastName,
    gender: starter.gender,
    ethnicity: starter.ethnicity,
    dateOfBirth: starter.sensitive.dob,
    addressStreet: starter.sensitive.addressStreet,
    suburb: starter.sensitive.suburb,
    postcode: starter.sensitive.postcode,
    mobile: starter.mobile,
    emergencyContactName: starter.sensitive.emergencyContactName,
    emergencyContactPhone: starter.sensitive.emergencyContactPhone,
    starterType: starter.starterType,
    inductionDate: starter.inductionDate,
  };

  /*
    A blank answer is DROPPED rather than written as an empty string. The two are
    different facts — "the form never asked" and "they left it blank" both come
    through as empty here — and writing one would turn an unanswered required
    field into an answered-with-nothing one that no longer lists for follow-up.
  */
  const fields: ProfileSeedFields = {};
  for (const key of SEEDED_KEYS) {
    const value = raw[key]?.trim();
    if (value) fields[key] = value;
  }

  /*
    R94: a value the organisation's current lists do not offer. Checked only for
    the CLOSED fields the inventory marks — an open text field has no list to
    fail against, and reporting a mobile number as unmatched would be nonsense.
  */
  const unmatched: Array<{ key: string; value: string }> = [];
  for (const key of ['gender', 'ethnicity', 'starterType'] as const) {
    const value = fields[key];
    const options = profileField(key)?.options;
    if (value && options && !options.includes(value)) unmatched.push({ key, value });
  }
  if (taxonomy?.departments && starter.department && !taxonomy.departments.includes(starter.department)) {
    unmatched.push({ key: 'department', value: starter.department });
  }
  for (const role of starter.roles) {
    if (taxonomy?.roles && !taxonomy.roles.includes(role)) unmatched.push({ key: 'roles', value: role });
  }

  return {
    fields,
    department: starter.department,
    roles: [...starter.roles],
    email: starter.email,
    // The one derived value, from the same function every other reader uses.
    indigenousStatus: indigenousStatusOf(fields.ethnicity ?? null),
    unmatched,
  };
}

/** How a repeat submission is dealt with (R89, R90). */
export type SeedDisposition =
  /** Nobody holds this address in the organisation — the seed creates a record. */
  | 'create'
  /** Somebody does. Nothing is created; an Admin is told and asked (R90). */
  | 'existing_record'
  /** They hold a record but have been deactivated — an Admin is asked to reactivate. */
  | 'deactivated';

/**
 * What to do with a submission, given who already holds its address.
 *
 * MATCHES ON THE ADDRESS ALONE, which is what U28's import row does for the
 * other inbound path — the two must agree, because a person entering through
 * both must not end up with two records. A richer match (name plus date of
 * birth, say) is the contract's deferred question, and answering it here would
 * silently make the two paths disagree.
 *
 * A repeat NEVER creates a second record (R89). It goes to an Admin, who is
 * told the record exists and asked whether the person should be reactivated
 * (R90) — a decision with a seat cost, so it is not one to take automatically.
 */
export function dispositionForSubmission(match: {
  hasMembership: boolean;
  membershipStatus?: string;
}): SeedDisposition {
  if (!match.hasMembership) return 'create';
  return match.membershipStatus === 'suspended' ? 'deactivated' : 'existing_record';
}
