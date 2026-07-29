/**
 * CHC @ BBM — Induction Intake Request Form.
 *
 * The domain rules of Charles Hull Contracting's new-starter/transfer intake,
 * in one place, because two surfaces have to agree on them exactly:
 *
 *  - `apps/web/src/screens/chc/ChcIntakeScreen.tsx`, the purpose-built form
 *    that reproduces the approved design and enforces every rule; and
 *  - `chcIntakeFields()` below, the same form expressed as a native
 *    `FormField[]` template, so it can be opened and edited in the builder like
 *    any other form.
 *
 * Keeping the department/role map, the holiday list and the induction-date rule
 * here means editing a role list updates both surfaces at once. If they lived in
 * the screen, the template would slowly become a stale copy of a form that had
 * moved on — and the template is the version an administrator would edit.
 */

import type { FormField } from './form-field.js';

/** Display name used for the seeded template and the printed document title. */
export const CHC_INTAKE_FORM_NAME = 'CHC BBM Induction Intake Request Form';

/** Fixed identifiers printed on the generated document. */
export const CHC_ORG_NAME = 'Charles Hull Contracting';
export const CHC_ABN = 'ABN 96 099 117 159';
export const CHC_DOCUMENT_REF = 'CHC-BBM-INTAKE-001';
export const CHC_SITE_SUBTITLE = 'South 32 Boddington Bauxite Mine — New Starter / Transfer';

/** Where a completed intake is sent. */
export const CHC_INTAKE_RECIPIENT = 'ash.wyborn@charleshull.com.au';

/**
 * Departments and the roles each one offers.
 *
 * `multi` is the load-bearing part: Operations crews are routinely inducted
 * against more than one machine (a dozer operator who also runs a grader), so
 * that department takes a set of roles. Every other department is one role per
 * starter, and offering multi-select there would let an administrator record a
 * combination the site does not induct.
 */
export interface ChcDepartment {
  multi: boolean;
  roles: readonly string[];
}

export const CHC_DEPARTMENTS: Readonly<Record<string, ChcDepartment>> = {
  Operations: {
    multi: true,
    roles: [
      'Scraper Operator',
      'Dozer Operator',
      'Grader Operator',
      'Excavator Operator (small <80t)',
      'Excavator Operator (large >80t)',
      'Loader Operator (small <80t)',
      'Loader Operator (large >80t)',
      'Haul Truck Operator',
      'General Field Worker / Labourer',
      'Supervisor / Leading Hand',
    ],
  },
  Maintenance: {
    multi: false,
    roles: [
      'HD Mechanic / Fitter',
      'Fitter Apprentice',
      'Boilermaker / Welder',
      'Boilermaker Apprentice',
      'Auto Electrician',
      'Auto Electrician Apprentice',
      'Service Person / Labourer',
      'Tyre Fitter',
      'Supervisor / Leading Hand',
    ],
  },
  Admin: {
    multi: false,
    roles: [
      'Administration / Admin',
      'Project Manager',
      'General Office',
      'WHSQ / WHS Advisor (office)',
      'Trainer Assessor',
    ],
  },
  'Off Site Support': {
    multi: false,
    roles: [
      'Roving Safety Advisor (field)',
      'WHS Trainee (field)',
      'General Field Based',
      'Delivery / Truck Driver',
      'Roving Trainer Assessor',
    ],
  },
};

export const CHC_DEPARTMENT_NAMES = Object.keys(CHC_DEPARTMENTS);

/** Australian heavy-vehicle licence classes, lightest to heaviest. */
export const CHC_LICENCE_CLASSES = ['C', 'LR', 'MR', 'HR', 'HC', 'MC'] as const;

export const CHC_GENDERS = ['Male', 'Female', 'Undisclosed'] as const;
export const CHC_STARTER_TYPES = ['New starter', 'Transfer'] as const;

/**
 * WA public holidays, as ISO `YYYY-MM-DD`.
 *
 * Mirrors the table in the mobilisation runbook
 * (`01-new-starter-intake/references/induction-rules.md`), which is the
 * authority — when the runbook is updated for a new year, this list follows it.
 *
 * A holiday does two things: no induction runs that day, and when it falls on a
 * Monday the induction moves to the Tuesday. The list is finite and WILL
 * expire; `holidaysCoverThrough` exists so a caller can say so out loud rather
 * than let a date past the end quietly look ordinary.
 */
