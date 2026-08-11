/**
 * Bulk workforce import — the template, the parser and the row validator (U23,
 * KTD13). PURE: no database, no clock. The seat-cost preview and the run both
 * read these, so they cannot disagree about what a file says or which rows it
 * rejects.
 *
 * ONE FILE, TWO SECTIONS (KTD13). A `#profiles` block carries one row per person
 * with the Access level they land with and their placement by NAME; a
 * `#competencies` block carries one line per competency with its grant date and,
 * optionally, an explicit expiry. The import references taxonomy by name because
 * that is what a human fills in, and the validator resolves each name against
 * the organisation's ACTIVE taxonomy — it creates nothing (R169).
 *
 * BOTH COMPETENCY DATES ARE OPTIONAL (R153, reversed). Blank is UNKNOWN, not a
 * rejection: a migrated source system may record only an explicit expiry (a
 * driver's licence renewed on a schedule no validity period can express), or
 * neither date at all. Only a PRESENT but unreadable date rejects a line — that
 * is a typo, not an absence.
 *
 * VALIDATION IS EXHAUSTIVE AND REUSES ONE RULE. Placement (which Roles a
 * Department offers, and how many) is checked by the very `validatePlacement`
 * the team screen calls (R155), never a second implementation that could drift.
 * Every rejection carries its reason; a known email address is NOT a rejection
 * (R148/R149) — it validates and U24 merges it.
 */
import { validatePlacement, type PlacementContext } from './placement.js';
import { ROLE_LABELS, type Role } from './roles.js';

/** The header a filled file must carry, and the columns each section takes. */
export const WORKFORCE_IMPORT_TEMPLATE = [
  '#profiles',
  [
    'name',
    'email',
    'access_level',
    'locations',
    'departments',
    'roles',
    'employee_number',
    'swipe_card_number',
    // The profile fields (R19, R154). EVERY ONE OPTIONAL IN THE FILE: a source
    // system holds what it holds, and a column left blank lands the row flagged
    // for that field rather than rejecting the person over it.
    'middle_name',
    'date_of_birth',
    'gender',
    'ethnicity',
    'address_street',
    'suburb',
    'postcode',
    'mobile',
    'emergency_contact_name',
    'emergency_contact_phone',
    'starter_type',
  ].join(','),
  '',
  '#competencies',
  'email,competency,grant_date,expiry_date,evidence',
  '',
].join('\n');

/** Multi-value cells (locations/departments/roles) list several values, separated by ';'. */
const MULTI_SEP = ';';

export interface RawProfileRow {
  /** 1-based line in the source file, for the rejection table. */
  rowNumber: number;
  name: string;
  email: string;
  accessLevel: string;
  locations: string[];
  departments: string[];
  roles: string[];
  employeeNumber: string;
  swipeCardNumber: string;
  /**
   * The profile fields, ALL OPTIONAL and all carried as written (R19, R154).
   * A file built from an older template supplies none of them and parses
   * exactly as it did before — the header decides which columns are present,
   * so an absent column and an empty cell are the same thing here.
   */
  middleName: string;
  dateOfBirth: string;
  gender: string;
  ethnicity: string;
  addressStreet: string;
  suburb: string;
  postcode: string;
  mobile: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  starterType: string;
}

export interface RawCompetencyRow {
  rowNumber: number;
  email: string;
  competency: string;
  /** Blank is valid (R153, reversed) — the grant date may simply be unknown. */
  grantDate: string;
  /**
   * An explicit end date, overriding whatever the competency's validity would
   * derive. For the record a migrated source system tracks directly rather
   * than by formula — a driver's licence renewed on a schedule no validity
   * period can express — where a grant date may never be supplied at all.
   */
  expiryDate: string;
  evidence: string;
}

export interface ParsedImport {
  profiles: RawProfileRow[];
  competencies: RawCompetencyRow[];
}

