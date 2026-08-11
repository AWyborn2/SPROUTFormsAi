import { describe, expect, it } from 'vitest';
import type { Db } from '@formai/db';
import {
  formatCompetencySeedReport,
  parseCompetencySeedCsv,
  seedCompetencies,
  type CompetencySeedRow,
} from './competency-seed.js';

const ORG = 'org-1';

interface FakeCompetency {
  id: string;
  orgId: string;
  name: string;
  code: string | null;
  holders: number;
  validForMonths: number | null;
  gracePeriodDays: number | null;
}

/**
 * A db double over exactly what the seeder touches: the org lookup, the one
 * read of the register, and the insert. The API suite has no live database, so
 * each lib test shapes its own fixture.
 *
 * The insert appends to the same array the register read returns, so a second
 * `seedCompetencies` call against the same double sees what the first wrote —
 * which is what re-running the seeder actually looks like.
 */
function fakeDb(opts: { orgs?: string[]; competencies?: Partial<FakeCompetency>[] }) {
  const orgs = opts.orgs ?? [ORG];
  const rows: FakeCompetency[] = (opts.competencies ?? []).map((c, i) => ({
    id: c.id ?? `c-${i}`,
    orgId: c.orgId ?? ORG,
    name: c.name ?? '',
    code: c.code ?? null,
    holders: c.holders ?? 0,
    validForMonths: c.validForMonths ?? null,
    gracePeriodDays: c.gracePeriodDays ?? null,
  }));

  const db = {
    query: {
      organizations: {
        findFirst: async () => orgs.filter((o) => o === capturedOrgId).map((id) => ({ id }))[0],
      },
      competencies: {
        findMany: async () => rows.filter((r) => r.orgId === capturedOrgId),
      },
    },
    insert: () => ({
      values: (v: Omit<FakeCompetency, 'id'>) => ({
        returning: async () => {
          const row: FakeCompetency = { id: `c-${rows.length}`, ...v };
          rows.push(row);
          return [row];
        },
      }),
    }),
  } as unknown as Db;

  // The double cannot read drizzle's predicate, so the org filter is applied
  // from the id the test seeded with — enough to distinguish "org exists" from
  // "org does not" and to keep another org's rows out of the register read.
  let capturedOrgId = ORG;
  const useOrg = (id: string) => {
    capturedOrgId = id;
  };
  return { db, rows, useOrg };
}

const row = (over: Partial<CompetencySeedRow> = {}): CompetencySeedRow => ({
  rowNumber: 1,
  name: 'Working at Heights',
  code: 'WAH',
  validForMonths: 24,
  ...over,
});

describe('parseCompetencySeedCsv', () => {
  it('reads columns by name and carries a blank validity as null', () => {
    const { rows, errors } = parseCompetencySeedCsv(
      ['code,name,valid_for_months', 'WAH,Working at Heights,24', 'FA,First Aid,'].join('\n'),
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { rowNumber: 2, name: 'Working at Heights', code: 'WAH', validForMonths: 24 },
      { rowNumber: 3, name: 'First Aid', code: 'FA', validForMonths: null },
    ]);
  });

  it('honours quoted fields, blank lines and comments', () => {
    const { rows } = parseCompetencySeedCsv(
      ['# curated 2026-08-11', 'name,code,valid_for_months', '"Dogging, Basic",DG,60', '', ''].join('\n'),
    );
    expect(rows).toEqual([{ rowNumber: 3, name: 'Dogging, Basic', code: 'DG', validForMonths: 60 }]);
  });

  it('reports a non-numeric validity rather than coercing it', () => {
    const { rows, errors } = parseCompetencySeedCsv(
      ['name,code,valid_for_months', 'First Aid,FA,three years'].join('\n'),
    );
    expect(rows).toEqual([]);
    expect(errors[0]?.rowNumber).toBe(2);
    expect(errors[0]?.error).toContain('not a number');
  });

  it('reads a blank code cell as a blank code rather than an error', () => {
    const { rows, errors } = parseCompetencySeedCsv(
      ['name,code,valid_for_months', 'Contractor Endorsement Form,,'].join('\n'),
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { rowNumber: 2, name: 'Contractor Endorsement Form', code: '', validForMonths: null },
    ]);
  });

  it('refuses a header that does not name name and code', () => {
    const { errors } = parseCompetencySeedCsv(['ticket,months', 'First Aid,12'].join('\n'));
    expect(errors[0]?.error).toContain('header');
  });
});

