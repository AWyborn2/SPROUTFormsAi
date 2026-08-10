import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';
import type { ValidCompetencyRow, ValidProfileRow } from '@formai/shared';

/*
  The row landing, the competency grant and the assignment each have their own
  suite. These cover what THIS module owns: the ordering within a row, the
  outcome each of R149's three cases produces, and a report derived from the
  rows rather than tallied beside them.
*/
const mocks = vi.hoisted(() => ({
  landImportRow: vi.fn(),
  resolveRows: vi.fn(),
  grantCompetency: vi.fn(async () => ({ ok: true, outcome: { competencyId: 'c-1', code: 'x', created: true, holders: 1 } })),
  assignForMembership: vi.fn(async () => ({ createdCaseIds: ['case-1'] })),
  recordAudit: vi.fn(async () => undefined),
}));
vi.mock('./member-create.js', () => ({
  landImportRow: mocks.landImportRow,
  resolveRows: mocks.resolveRows,
}));
vi.mock('./competency-grant.js', () => ({ grantCompetency: mocks.grantCompetency }));
vi.mock('./assignment.js', () => ({ assignForMembership: mocks.assignForMembership }));
vi.mock('../audit/record.js', () => ({ recordAudit: mocks.recordAudit }));

const { executeImportRun, readRunReport } = await import('./workforce-import-run.js');

const TENANT = { userId: 'u-admin', orgId: 'org-1', role: 'admin' as const };

const row = (over: Partial<ValidProfileRow> = {}): ValidProfileRow => ({
  rowNumber: 2,
  name: 'Jane Smith',
  email: 'jane@x.io',
  role: 'candidate',
  locationIds: ['loc-1'],
  departmentIds: ['dep-1'],
  roleIds: ['jr-1'],
  employeeNumber: '',
  swipeCardNumber: '',
  ...over,
});

const line = (over: Partial<ValidCompetencyRow> = {}): ValidCompetencyRow => ({
  rowNumber: 2,
  email: 'jane@x.io',
  competencyId: 'c-1',
  grantedAt: new Date('2022-03-01T00:00:00Z'),
  evidence: 'cert-1',
  ...over,
});

/** Records every import_run_rows insert, which is what the report reads back. */
function fakeDb() {
  const runRows: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    query: {
      importRuns: {
        findFirst: vi.fn(async () => ({
          id: 'run-1',
          orgId: 'org-1',
          startedAt: new Date('2026-08-10T00:00:00Z'),
          completedAt: new Date('2026-08-10T00:01:00Z'),
          rowsTotal: runRows.length,
        })),
      },
      importRunRows: { findMany: vi.fn(async () => runRows) },
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        /*
          The two inserts are told apart by their SHAPE rather than their table,
          because the run insert awaits `.returning()` for its id and the row
          inserts are awaited directly — a double returning one shape for both
          would break whichever it did not match. `rowNumber` is on every row
          and on no run.
        */
        if ('rowNumber' in v) {
          runRows.push({
            flagged: [],
            differences: [],
            competenciesRecorded: 0,
            competenciesSkipped: 0,
            assessmentsAssigned: 0,
            seatPool: null,
            ...v,
          });
          return Promise.resolve(undefined) as never;
        }
        return {
          returning: async () => [{ id: 'run-1', ...v }],
        } as never;
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => void updates.push(v),
      }),
    }),
  };
  return { db: db as unknown as Db, runRows, updates };
}