/** Split one CSV line into fields, honouring double-quoted fields that contain commas. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields.map((f) => f.trim());
}

const multi = (cell: string): string[] =>
  cell
    .split(MULTI_SEP)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

/**
 * Parse a filled template into raw profile and competency rows. Blank lines and
 * the two column-header lines are skipped; `rowNumber` is the 1-based source
 * line so a rejection points a human at the right row.
 *
 * THE COMPETENCY SECTION IS READ BY ITS OWN HEADER, not by fixed position.
 * `expiry_date` was added between `grant_date` and `evidence`, so a file filled
 * from the PREVIOUS template has evidence where expiry now sits — read
 * positionally, that evidence string parses as a date, fails, and rejects a
 * perfectly good line as `bad_expiry_date`. Naming the columns means both
 * shapes read correctly, and a file whose columns were reordered by a
 * spreadsheet does too. The header is the one line that says what the file
 * means; using it is cheaper than any migration note nobody reads.
 */
export function parseWorkforceCsv(text: string): ParsedImport {
  const profiles: RawProfileRow[] = [];
  const competencies: RawCompetencyRow[] = [];
  let section: 'none' | 'profiles' | 'competencies' = 'none';
  /*
    Competency column name → its index in this file. Defaults to the CURRENT
    template's order, so a section with no header line at all still reads as
    today's shape rather than as nothing.
  */
  let competencyColumns: Record<string, number> = {
    email: 0,
    competency: 1,
    grant_date: 2,
    expiry_date: 3,
    evidence: 4,
  };
  /*
    The same for the profiles section, and defaulting to the EIGHT columns the
    template carried before the profile fields were added — which is what a file
    with no header line is overwhelmingly likely to be. A name absent from this
    map reads as an empty cell, so the added columns cost an older file nothing.
  */
  let profileColumns: Record<string, number> = {
    name: 0,
    email: 1,
    access_level: 2,
    locations: 3,
    departments: 4,
    roles: 5,
    employee_number: 6,
    swipe_card_number: 7,
  };

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    const rowNumber = i + 1;
    if (line.length === 0) continue;
    if (line.toLowerCase() === '#profiles') {
      section = 'profiles';
      continue;
    }
    if (line.toLowerCase() === '#competencies') {
      section = 'competencies';
      continue;
    }
    // The column-header line at the top of each section.
    if (section === 'profiles' && line.toLowerCase().startsWith('name,')) {
      profileColumns = {};
      splitCsvLine(raw).forEach((name, index) => {
        profileColumns[name.trim().toLowerCase()] = index;
      });
      continue;
    }
    if (section === 'competencies' && line.toLowerCase().startsWith('email,')) {
      competencyColumns = {};
      splitCsvLine(raw).forEach((name, index) => {
        competencyColumns[name.trim().toLowerCase()] = index;
      });
      continue;
    }

    const f = splitCsvLine(raw);
    if (section === 'profiles') {
      const at = (name: string): string => {
        const index = profileColumns[name];
        return index === undefined ? '' : (f[index] ?? '');
      };
      profiles.push({
        rowNumber,
        name: at('name'),
        email: at('email'),
        accessLevel: at('access_level'),
        locations: multi(at('locations')),
        departments: multi(at('departments')),
        roles: multi(at('roles')),
        employeeNumber: at('employee_number'),
        swipeCardNumber: at('swipe_card_number'),
        middleName: at('middle_name'),
        dateOfBirth: at('date_of_birth'),
        gender: at('gender'),
        ethnicity: at('ethnicity'),
        addressStreet: at('address_street'),
        suburb: at('suburb'),
        postcode: at('postcode'),
        mobile: at('mobile'),
        emergencyContactName: at('emergency_contact_name'),
        emergencyContactPhone: at('emergency_contact_phone'),
        starterType: at('starter_type'),
      });
    } else if (section === 'competencies') {
      // A column the header never named reads as absent, not as field 0.
      const cell = (name: string) => {
        const index = competencyColumns[name];
        return index === undefined ? '' : (f[index] ?? '');
      };
      competencies.push({
        rowNumber,
        email: cell('email'),
        competency: cell('competency'),
        grantDate: cell('grant_date'),
        expiryDate: cell('expiry_date'),
        evidence: cell('evidence'),
      });
    }
  }
  return { profiles, competencies };
}