describe('seedCompetencies', () => {
  it('creates every competency in the list, in the org it was given', async () => {
    const { db, rows } = fakeDb({ competencies: [] });
    const report = await seedCompetencies(db, {
      orgId: ORG,
      rows: [row(), row({ rowNumber: 2, name: 'First Aid', code: 'FA', validForMonths: 36 })],
    });

    expect(report.created.map((c) => c.name)).toEqual(['Working at Heights', 'First Aid']);
    expect(report.skipped).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(rows.map((r) => [r.orgId, r.name, r.code, r.validForMonths])).toEqual([
      [ORG, 'Working at Heights', 'WAH', 24],
      [ORG, 'First Aid', 'FA', 36],
    ]);
  });

  it('skips an existing name case-insensitively and leaves the row untouched', async () => {
    const { db, rows } = fakeDb({
      competencies: [{ name: 'working at HEIGHTS', code: 'CURATED-1', validForMonths: 12 }],
    });
    const report = await seedCompetencies(db, { orgId: ORG, rows: [row()] });

    expect(report.created).toEqual([]);
    expect(report.skipped).toEqual([
      { name: 'Working at Heights', existingCode: 'CURATED-1', reason: 'already_exists' },
    ]);
    // The curated code and validity survive — a re-run must not overwrite what
    // someone already reviewed.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: 'CURATED-1', validForMonths: 12 });
  });

  it('is idempotent: a second run of the same list creates nothing', async () => {
    const { db, rows } = fakeDb({ competencies: [] });
    const list = [row(), row({ rowNumber: 2, name: 'First Aid', code: 'FA', validForMonths: null })];

    const first = await seedCompetencies(db, { orgId: ORG, rows: list });
    const second = await seedCompetencies(db, { orgId: ORG, rows: list });

    expect(first.created).toHaveLength(2);
    expect(second.created).toEqual([]);
    expect(second.skipped.map((s) => s.reason)).toEqual(['already_exists', 'already_exists']);
    expect(rows).toHaveLength(2);
  });

  it('creates a repeated name once within a single run', async () => {
    const { db, rows } = fakeDb({ competencies: [] });
    const report = await seedCompetencies(db, {
      orgId: ORG,
      rows: [row(), row({ rowNumber: 2, name: 'working at heights', code: 'WAH-2' })],
    });
    expect(report.created).toHaveLength(1);
    expect(report.skipped[0]?.reason).toBe('duplicate_in_file');
    expect(rows).toHaveLength(1);
  });

  it('stores a blank validity as NEVER EXPIRES (null), not zero', async () => {
    const { db, rows } = fakeDb({ competencies: [] });
    const report = await seedCompetencies(db, {
      orgId: ORG,
      rows: [row({ name: 'Site Induction', code: 'SI', validForMonths: null })],
    });

    expect(report.created[0]?.validForMonths).toBeNull();
    expect(rows[0]?.validForMonths).toBeNull();
    expect(rows[0]?.validForMonths).not.toBe(0);
    // Grace period follows the same rule — unset, not zeroed.
    expect(rows[0]?.gracePeriodDays).toBeNull();
  });

  it('refuses a zero validity rather than storing an instantly-expiring row', async () => {
    const { db, rows } = fakeDb({ competencies: [] });
    const report = await seedCompetencies(db, {
      orgId: ORG,
      rows: [row({ name: 'Site Induction', code: 'SI', validForMonths: 0 })],
    });
    expect(report.created).toEqual([]);
    expect(report.failed[0]?.name).toBe('Site Induction');
    expect(rows).toEqual([]);
  });

  it('reports a row the API route itself would reject, and writes nothing for it', async () => {
    const { db, rows } = fakeDb({ competencies: [] });
    const report = await seedCompetencies(db, {
      orgId: ORG,
      rows: [
        row({ rowNumber: 2, name: '', code: 'X' }),
        row({ rowNumber: 3, name: 'Overlong', code: 'OL', validForMonths: 9000 }),
        row({ rowNumber: 4, name: 'Fine', code: 'F', validForMonths: 12 }),
      ],
    });

    expect(report.created.map((c) => c.name)).toEqual(['Fine']);
    expect(report.failed.map((f) => f.rowNumber)).toEqual([2, 3]);
    expect(rows.map((r) => r.name)).toEqual(['Fine']);
  });

  it('seeds a competency whose code column is blank, storing NULL rather than failing the row', async () => {
    /*
      Five of the 65 competencies in the first real migration are internal —
      a contractor endorsement form, an in-house PAPR maintenance induction —
      and have never had a nationally-recognised code. The loader used to reject
      them with "code: String must contain at least 1 character(s)", and the only
      way through was to invent codes. A fabricated code is wrong permanently
      and against a system that will never resolve it, so the blank cell is the
      truthful answer and NULL is how it is stored.
    */
    const { db, rows } = fakeDb({ competencies: [] });
    const report = await seedCompetencies(db, {
      orgId: ORG,
      rows: [
        row({ name: 'Contractor Endorsement Form', code: '', validForMonths: null }),
        row({ rowNumber: 2, name: 'Dieback Management', code: '   ', validForMonths: null }),
      ],
    });

    expect(report.failed).toEqual([]);
    expect(report.created.map((c) => c.code)).toEqual([null, null]);
    // NULL and not '' — one spelling of "no code" in the register, so no reader
    // has to know both.
    expect(rows.map((r) => [r.name, r.code])).toEqual([
      ['Contractor Endorsement Form', null],
      ['Dieback Management', null],
    ]);
  });

  it('still stores a code exactly as given when the row has one', async () => {
    // A code stays strongly preferred: nothing about it is weakened by the
    // blank cell now being allowed.
    const { db, rows } = fakeDb({ competencies: [] });
    const report = await seedCompetencies(db, {
      orgId: ORG,
      rows: [row({ name: 'Working at Heights', code: 'RIIWHS204E', validForMonths: 24 })],
    });
    expect(report.failed).toEqual([]);
    expect(rows.map((r) => r.code)).toEqual(['RIIWHS204E']);
  });

  it('refuses a missing org rather than defaulting to one', async () => {
    const { db } = fakeDb({ competencies: [] });
    await expect(seedCompetencies(db, { orgId: '', rows: [row()] })).rejects.toThrow('org_required');
    await expect(seedCompetencies(db, { orgId: '   ', rows: [row()] })).rejects.toThrow('org_required');
  });

  it('refuses an org that does not exist', async () => {
    const { db, useOrg } = fakeDb({ orgs: [ORG], competencies: [] });
    useOrg('org-nope');
    await expect(seedCompetencies(db, { orgId: 'org-nope', rows: [row()] })).rejects.toThrow(
      'org_not_found',
    );
  });

  it('writes nothing on a dry run but reports what it would create', async () => {
    const { db, rows } = fakeDb({ competencies: [] });
    const report = await seedCompetencies(db, { orgId: ORG, rows: [row()], dryRun: true });
    expect(report.created.map((c) => c.name)).toEqual(['Working at Heights']);
    expect(rows).toEqual([]);
    expect(formatCompetencySeedReport(report)).toContain('[dry-run] would create');
  });
});