describe('executeImportRun — the three cases of R149', () => {
  it('CREATES where the address names nobody, and costs a seat', async () => {
    const { db, runRows } = fakeDb();
    mocks.resolveRows.mockResolvedValue([
      { row: row(), disposition: 'create', userId: null, membershipId: null, pool: 'candidate' },
    ]);
    mocks.landImportRow.mockResolvedValue({
      kind: 'created',
      userId: 'u-1',
      membershipId: 'm-1',
      incomplete: [],
    });

    await executeImportRun(db, TENANT, { validProfiles: [row()], validCompetencies: [], rejected: [] });

    expect(runRows).toHaveLength(1);
    expect(runRows[0]).toMatchObject({ outcome: 'created', seatPool: 'candidate', userId: 'u-1' });
  });

  it('MERGES onto an already-active membership, costing no seat and writing no difference', async () => {
    /*
      The case a real customer's file hits most, because the assessors being
      migrated are the population most likely to already hold logins. A merge
      must cost nothing and must REPORT what differs rather than writing it —
      an import must not be able to demote an administrator to a candidate on
      the strength of a column.
    */
    const { db, runRows } = fakeDb();
    mocks.resolveRows.mockResolvedValue([
      { row: row(), disposition: 'merge', userId: 'u-1', membershipId: 'm-1', pool: null },
    ]);
    mocks.landImportRow.mockResolvedValue({
      kind: 'merged',
      userId: 'u-1',
      membershipId: 'm-1',
      differences: [{ field: 'accessLevel', existing: 'admin', fromFile: 'candidate' }],
    });

    await executeImportRun(db, TENANT, { validProfiles: [row()], validCompetencies: [], rejected: [] });

    expect(runRows[0]).toMatchObject({ outcome: 'merged', seatPool: null });
    expect(runRows[0]!.differences).toEqual([
      { field: 'accessLevel', existing: 'admin', fromFile: 'candidate' },
    ]);
  });

  it('REACTIVATES a deactivated membership, and that costs a seat like any other', async () => {
    const { db, runRows } = fakeDb();
    mocks.resolveRows.mockResolvedValue([
      { row: row(), disposition: 'reactivate', userId: 'u-1', membershipId: 'm-1', pool: 'candidate' },
    ]);
    mocks.landImportRow.mockResolvedValue({
      kind: 'reactivated',
      userId: 'u-1',
      membershipId: 'm-1',
      incomplete: [],
    });

    await executeImportRun(db, TENANT, { validProfiles: [row()], validCompetencies: [], rejected: [] });

    expect(runRows[0]).toMatchObject({ outcome: 'reactivated', seatPool: 'candidate' });
  });
});

describe('executeImportRun — ordering and refusals', () => {
  it('records competencies BEFORE assigning, so assignment skips what they hold (R163)', async () => {
    /*
      The whole reason the order is fixed. Assigning first would hand a migrated
      workforce an assessment for every ticket they have held for years.
    */
    const { db } = fakeDb();
    const order: string[] = [];
    mocks.resolveRows.mockResolvedValue([
      { row: row(), disposition: 'create', userId: null, membershipId: null, pool: 'candidate' },
    ]);
    mocks.landImportRow.mockImplementation(async () => {
      order.push('land');
      return { kind: 'created', userId: 'u-1', membershipId: 'm-1', incomplete: [] };
    });
    mocks.grantCompetency.mockImplementation(async () => {
      order.push('grant');
      return { ok: true, outcome: { competencyId: 'c-1', code: 'x', created: true, holders: 1 } };
    });
    mocks.assignForMembership.mockImplementation(async () => {
      order.push('assign');
      return { createdCaseIds: [] };
    });

    await executeImportRun(db, TENANT, {
      validProfiles: [row()],
      validCompetencies: [line()],
      rejected: [],
    });

    expect(order).toEqual(['land', 'grant', 'assign']);
  });

  it('keeps the file’s grant date, never the run date (R156, R158)', async () => {
    // A four-year-old ticket dated to today would read as current when it is
    // not — the failure this whole path exists to avoid.
    const { db, updates } = fakeDb();
    mocks.resolveRows.mockResolvedValue([
      { row: row(), disposition: 'create', userId: null, membershipId: null, pool: 'candidate' },
    ]);
    mocks.landImportRow.mockResolvedValue({
      kind: 'created',
      userId: 'u-1',
      membershipId: 'm-1',
      incomplete: [],
    });
    mocks.grantCompetency.mockResolvedValue({
      ok: true,
      outcome: { competencyId: 'c-1', code: 'x', created: true, holders: 1 },
    });

    await executeImportRun(
      db,
      TENANT,
      { validProfiles: [row()], validCompetencies: [line()], rejected: [] },
      new Date('2026-08-10T00:00:00Z'),
    );

    const dated = updates.find((u) => 'grantedAt' in u);
    expect(dated!.grantedAt).toEqual(new Date('2022-03-01T00:00:00Z'));
    // `importedAt` is what marks it migrated, which waives the certificate it
    // has no scan of (R162).
    expect(dated!.importedAt).toEqual(new Date('2026-08-10T00:00:00Z'));
  });

  it('awards nothing for a line with no readable date, and counts it skipped (R153)', async () => {
    const { db, runRows } = fakeDb();
    mocks.resolveRows.mockResolvedValue([
      { row: row(), disposition: 'create', userId: null, membershipId: null, pool: 'candidate' },
    ]);
    mocks.landImportRow.mockResolvedValue({
      kind: 'created',
      userId: 'u-1',
      membershipId: 'm-1',
      incomplete: [],
    });
    mocks.grantCompetency.mockClear();

    await executeImportRun(db, TENANT, {
      validProfiles: [row()],
      validCompetencies: [line({ grantedAt: new Date('nonsense') })],
      rejected: [],
    });

    expect(mocks.grantCompetency).not.toHaveBeenCalled();
    expect(runRows[0]).toMatchObject({ competenciesRecorded: 0, competenciesSkipped: 1 });
  });

  it('records a full pool as a rejected row and CONTINUES the run (R143, R170)', async () => {
    const { db, runRows } = fakeDb();
    mocks.resolveRows.mockResolvedValue([
      { row: row(), disposition: 'create', userId: null, membershipId: null, pool: 'candidate' },
      { row: row({ rowNumber: 3, email: 'b@x.io' }), disposition: 'create', userId: null, membershipId: null, pool: 'candidate' },
    ]);
    mocks.landImportRow
      .mockResolvedValueOnce({ kind: 'refused', reason: 'seat_limit_reached', pool: 'candidate' })
      .mockResolvedValueOnce({ kind: 'created', userId: 'u-2', membershipId: 'm-2', incomplete: [] });

    await executeImportRun(db, TENANT, {
      validProfiles: [row(), row({ rowNumber: 3, email: 'b@x.io' })],
      validCompetencies: [],
      rejected: [],
    });

    expect(runRows[0]).toMatchObject({ outcome: 'rejected', reason: 'seat_limit_reached', detail: 'candidate' });
    // The neighbour still landed — one bad row does not fail the file.
    expect(runRows[1]).toMatchObject({ outcome: 'created' });
  });

  it('records the VALIDATOR’s rejections too, so one report holds every row', async () => {
    // An Admin correcting the source needs both kinds in one place; a report
    // showing only run-time refusals would send them looking for the rest.
    const { db, runRows } = fakeDb();
    mocks.resolveRows.mockResolvedValue([]);

    await executeImportRun(db, TENANT, {
      validProfiles: [],
      validCompetencies: [],
      rejected: [{ rowNumber: 5, subject: 'Bad Row', reason: 'unknown_location', detail: 'Nowhere' }],
    });

    expect(runRows).toHaveLength(1);
    expect(runRows[0]).toMatchObject({
      outcome: 'rejected',
      reason: 'unknown_location',
      detail: 'Nowhere',
      rowNumber: 5,
    });
  });
});

