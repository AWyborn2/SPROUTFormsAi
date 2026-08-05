/**
 * The CHC intake form's state, validation, and mapping onto template values.
 *
 * Pure and React-free so the rules are unit-testable without rendering — the
 * same split every other rule module in this app uses (`fill-steps`,
 * `validation`, `submission-display`). The domain constants and the
 * induction-date rule itself live in `@formai/shared/chc-intake`, shared with
 * the editable template definition.
 */
import {
  CHC_DEPARTMENTS,
  CHC_FIELD_IDS,
  CHC_ROLE_FIELD_BY_DEPARTMENT,
  validateInductionDate,
} from '@formai/shared';
import type { SubmissionFileRef, SubmissionValue } from '@formai/shared';

export interface ChcIntakeState {
  first_name: string;
  middle_name: string;
  last_name: string;
  gender: string;
  /** '' until answered — distinct from an answered 'No'. */
  ethnicity: string;
  starter_type: string;
  induction_date: string;
  department: string;
  /** Selected roles. Single-role departments hold at most one entry. */
  role: string[];
  mobile: string;
  email: string;
  dob: string;
  address_street: string;
  suburb: string;
  postcode: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  licence_class: string;
  licence_expiry: string;
  licence_number: string;
  /** Set only once the bytes are stored — see `FileUploadField`'s reasoning. */
  photo: SubmissionFileRef | null;
  drivers_licence: SubmissionFileRef | null;
}

export function emptyChcIntakeState(): ChcIntakeState {
  return {
    first_name: '',
    middle_name: '',
    last_name: '',
    gender: '',
    ethnicity: '',
    starter_type: '',
    induction_date: '',
    department: '',
    role: [],
    mobile: '',
    email: '',
    dob: '',
    address_street: '',
    suburb: '',
    postcode: '',
    emergency_contact_name: '',
    emergency_contact_phone: '',
    licence_class: '',
    licence_expiry: '',
    licence_number: '',
    photo: null,
    drivers_licence: null,
  };
}

/**
 * A Department as the organisation's taxonomy carries it — the shape the intake
 * needs to resolve the one-or-several rule and the offer set (R5). Supplied by
 * the org's taxonomy when it has one; when omitted, the lookups fall back to the
 * hardcoded CHC map, so a customer with no taxonomy yet keeps the original
 * behaviour unchanged.
 */
export interface OrgDepartmentLite {
  name: string;
  allowsMultipleRoles: boolean;
  roles: Array<{ name: string; status: 'active' | 'retired' }>;
}

/** Does this department take more than one role? Taxonomy-backed when supplied (R5). */
export function isMultiRoleDepartment(department: string, orgDepartments?: OrgDepartmentLite[]): boolean {
  if (orgDepartments) {
    return orgDepartments.find((d) => d.name === department)?.allowsMultipleRoles ?? false;
  }
  return CHC_DEPARTMENTS[department]?.multi ?? false;
}

/** Roles offered by a department; empty when none is chosen yet. Taxonomy-backed when supplied (R5, R17). */
export function rolesForDepartment(
  department: string,
  orgDepartments?: OrgDepartmentLite[],
): readonly string[] {
  if (orgDepartments) {
    const dep = orgDepartments.find((d) => d.name === department);
    return dep ? dep.roles.filter((r) => r.status === 'active').map((r) => r.name) : [];
  }
  return CHC_DEPARTMENTS[department]?.roles ?? [];
}

/** Loose email shape check, matching the platform's own `EMAIL_RE`. */
const EMAIL_RE = /.+@.+\..+/;
/** Australian postcodes are exactly four digits. */
const POSTCODE_RE = /^\d{4}$/;
/** Digits, spaces, +, -, and parens — tolerant of how people write numbers. */
const PHONE_RE = /^[+\d][\d\s()-]{7,}$/;

export type ChcErrors = Partial<Record<keyof ChcIntakeState, string>>;

/**
 * Every rule the form enforces, as one map of field → message.
 *
 * `now` is injected rather than read from the clock so the notice rule is
 * testable against a fixed date. The Beakon-conditional block is validated only
 * when it is actually shown, matching the platform's own rule that a hidden
 * required field must never block a submit.
 */