/** Every reason a row can be rejected — exhaustive, each carried into the report (R170). */
export type ImportRejectionReason =
  | 'missing_name'
  | 'missing_email'
  | 'missing_access_level'
  | 'unknown_access_level'
  | 'candidate_not_allowed'
  | 'missing_location'
  | 'unknown_location'
  | 'unknown_department'
  | 'unknown_role'
  | 'role_not_offered'
  | 'too_many_roles'
  | 'unknown_competency'
  | 'unknown_profile_email'
  /** Present but unreadable — blank is not this; blank means "unknown" (R153, reversed). */
  | 'bad_grant_date'
  | 'bad_expiry_date'
  /*
    A date of birth that is present but unreadable, on the same rule as the two
    above: blank is a gap and lands flagged, a cell somebody filled in and got
    wrong is an error worth showing them. Rejecting the person over it rather
    than dropping the value is deliberate — this is the field an identity check
    against a licence runs on, so a date silently discarded reads afterwards as
    a date nobody ever had.
  */
  | 'bad_date_of_birth'
  /*
    R7: both workforce numbers are unique WITHIN the organisation, which is what
    lets either tell two people of the same name apart. A duplicate is a
    rejection rather than a merge — unlike a known email address, which R149
    makes a merge, because an address identifies a person while an identifier
    that names two people identifies nobody. Both reasons cover a clash against
    a number already issued in the organisation AND a repeat within one file:
    the second is the more likely mistake and the validator sees the whole file.
  */
  | 'duplicate_employee_number'
  | 'duplicate_swipe_card_number';

export interface RejectedRow {
  rowNumber: number;
  /** The person's name (or email) so the Admin can find the row in their file. */
  subject: string;
  reason: ImportRejectionReason;
  /** The offending value, when there is one (a Role name, a bad date, …). */
  detail?: string;
}

/** A profile row that passed, with taxonomy resolved to ids and the Access level as a Role. */
export interface ValidProfileRow {
  rowNumber: number;
  name: string;
  email: string;
  role: Role;
  locationIds: string[];
  departmentIds: string[];
  roleIds: string[];
  employeeNumber: string;
  swipeCardNumber: string;
  /**
   * The profile fields as they will be stored (R19, R154). Empty means the file
   * did not supply one — the row still lands, and `incompleteProfileFields`
   * names what is missing on the way through.
   *
   * `dateOfBirth` is NORMALISED to ISO `YYYY-MM-DD` here, matching the column
   * it lands in, so the organisation's day/month order is resolved once at the
   * boundary rather than travelling further in as an ambiguous string.
   */
  middleName: string;
  dateOfBirth: string;
  gender: string;
  ethnicity: string;
  addressStreet: string;
  suburb: string;
  postcode: string;
  mobile: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  starterType: string;
}

/** A competency line that passed, with the competency resolved and its dates parsed. */
export interface ValidCompetencyRow {
  rowNumber: number;
  email: string;
  competencyId: string;
  /** Null when the file left it blank (R153, reversed) — held, but undated. */
  grantedAt: Date | null;
  /** Null unless the file supplied one; overrides whatever the competency's validity would derive. */
  expiresAt: Date | null;
  evidence: string;
}

export interface ValidatedImport {
  validProfiles: ValidProfileRow[];
  validCompetencies: ValidCompetencyRow[];
  rejected: RejectedRow[];
}