describe('readRunReport — derived, never tallied', () => {
  it('counts every figure R171 names from the rows themselves', async () => {
    /*
      Derived rather than stored beside the run, because a tally and the rows it
      counts can disagree — and the rows are what an Admin acts on anyway.
    */
    const { db, runRows } = fakeDb();
    runRows.push(
      { rowNumber: 2, subject: 'A', outcome: 'created', seatPool: 'candidate', flagged: ['mobile'], differences: [], competenciesRecorded: 2, competenciesSkipped: 1, assessmentsAssigned: 1 },
      { rowNumber: 3, subject: 'B', outcome: 'merged', seatPool: null, flagged: [], differences: [{ field: 'roles', existing: 'x', fromFile: 'y' }], competenciesRecorded: 0, competenciesSkipped: 0, assessmentsAssigned: 0 },
      { rowNumber: 4, subject: 'C', outcome: 'reactivated', seatPool: 'staff', flagged: [], differences: [], competenciesRecorded: 1, competenciesSkipped: 0, assessmentsAssigned: 2 },
      { rowNumber: 5, subject: 'D', outcome: 'rejected', reason: 'unknown_location', detail: 'Nowhere', flagged: [], differences: [], competenciesRecorded: 0, competenciesSkipped: 0, assessmentsAssigned: 0 },
    );

    const report = (await readRunReport(db, 'org-1', 'run-1'))!;

    expect(report).toMatchObject({
      profilesCreated: 1,
      peopleMerged: 1,
      membershipsReactivated: 1,
      candidateSeats: 1,
      staffSeats: 1,
      competenciesRecorded: 3,
      linesFlaggedNoDate: 1,
      assessmentsAssigned: 3,
      profilesFlaggedIncomplete: 1,
      differencesReported: 1,
    });
    expect(report.rejected).toEqual([
      { rowNumber: 5, subject: 'D', reason: 'unknown_location', detail: 'Nowhere' },
    ]);
    expect(report.flagged).toEqual([{ rowNumber: 2, subject: 'A', missing: ['mobile'] }]);
  });

  it('reads as absent for a run belonging to another organisation', async () => {
    // Not-found rather than forbidden: a probe learns nothing about another
    // tenant's runs.
    const { db } = fakeDb();
    expect(await readRunReport(db, 'org-other', 'run-1')).toBeNull();
  });
});