export function validateChcIntake(
  state: ChcIntakeState,
  now: Date = new Date(),
  orgDepartments?: OrgDepartmentLite[],
): ChcErrors {
  const errors: ChcErrors = {};

  if (!state.first_name.trim()) errors.first_name = 'Required';
  if (!state.last_name.trim()) errors.last_name = 'Required';
  if (!state.gender) errors.gender = 'Please select';
  if (!state.ethnicity) errors.ethnicity = 'Please select';
  if (!state.starter_type) errors.starter_type = 'Please select';
  if (!state.department) errors.department = 'Please select';

  if (state.role.length === 0) {
    errors.role = isMultiRoleDepartment(state.department, orgDepartments)
      ? 'Select at least one role'
      : 'Please select';
  } else {
    // A role left over from a previously-chosen department would submit a
    // combination the site does not induct, so the selection is checked against
    // the CURRENT department rather than merely being non-empty. When the org's
    // taxonomy is supplied, the offer set comes from it (R5, R17).
    const offered = rolesForDepartment(state.department, orgDepartments);
    if (state.role.some((r) => !offered.includes(r))) {
      errors.role = 'Select a role for the chosen department';
    }
  }

  const dateError = validateInductionDate(state.induction_date, now);
  if (dateError) errors.induction_date = dateError;

  {
    if (!state.mobile.trim()) errors.mobile = 'Required';
    else if (!PHONE_RE.test(state.mobile.trim())) errors.mobile = 'Enter a valid phone number';

    if (!state.email.trim()) errors.email = 'Required';
    else if (!EMAIL_RE.test(state.email.trim())) errors.email = 'Enter a valid email address';

    if (!state.dob) errors.dob = 'Required';
    else if (state.dob >= isoToday(now)) errors.dob = 'Date of birth must be in the past';

    if (!state.address_street.trim()) errors.address_street = 'Required';
    if (!state.suburb.trim()) errors.suburb = 'Required';

    if (!state.postcode.trim()) errors.postcode = 'Required';
    else if (!POSTCODE_RE.test(state.postcode.trim())) errors.postcode = 'Enter a 4-digit postcode';

    if (!state.emergency_contact_name.trim()) errors.emergency_contact_name = 'Required';

    if (!state.emergency_contact_phone.trim()) errors.emergency_contact_phone = 'Required';
    else if (!PHONE_RE.test(state.emergency_contact_phone.trim())) {
      errors.emergency_contact_phone = 'Enter a valid phone number';
    }

    if (!state.licence_class) errors.licence_class = 'Required';

    if (!state.licence_expiry) errors.licence_expiry = 'Required';
    // An expired licence is the thing this field exists to catch — accepting one
    // silently would put someone on site without a current authority to drive.
    else if (state.licence_expiry < isoToday(now)) errors.licence_expiry = 'Licence has expired';

    if (!state.licence_number.trim()) errors.licence_number = 'Required';
    if (!state.photo) errors.photo = 'Required';
    if (!state.drivers_licence) errors.drivers_licence = 'Required';
  }

  return errors;
}

/** Local-time ISO date for `now` — never `toISOString`, which is UTC. */
function isoToday(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * The state as template values, keyed by the shared field ids.
 *
 * This is what makes the purpose-built screen and the editable template two
 * views of ONE form rather than two forms that look alike: a submission raised
 * here lands on the same field ids the template defines, so it renders in the
 * submission detail view and exports like any other.
 *
 * Fields the respondent could not see are omitted rather than sent empty. The
 * server strips hidden values anyway (`stripHiddenValues`), but sending them
 * would mean the request and the stored record disagree about what was asked.
 */
export function chcSubmissionValues(state: ChcIntakeState): Record<string, SubmissionValue> {
  const values: Record<string, SubmissionValue> = {
    [CHC_FIELD_IDS.firstName]: state.first_name.trim(),
    [CHC_FIELD_IDS.middleName]: state.middle_name.trim(),
    [CHC_FIELD_IDS.lastName]: state.last_name.trim(),
    [CHC_FIELD_IDS.gender]: state.gender,
    [CHC_FIELD_IDS.ethnicity]: state.ethnicity,
    [CHC_FIELD_IDS.starterType]: state.starter_type,
    [CHC_FIELD_IDS.inductionDate]: state.induction_date,
    [CHC_FIELD_IDS.department]: state.department,
  };

  // Only the CHOSEN department's role field carries an answer; the other three
  // are hidden by their own conditions and must stay absent.
  const roleFieldId = CHC_ROLE_FIELD_BY_DEPARTMENT[state.department];
  if (roleFieldId) {
    values[roleFieldId] = isMultiRoleDepartment(state.department)
      ? [...state.role]
      : (state.role[0] ?? '');
  }

  {
    values[CHC_FIELD_IDS.mobile] = state.mobile.trim();
    values[CHC_FIELD_IDS.email] = state.email.trim();
    values[CHC_FIELD_IDS.dob] = state.dob;
    values[CHC_FIELD_IDS.addressStreet] = state.address_street.trim();
    values[CHC_FIELD_IDS.suburb] = state.suburb.trim();
    values[CHC_FIELD_IDS.postcode] = state.postcode.trim();
    values[CHC_FIELD_IDS.emergencyContactName] = state.emergency_contact_name.trim();
    values[CHC_FIELD_IDS.emergencyContactPhone] = state.emergency_contact_phone.trim();
    values[CHC_FIELD_IDS.licenceClass] = state.licence_class;
    values[CHC_FIELD_IDS.licenceExpiry] = state.licence_expiry;
    values[CHC_FIELD_IDS.licenceNumber] = state.licence_number.trim();
    if (state.photo) values[CHC_FIELD_IDS.photo] = state.photo;
    if (state.drivers_licence) values[CHC_FIELD_IDS.driversLicence] = state.drivers_licence;
  }

  return values;
}

/** Full name for the document header and email subject. */
export function chcFullName(state: ChcIntakeState): string {
  return [state.first_name, state.middle_name, state.last_name]
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' ');
}
