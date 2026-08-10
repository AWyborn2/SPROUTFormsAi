/**
 * Bulk workforce import — the template, the parser and the row validator (U23,
 * KTD13). PURE: no database, no clock. The seat-cost preview and the run both
 * read these, so they cannot disagree about what a file says or which rows it
 * rejects.
 *
 * ONE FILE, TWO SECTIONS (KTD13). A `#profiles` block carries one row per person
 * with the Access level they land with and their placement by NAME; a
 * `#competencies` block carries one line per competency with its grant date. The
 * import references taxonomy by name because that is what a human fills in, and
 * the validator resolves each name against the organisation's ACTIVE taxonomy —
 * it creates nothing (R169).
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
  'name,email,access_level,locations,departments,roles,employee_number,swipe_card_number',
  '',
  '#competencies',
  'email,competency,grant_date,evidence',
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
}

export interface RawCompetencyRow {
  rowNumber: number;
  email: string;
  competency: string;
  grantDate: string;
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
 */
export function parseWorkforceCsv(text: string): ParsedImport {
  const profiles: RawProfileRow[] = [];
  const competencies: RawCompetencyRow[] = [];
  let section: 'none' | 'profiles' | 'competencies' = 'none';

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
    if (section === 'profiles' && line.toLowerCase().startsWith('name,')) continue;
    if (section === 'competencies' && line.toLowerCase().startsWith('email,')) continue;

    const f = splitCsvLine(raw);
    if (section === 'profiles') {
      profiles.push({
        rowNumber,
        name: f[0] ?? '',
        email: f[1] ?? '',
        accessLevel: f[2] ?? '',
        locations: multi(f[3] ?? ''),
        departments: multi(f[4] ?? ''),
        roles: multi(f[5] ?? ''),
        employeeNumber: f[6] ?? '',
        swipeCardNumber: f[7] ?? '',
      });
    } else if (section === 'competencies') {
      competencies.push({
        rowNumber,
        email: f[0] ?? '',
        competency: f[1] ?? '',
        grantDate: f[2] ?? '',
        evidence: f[3] ?? '',
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
  | 'bad_grant_date'
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
}

/** A competency line that passed, with the competency resolved and the date parsed. */
export interface ValidCompetencyRow {
  rowNumber: number;
  email: string;
  competencyId: string;
  grantedAt: Date;
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
  /** Active competency name (lowercased) → id, for competencies SOME tool awards (R167). */
  awardedCompetenciesByName: ReadonlyMap<string, string>;
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
 * Read a grant date, or null when unreadable.
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
function parseGrantDate(value: string, dateFormat: 'dmy' | 'mdy'): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

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
    });
  }

  // Competency lines — the competency must be one a tool awards (R167) and the
  // grant date must read (R167).
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
    const competencyId = ctx.awardedCompetenciesByName.get(row.competency.trim().toLowerCase());
    if (!competencyId) {
      rejected.push({ rowNumber: row.rowNumber, subject, reason: 'unknown_competency', detail: row.competency });
      continue;
    }
    const grantedAt = parseGrantDate(row.grantDate, ctx.dateFormat);
    if (!grantedAt) {
      rejected.push({ rowNumber: row.rowNumber, subject, reason: 'bad_grant_date', detail: row.grantDate });
      continue;
    }
    validCompetencies.push({
      rowNumber: row.rowNumber,
      email: row.email,
      competencyId,
      grantedAt,
      evidence: row.evidence,
    });
  }

  return { validProfiles, validCompetencies, rejected };
}