/** Everything the validator resolves names against — the organisation's ACTIVE taxonomy and awards. */
export interface ImportContext {
  /** Active Location name (lowercased) → id. A name absent here is unknown or retired. */
  locationsByName: ReadonlyMap<string, string>;
  /** Active Department name (lowercased) → id. */
  departmentsByName: ReadonlyMap<string, string>;
  /** Active Role, keyed by `departmentId|lowercased-role-name` → role id (R5: a Role belongs to a Department). */
  rolesByDeptAndName: ReadonlyMap<string, string>;
  /**
   * Competency name (lowercased) → id, over the organisation's REGISTER (R167,
   * amended — see `loadImportContext`). Every competency the org has created,
   * not only those some assessment tool awards. A name absent here does not
   * exist in the register, and the import creates nothing for it (R169).
   */
  competenciesByName: ReadonlyMap<string, string>;
  /** The placement offer-and-count rules — the SAME context the team screen validates against (R155). */
  placement: PlacementContext;
  /** Whether this tier carries candidate seats — a Candidate row is rejected otherwise (R167). */
  candidateSeatsAllowed: boolean;
  /**
   * Workforce numbers ALREADY issued in this organisation, lowercased (R7).
   *
   * Scoped per organisation because the same person may carry different numbers
   * for two customers, and lowercased to match the case-folded partial unique
   * indexes on the profile — a validator that compared case-sensitively would
   * pass a row the insert then rejects, which is the worst place to find out.
   * Omit or leave empty on an organisation that has issued none.
   */
  heldEmployeeNumbers?: ReadonlySet<string>;
  heldSwipeCardNumbers?: ReadonlySet<string>;
  /**
   * How to read a slash-separated `grant_date` cell — the organisation's
   * `dateFormat` setting. Required rather than defaulted here: guessing a
   * format silently is exactly the bug this field exists to close, so a
   * caller must say which convention applies. Does not affect an ISO
   * (`YYYY-MM-DD`) cell, which is unambiguous regardless.
   */
  dateFormat: 'dmy' | 'mdy';
}

/** Access-level label (any case) → the Role it names, e.g. "Assessor" → 'assessor'. */
const ROLE_BY_LABEL = new Map<string, Role>(
  (Object.entries(ROLE_LABELS) as [Role, string][]).map(([role, label]) => [label.toLowerCase(), role]),
);

/**
 * Build a UTC date from parts, rejecting anything that isn't a real calendar
 * date — `new Date(Date.UTC(...))` silently ROLLS an out-of-range day into
 * the next month (31 February becomes 2/3 March) rather than failing, so the
 * round-trip below is the actual validity check.
 */
function dateFromParts(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

/**
 * Read one date cell, or null when unreadable.
 *
 * TAKES AN ALREADY-TRIMMED, NON-EMPTY STRING. Blank is not this function's
 * question: blank and unreadable mean different things to a caller (R153,
 * reversed — blank is a valid "unknown", unreadable is a rejection) and
 * collapsing them here would lose that distinction. Shared by both
 * `grant_date` and `expiry_date`, which read the same way.
 *
 * TWO SHAPES ONLY — deliberately narrower than the free-form parse this
 * replaced. An ISO cell (`YYYY-MM-DD`) is unambiguous and always read that
 * way. A slash- or hyphen-separated numeric cell (`D/M/YYYY` or `M/D/YYYY`)
 * is ambiguous on its own — which of the first two numbers is the day is
 * exactly the question `dateFormat` answers, per the organisation's
 * convention. Anything else (a month name, a timestamp, free text) is
 * refused rather than guessed via `Date.parse`, which is the bug this
 * replaces: `Date.parse` reads a day-first date month-first whenever the day
 * is 12 or under, silently.
 */
function parseDateCell(trimmed: string, dateFormat: 'dmy' | 'mdy'): Date | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return dateFromParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const numeric = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (numeric) {
    const [, a, b, year] = numeric;
    const [day, month] = dateFormat === 'mdy' ? [Number(b), Number(a)] : [Number(a), Number(b)];
    return dateFromParts(Number(year), month, day);
  }

  return null;
}

/**
 * Validate every row against the rules the product would enforce on a screen,
 * before anything is written. Uniqueness is NOT a rejection (R148/R149) — a known
 * email validates and U24 merges it. Rejections are exhaustive and each carries
 * its reason (R170).
 */