export const CHC_PUBLIC_HOLIDAYS: readonly string[] = [
  '2026-01-01', // New Year's Day
  '2026-01-26', // Australia Day
  '2026-03-02', // WA Day
  '2026-04-06', // Easter Monday
  '2026-04-27', // ANZAC Day (observed)
  '2026-06-01', // Reconciliation Day
  '2026-09-28', // Queen's Birthday
  '2026-12-25', // Christmas Day
  '2026-12-28', // Boxing Day (observed)
];

/** The last date the holiday list actually covers. */
export function holidaysCoverThrough(): string {
  return CHC_PUBLIC_HOLIDAYS[CHC_PUBLIC_HOLIDAYS.length - 1] ?? '';
}

/** Local-midnight Date from an ISO `YYYY-MM-DD`, avoiding UTC-parse drift. */
function parseIsoDate(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const date = new Date(`${iso}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** ISO `YYYY-MM-DD` for a Date, in LOCAL time (never `toISOString`, which is UTC). */
export function toIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function isMonday(iso: string): boolean {
  const date = parseIsoDate(iso);
  return date ? date.getDay() === 1 : false;
}

export function isPublicHoliday(iso: string): boolean {
  return CHC_PUBLIC_HOLIDAYS.includes(iso);
}

/**
 * Whether the site actually runs an induction on this date.
 *
 * Mondays — except when the Monday is a public holiday, in which case the
 * induction moves to the Tuesday. That Tuesday is a real induction day and must
 * be bookable; treating it as an invalid date loses every starter in a holiday
 * week, since there is no other day that week to move them to.
 */
export function isInductionDay(iso: string): boolean {
  const date = parseIsoDate(iso);
  if (!date || isPublicHoliday(iso)) return false;

  const day = date.getDay();
  if (day === 1) return true;
  if (day !== 2) return false;

  // A Tuesday qualifies only as the stand-in for a holiday Monday.
  const monday = new Date(date);
  monday.setDate(monday.getDate() - 1);
  return isPublicHoliday(toIsoDate(monday));
}

/**
 * The Thursday a booking for `iso` must be made on or before.
 *
 * The site's rule is a CUTOFF, not a lead time: book any time you like, right
 * up to the Thursday before. Swipe cards print on the Friday afternoon, which
 * is what that Thursday is really about — a booking after it misses the card
 * run, not some notional paperwork window.
 */
export function bookingCutoffFor(iso: string): string | null {
  const date = parseIsoDate(iso);
  if (!date) return null;
  const cursor = new Date(date);
  do {
    cursor.setDate(cursor.getDate() - 1);
  } while (cursor.getDay() !== 4);
  return toIsoDate(cursor);
}

/** Whether a booking for `iso` can still be made as at `from`. */
export function withinBookingWindow(iso: string, from: Date = new Date()): boolean {
  const cutoff = bookingCutoffFor(iso);
  return cutoff !== null && toIsoDate(from) <= cutoff;
}

/**
 * The induction-date rule, as one answer.
 *
 * Returns null when the date is bookable, or the message to show. There is
 * deliberately NO minimum-notice test: short notice is not a reason to refuse a
 * booking, and the runbook says so in as many words. The only time question is
 * whether the Thursday cutoff has passed.
 */
export function validateInductionDate(iso: string, from: Date = new Date()): string | null {
  if (!iso) return 'Required';
  if (!parseIsoDate(iso)) return 'Enter a valid date';
  if (isPublicHoliday(iso)) {
    return isMonday(iso)
      ? 'That Monday is a public holiday — book the Tuesday instead'
      : 'That day is a public holiday — choose another';
  }
  if (!isInductionDay(iso)) return 'Must be a Monday (or the Tuesday after a public-holiday Monday)';
  if (!withinBookingWindow(iso, from)) {
    return `Bookings for that date closed on Thursday ${formatAuDate(bookingCutoffFor(iso)!)}`;
  }
  return null;
}

/**
 * The next bookable induction date — used to seed the date picker's `min`.
 * Bounded so a malformed holiday list can never spin: a year of candidates is
 * far more than the rule can ever need.
 */
export function nextBookableInductionDate(from: Date = new Date()): string {
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  for (let i = 0; i < 366; i++) {
    cursor.setDate(cursor.getDate() + 1);
    const iso = toIsoDate(cursor);
    if (validateInductionDate(iso, from) === null) return iso;
  }
  return toIsoDate(from);
}

/** `DD/MM/YYYY` for display and print — Australian order, never the ISO form. */
export function formatAuDate(iso: string): string {
  if (!iso) return '';
  const [year, month, day] = iso.split('-');
  return year && month && day ? `${day}/${month}/${year}` : iso;
}

/* ── The same form, as an editable template ──────────────────────────────── */

/**
 * Stable field ids. Exported because the intake screen keys its own answers by
 * them too, so a submission raised through either surface maps onto the same
 * template version without a translation table in between.
 */
export const CHC_FIELD_IDS = {
  personalSection: 'chc-sec-personal',
  firstName: 'first_name',
  middleName: 'middle_name',
  lastName: 'last_name',
  gender: 'gender',
  indigenous: 'indigenous',

  employmentSection: 'chc-sec-employment',
  starterType: 'starter_type',
  inductionDate: 'induction_date',
  department: 'department',
  roleOperations: 'role_operations',
  roleMaintenance: 'role_maintenance',
  roleAdmin: 'role_admin',
  roleOffSiteSupport: 'role_off_site_support',

  beakonSection: 'chc-sec-beakon',
  inBeakon: 'in_beakon',

  additionalSection: 'chc-sec-additional',
  mobile: 'mobile',
  email: 'email',
  dob: 'dob',
  addressStreet: 'address_street',
  suburb: 'suburb',
  postcode: 'postcode',
  emergencyContactName: 'emergency_contact_name',
  emergencyContactPhone: 'emergency_contact_phone',
  licenceClass: 'licence_class',
  licenceExpiry: 'licence_expiry',
  licenceNumber: 'licence_number',
  photo: 'photo',
  driversLicence: 'drivers_licence',
} as const;

/** Per-department role field id, so both surfaces resolve it the same way. */
export const CHC_ROLE_FIELD_BY_DEPARTMENT: Readonly<Record<string, string>> = {
  Operations: CHC_FIELD_IDS.roleOperations,
  Maintenance: CHC_FIELD_IDS.roleMaintenance,
  Admin: CHC_FIELD_IDS.roleAdmin,
  'Off Site Support': CHC_FIELD_IDS.roleOffSiteSupport,
};

/**
 * The intake form as native template fields.
 *
 * Two encodings are worth calling out, because they are how a form with real
 * conditional logic fits a field model that only knows `visibleWhen`:
 *
 * 1. ONE ROLE FIELD PER DEPARTMENT, each shown by a condition on `department`.
 *    The field model has no notion of options that depend on another answer, so
 *    a single "Role" field would have to list all twenty-nine roles at once and
 *    let someone book a Tyre Fitter into Admin. Four conditioned fields keep
 *    every list correct and stay fully editable — an administrator can add a
 *    role to Operations without touching the other three.
 *
 * 2. THE ADDITIONAL SECTION IS GATED ON ITS HEADER, not field by field.
 *    `visibleFields` expands a `section_header` condition across every field up
 *    to the next header, so "not in Beakon" is one authored rule rather than
 *    fourteen that could drift apart. `boolean_yes_no` normalises to the strings
 *    'true'/'false', which is why the condition compares against `'false'`.
 *
 * The induction-date rule is NOT expressible here — `FieldValidation` covers
 * email/number/regex/length only, and nothing in the platform enforces a
 * weekday-plus-notice constraint. It is stated in the field's help text and
 * enforced in full by the intake screen (`validateInductionDate`). A template
 * edited in the builder therefore collects the date but does not police it.
 */
export function chcIntakeFields(): FormField[] {
  const built = { source: 'built' } as const;

  return [
    { id: CHC_FIELD_IDS.personalSection, type: 'section_header', label: 'Personal Details', required: false, ...built },
    { id: CHC_FIELD_IDS.firstName, type: 'text', label: 'First name', required: true, placeholder: 'First name', colSpan: 6, ...built },
    { id: CHC_FIELD_IDS.lastName, type: 'text', label: 'Last name', required: true, placeholder: 'Last name', colSpan: 6, ...built },
    { id: CHC_FIELD_IDS.middleName, type: 'text', label: 'Middle name', required: false, colSpan: 12, ...built },
    {
      id: CHC_FIELD_IDS.gender,
      type: 'radio',
      label: 'Gender',
      required: true,
      options: [...CHC_GENDERS],
      colSpan: 12,
      ...built,
    },
    {
      id: CHC_FIELD_IDS.indigenous,
      type: 'boolean_yes_no',
      label: 'Indigenous (Aboriginal or Torres Strait Islander)?',
      required: true,
      colSpan: 12,
      ...built,
    },

    { id: CHC_FIELD_IDS.employmentSection, type: 'section_header', label: 'Employment Details', required: false, ...built },
    {
      id: CHC_FIELD_IDS.starterType,
      type: 'radio',
      label: 'New starter or transfer?',
      required: true,
      options: [...CHC_STARTER_TYPES],
      colSpan: 12,
      ...built,
    },
    {
      id: CHC_FIELD_IDS.inductionDate,
      type: 'date',
      label: 'Preferred induction date',
      required: true,
      help: 'Mondays only (Tuesday after a public holiday) · book by the Thursday before.',
      colSpan: 12,
      ...built,
    },
    {
      id: CHC_FIELD_IDS.department,
      type: 'dropdown',
      label: 'Department',
      required: true,
      options: [...CHC_DEPARTMENT_NAMES],
      colSpan: 12,
      ...built,
    },
    {
      id: CHC_FIELD_IDS.roleOperations,
      type: 'checkbox_group',
      label: 'Roles',
      required: true,
      help: 'Select one or more — dual roles are permitted for Operations.',
      selectionType: 'multiple',
      options: [...CHC_DEPARTMENTS.Operations!.roles],
      visibleWhen: { fieldId: CHC_FIELD_IDS.department, op: 'equals', value: 'Operations' },
      colSpan: 12,
      ...built,
    },
    ...(['Maintenance', 'Admin', 'Off Site Support'] as const).map(
      (dept): FormField => ({
        id: CHC_ROLE_FIELD_BY_DEPARTMENT[dept]!,
        type: 'dropdown',
        label: 'Role',
        required: true,
        options: [...CHC_DEPARTMENTS[dept]!.roles],
        visibleWhen: { fieldId: CHC_FIELD_IDS.department, op: 'equals', value: dept },
        colSpan: 12,
        ...built,
      }),
    ),

    { id: CHC_FIELD_IDS.beakonSection, type: 'section_header', label: 'Beakon Status', required: false, ...built },
    {
      id: CHC_FIELD_IDS.inBeakon,
      type: 'boolean_yes_no',
      label: 'Details already in Beakon (with photo & licence)?',
      required: true,
      colSpan: 12,
      ...built,
    },

    {
      id: CHC_FIELD_IDS.additionalSection,
      type: 'section_header',
      label: 'Additional Details',
      required: false,
      help: 'Not in Beakon — provide details below.',
      // Governs every field below it. 'false' is how `boolean_yes_no` reads as
      // a condition value (see `scalarAnswer` in visibility.ts).
      visibleWhen: { fieldId: CHC_FIELD_IDS.inBeakon, op: 'equals', value: 'false' },
      ...built,
    },
    { id: CHC_FIELD_IDS.mobile, type: 'text', label: 'Mobile', required: true, placeholder: 'Enter mobile', colSpan: 6, ...built },
    {
      id: CHC_FIELD_IDS.email,
      type: 'text',
      label: 'Email',
      required: true,
      placeholder: 'Enter email',
      validation: { kind: 'email' },
      colSpan: 6,
      ...built,
    },
    { id: CHC_FIELD_IDS.dob, type: 'date', label: 'Date of birth', required: true, colSpan: 12, ...built },
    { id: CHC_FIELD_IDS.addressStreet, type: 'text', label: 'Street address', required: true, placeholder: 'Enter address', colSpan: 12, ...built },
    { id: CHC_FIELD_IDS.suburb, type: 'text', label: 'Suburb', required: true, placeholder: 'Enter suburb', colSpan: 8, ...built },
    { id: CHC_FIELD_IDS.postcode, type: 'text', label: 'Postcode', required: true, placeholder: 'Enter postcode', colSpan: 4, ...built },
    { id: CHC_FIELD_IDS.emergencyContactName, type: 'text', label: 'Emergency contact name', required: true, colSpan: 6, ...built },
    { id: CHC_FIELD_IDS.emergencyContactPhone, type: 'text', label: 'Emergency contact phone', required: true, colSpan: 6, ...built },
    {
      id: CHC_FIELD_IDS.licenceClass,
      type: 'dropdown',
      label: 'Licence class',
      required: true,
      options: [...CHC_LICENCE_CLASSES],
      colSpan: 4,
      ...built,
    },
    { id: CHC_FIELD_IDS.licenceExpiry, type: 'date', label: 'Licence expiry', required: true, colSpan: 4, ...built },
    { id: CHC_FIELD_IDS.licenceNumber, type: 'text', label: 'Licence number', required: true, colSpan: 4, ...built },
    {
      id: CHC_FIELD_IDS.photo,
      type: 'file_upload',
      label: 'Profile photo',
      required: true,
      help: 'JPG or PNG · up to 10 MB',
      colSpan: 6,
      ...built,
    },
    {
      id: CHC_FIELD_IDS.driversLicence,
      type: 'file_upload',
      label: "Driver's licence image",
      required: true,
      help: 'JPG, PNG or PDF · up to 10 MB',
      colSpan: 6,
      ...built,
    },
  ];
}