describe('formatCompetencySeedReport', () => {
  it('names every created, skipped and failed row so a human can check the source list', async () => {
    const { db } = fakeDb({ competencies: [{ name: 'First Aid', code: 'FA-OLD' }] });
    const report = await seedCompetencies(db, {
      orgId: ORG,
      rows: [
        row(),
        row({ rowNumber: 2, name: 'First Aid', code: 'FA' }),
        row({ rowNumber: 3, name: '', code: 'NO-NAME', validForMonths: null }),
      ],
    });
    const text = formatCompetencySeedReport(report);

    expect(text).toContain('Working at Heights (WAH) — 24 months');
    expect(text).toContain('First Aid — already exists as FA-OLD, left unchanged');
    expect(text).toContain('row 3');
  });

  it('writes "no code" rather than an empty pair of brackets for a codeless competency', async () => {
    /*
      The report is what a human reads to check a migration landed. A line
      reading "Contractor Endorsement Form () — never expires" looks like a
      truncation bug; "(no code)" states the fact deliberately.
    */
    const { db } = fakeDb({ competencies: [] });
    const report = await seedCompetencies(db, {
      orgId: ORG,
      rows: [row({ name: 'Contractor Endorsement Form', code: '', validForMonths: null })],
    });
    expect(formatCompetencySeedReport(report)).toContain(
      'Contractor Endorsement Form (no code) — never expires',
    );
  });

  it('says never expires for a null validity', async () => {
    const { db } = fakeDb({ competencies: [] });
    const report = await seedCompetencies(db, {
      orgId: ORG,
      rows: [row({ name: 'Site Induction', code: 'SI', validForMonths: null })],
    });
    expect(formatCompetencySeedReport(report)).toContain('Site Induction (SI) — never expires');
  });
});