export function validateWorkforceImport(parsed: ParsedImport, ctx: ImportContext): ValidatedImport {
  const validProfiles: ValidProfileRow[] = [];
  const rejected: RejectedRow[] = [];
  // Emails that resolved to a valid profile — a competency line must name one.
  const validEmails = new Set<string>();
  /*
    Numbers claimed so far: those already issued in the organisation, plus every
    one an earlier row in THIS file took. Accumulating as we go is what catches
    the same swipe card twice in one file — the likelier mistake than a clash
    with a number already on record, and one the database would only surface
    part-way through a run.
  */
  const claimedEmployee = new Set(ctx.heldEmployeeNumbers ?? []);
  const claimedSwipe = new Set(ctx.heldSwipeCardNumbers ?? []);

  for (const row of parsed.profiles) {
    const subject = row.name || row.email || `row ${row.rowNumber}`;
    const reject = (reason: ImportRejectionReason, detail?: string) =>
      rejected.push({ rowNumber: row.rowNumber, subject, reason, detail });

    if (!row.name) {
      reject('missing_name');
      continue;
    }
    if (!row.email) {
      reject('missing_email');
      continue;
    }
    if (!row.accessLevel) {
      reject('missing_access_level');
      continue;
    }
    const role = ROLE_BY_LABEL.get(row.accessLevel.toLowerCase());
    if (!role) {
      reject('unknown_access_level', row.accessLevel);
      continue;
    }
    if (role === 'candidate' && !ctx.candidateSeatsAllowed) {
      reject('candidate_not_allowed');
      continue;
    }
    if (row.locations.length === 0) {
      // At least one Location (R151/R168) — the precondition assignment reads.
      reject('missing_location');
      continue;
    }

    // Resolve Locations.
    const locationIds: string[] = [];
    let bad = false;
    for (const name of row.locations) {
      const id = ctx.locationsByName.get(name.toLowerCase());
      if (!id) {
        reject('unknown_location', name);
        bad = true;
        break;
      }
      locationIds.push(id);
    }
    if (bad) continue;

    // Resolve Departments.
    const departmentIds: string[] = [];
    for (const name of row.departments) {
      const id = ctx.departmentsByName.get(name.toLowerCase());
      if (!id) {
        reject('unknown_department', name);
        bad = true;
        break;
      }
      departmentIds.push(id);
    }
    if (bad) continue;

    // Resolve Roles — a Role belongs to a Department (R5), so it is looked up per
    // placed Department; a Role none of them offers is unknown/not offered.
    const roleIds: string[] = [];
    for (const name of row.roles) {
      let resolved: string | undefined;
      for (const departmentId of departmentIds) {
        const id = ctx.rolesByDeptAndName.get(`${departmentId}|${name.toLowerCase()}`);
        if (id) {
          resolved = id;
          break;
        }
      }
      if (!resolved) {
        reject('unknown_role', name);
        bad = true;
        break;
      }
      roleIds.push(resolved);
    }
    if (bad) continue;

    // The offer-and-count rules, from the ONE validator (R5, R6, R155).
    const placementResult = validatePlacement({ locationIds, departmentIds, roleIds }, ctx.placement);
    if (!placementResult.ok) {
      const code = placementResult.error.code;
      if (code === 'no_location') reject('missing_location');
      else if (code === 'unknown_role') reject('unknown_role', placementResult.error.subjectId);
      else if (code === 'role_not_offered') reject('role_not_offered', placementResult.error.subjectId);
      else reject('too_many_roles', placementResult.error.subjectId);
      continue;
    }

    /*
      R7's uniqueness, checked before the row is accepted. An absent number is
      not a clash — R12 leaves both optional indefinitely and R24 falls back
      rather than failing, so a file of people holding neither is ordinary.
    */
    const employee = row.employeeNumber.trim().toLowerCase();
    if (employee && claimedEmployee.has(employee)) {
      reject('duplicate_employee_number', row.employeeNumber.trim());
      continue;
    }
    const swipe = row.swipeCardNumber.trim().toLowerCase();
    if (swipe && claimedSwipe.has(swipe)) {
      reject('duplicate_swipe_card_number', row.swipeCardNumber.trim());
      continue;
    }
    if (employee) claimedEmployee.add(employee);
    if (swipe) claimedSwipe.add(swipe);

    /*
      The date of birth, normalised to ISO before it goes any further. Blank
      stays blank and lands flagged; unreadable is the operator's typo and is
      worth showing rather than swallowing.
    */
    let dateOfBirth = '';
    const dobRaw = row.dateOfBirth.trim();
    if (dobRaw) {
      const parsed = parseDateCell(dobRaw, ctx.dateFormat);
      if (!parsed) {
        reject('bad_date_of_birth', dobRaw);
        continue;
      }
      dateOfBirth = parsed.toISOString().slice(0, 10);
    }

    validEmails.add(row.email.toLowerCase());
    validProfiles.push({
      rowNumber: row.rowNumber,
      name: row.name,
      email: row.email,
      role,
      locationIds,
      departmentIds,
      roleIds,
      employeeNumber: row.employeeNumber,
      swipeCardNumber: row.swipeCardNumber,
      middleName: row.middleName.trim(),
      dateOfBirth,
      gender: row.gender.trim(),
      ethnicity: row.ethnicity.trim(),
      addressStreet: row.addressStreet.trim(),
      suburb: row.suburb.trim(),
      postcode: row.postcode.trim(),
      mobile: row.mobile.trim(),
      emergencyContactName: row.emergencyContactName.trim(),
      emergencyContactPhone: row.emergencyContactPhone.trim(),
      starterType: row.starterType.trim(),
    });
  }

  // Competency lines — the competency must EXIST in the organisation's register
  // (R167, amended: it was "one a tool awards" — see `loadImportContext` for why
  // that half was dropped) and the grant date must read (R167).
  //
  // A line whose email matches a profile row that was itself REJECTED is dropped
  // silently: that profile's own rejection already tells the Admin what to fix,
  // and repeating it against the competency line would be noise. But a line
  // naming an address NO profile row in the file carries is a typo naming
  // nobody — dropping it silently would lose a grant with no trace, so it is a
  // named rejection (R170).
  const profileEmails = new Set(parsed.profiles.map((p) => p.email.toLowerCase()));
  const validCompetencies: ValidCompetencyRow[] = [];
  for (const row of parsed.competencies) {
    const subject = row.email || `row ${row.rowNumber}`;
    const key = row.email.toLowerCase();
    if (!validEmails.has(key)) {
      if (!profileEmails.has(key)) {
        rejected.push({ rowNumber: row.rowNumber, subject, reason: 'unknown_profile_email', detail: row.email });
      }
      continue;
    }
    const competencyId = ctx.competenciesByName.get(row.competency.trim().toLowerCase());
    if (!competencyId) {
      rejected.push({ rowNumber: row.rowNumber, subject, reason: 'unknown_competency', detail: row.competency });
      continue;
    }

    /*
      BLANK IS "UNKNOWN", NOT A REJECTION (R153, reversed). A source system
      that never recorded a grant date is exactly the case this line exists
      for — awarding nothing until someone backfills a date it may never get
      would lose the person's real qualification history. Only a PRESENT but
      unreadable date is a rejection: that is a typo to fix, not an absence.
    */
    const grantDateRaw = row.grantDate.trim();
    let grantedAt: Date | null = null;
    if (grantDateRaw) {
      grantedAt = parseDateCell(grantDateRaw, ctx.dateFormat);
      if (!grantedAt) {
        rejected.push({ rowNumber: row.rowNumber, subject, reason: 'bad_grant_date', detail: row.grantDate });
        continue;
      }
    }

    // Same treatment for the explicit override — blank means "derive it
    // instead", never a rejection. Read by the organisation's own convention
    // too: a day-first expiry must not be misread any more than a grant date.
    const expiryDateRaw = row.expiryDate.trim();
    let expiresAt: Date | null = null;
    if (expiryDateRaw) {
      expiresAt = parseDateCell(expiryDateRaw, ctx.dateFormat);
      if (!expiresAt) {
        rejected.push({ rowNumber: row.rowNumber, subject, reason: 'bad_expiry_date', detail: row.expiryDate });
        continue;
      }
    }

    validCompetencies.push({
      rowNumber: row.rowNumber,
      email: row.email,
      competencyId,
      grantedAt,
      expiresAt,
      evidence: row.evidence,
    });
  }

  return { validProfiles, validCompetencies, rejected };
}
