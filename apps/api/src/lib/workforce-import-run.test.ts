import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const {
  RUN_STALE_AFTER_MS,
  executeImportRun,
  readActiveRunReport,
  readRunReport,
  reapAbandonedRuns,
  startImportRun,
} = await import('./workforce-import-run.js');

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
  middleName: '',
  dateOfBirth: '',
  gender: '',
  ethnicity: '',
  addressStreet: '',
  suburb: '',
  postcode: '',
  mobile: '',
  emergencyContactName: '',
  emergencyContactPhone: '',
  starterType: '',
  ...over,
});

const line = (over: Partial<ValidCompetencyRow> = {}): ValidCompetencyRow => ({
  rowNumber: 2,
  email: 'jane@x.io',
  competencyId: 'c-1',
  grantedAt: new Date('2022-03-01T00:00:00Z'),
  expiresAt: null,
  evidence: 'cert-1',
  ...over,
});

/**
 * Records every import_run_rows insert, which is what the report reads back.
 *
 * It also models the ONE `import_runs` row a run owns, because the run's own
 * state — running, completed, failed, and the heartbeat behind them — is now
 * half of what this module does. `run` starts as the completed record the
 * report tests read; a claim overwrites it, exactly as an insert would.
 */
function fakeDb(
  opts: {
    /** Seed the organisation's existing run, e.g. one already in flight. */
    run?: Record<string, unknown> | null;
    /** Make the insert breach the partial unique index, as a lost race does. */
    conflictOnInsert?: boolean;
  } = {},
) {
  const runRows: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  let run: Record<string, unknown> | null =
    opts.run === undefined
      ? {
          id: 'run-1',
          orgId: 'org-1',
          startedAt: new Date('2026-08-10T00:00:00Z'),
          completedAt: new Date('2026-08-10T00:01:00Z'),
          status: 'completed',
          heartbeatAt: new Date('2026-08-10T00:01:00Z'),
          failureReason: null,
          rowsTotal: 0,
        }
      : opts.run;

  const db = {
    query: {
      importRuns: {
        findFirst: vi.fn(async () =>
          run ? { ...run, rowsTotal: (run.rowsTotal as number) || runRows.length } : undefined,
        ),
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
            competenciesUndated: 0,
            assessmentsAssigned: 0,
            seatPool: null,
            ...v,
          });
          return Promise.resolve(undefined) as never;
        }
        return {
          returning: async () => {
            if (opts.conflictOnInsert) {
              // Exactly what Postgres raises when the other request won the
              // race: 23505 naming the partial unique index.
              throw Object.assign(new Error('duplicate key'), {
                code: '23505',
                constraint: 'import_runs_one_active_per_org',
              });
            }
            run = { id: 'run-1', startedAt: new Date('2026-08-10T00:00:00Z'), ...v };
            return [run];
          },
        } as never;
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          /*
            THE ONE PREDICATE THIS DOUBLE HAS TO HONOUR. The reaper's real WHERE
            matches only a run that is still `running` AND whose heartbeat has
            gone stale; a double that applied it unconditionally would mark
            every healthy run failed, and the staleness tests would then pass
            against a reaper that never checked anything.

            An UPDATE matching no row is also recorded as nothing, which matters
            here: the reaper runs before every claim, and a double that logged
            its no-op would put a spurious `failed` in front of the real one.
          */
          if (v.failureReason === 'abandoned') {
            if (!run || run.status !== 'running') return;
            const at = (v.completedAt as Date).getTime();
            if ((run.heartbeatAt as Date).getTime() > at - RUN_STALE_AFTER_MS) return;
          }
          updates.push(v);
          // Only run-shaped updates land on the run; the competency-holder
          // updates that share this stub carry none of these keys.
          if (run && ('status' in v || 'heartbeatAt' in v || 'completedAt' in v)) {
            run = { ...run, ...v };
          }
        },
      }),
    }),
  };
  return {
    db: db as unknown as Db,
    runRows,
    updates,
    /** The organisation's run row as it now stands. */
    get run() {
      return run;
    },
  };
}

// Call counts only — the implementations each test sets are its own, and
// several cases here assert that a refusal did NOT reach the lander.
beforeEach(() => {
  vi.clearAllMocks();
});

/** A run in flight, heartbeating `agoMs` ago. */
const runningRun = (agoMs = 0, at = new Date('2026-08-10T00:10:00Z')) => ({
  id: 'run-live',
  orgId: 'org-1',
  startedAt: new Date(at.getTime() - agoMs),
  completedAt: null,
  status: 'running',
  heartbeatAt: new Date(at.getTime() - agoMs),
  failureReason: null,
  rowsTotal: 191,
});

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

  it('RECORDS a line with no date, undated rather than withheld (R153, reversed)', async () => {
    /*
      The old behaviour withheld the grant entirely and counted it skipped.
      That is now backwards: the person genuinely holds this, the source system
      simply never dated it, so it is granted with `grantedAt: null` and flagged
      via `competenciesUndated` for someone to date later — never defaulted to
      "today", which would manufacture a currency the person does not have.
    */
    const { db, runRows, updates } = fakeDb();
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
      validCompetencies: [line({ grantedAt: null })],
      rejected: [],
    });

    expect(mocks.grantCompetency).toHaveBeenCalledWith(
      db,
      TENANT,
      expect.objectContaining({ competencyId: 'c-1', expiresAt: null }),
    );
    // Written explicitly, never left to the column's default — a caller that
    // forgot this line would silently stamp "granted today" instead.
    const dated = updates.find((u) => 'grantedAt' in u);
    expect(dated!.grantedAt).toBeNull();
    expect(runRows[0]).toMatchObject({ competenciesRecorded: 1, competenciesUndated: 1 });
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

/*
  THE INCIDENT. 191 people and 3,325 competency lines went into production
  through a route that held one HTTP request open for the whole run. The browser
  timed out; the screen showed the upload form again with a live confirm button;
  the operator nearly ran the file a second time against production while the
  first run was still writing, and reconstructed its progress by counting rows in
  psql. Every test below is one of the things that had to become true for none of
  that to be possible again.
*/
describe('startImportRun — the run outlives the request', () => {
  const create = () => {
    mocks.resolveRows.mockResolvedValue([
      { row: row(), disposition: 'create', userId: null, membershipId: null, pool: 'candidate' },
    ]);
    mocks.landImportRow.mockResolvedValue({
      kind: 'created',
      userId: 'u-1',
      membershipId: 'm-1',
      incomplete: [],
    });
  };

  it('returns the run id BEFORE the rows are written, and finishes them after', async () => {
    /*
      The heart of the fix. `startImportRun` resolves once the run exists; the
      work continues on a detached promise. Asserting that no row has landed at
      the moment it resolves is what proves the caller is not being made to wait
      — the previous route returned only when the last of 191 rows was in.
    */
    const { db, runRows } = fakeDb();
    create();
    let landed = 0;
    mocks.landImportRow.mockImplementation(async () => {
      // A row that takes a turn of the loop, as a real transaction does.
      await new Promise((r) => setTimeout(r, 0));
      landed++;
      return { kind: 'created', userId: 'u-1', membershipId: 'm-1', incomplete: [] };
    });

    const started = await startImportRun(db, TENANT, {
      validProfiles: [row()],
      validCompetencies: [],
      rejected: [],
    });

    expect(started).toMatchObject({ runId: expect.any(String) });
    // Nothing done yet — the caller has its id and is free to respond.
    expect(landed).toBe(0);
    expect(runRows).toHaveLength(0);

    // …and the work carries on with nobody waiting on it.
    await vi.waitFor(() => expect(runRows).toHaveLength(1));
    expect(landed).toBe(1);
  });

  it('marks the run completed when it finishes, so the screen can stop asking', async () => {
    const { db, updates } = fakeDb();
    create();

    await executeImportRun(db, TENANT, {
      validProfiles: [row()],
      validCompetencies: [],
      rejected: [],
    });

    const finish = updates.find((u) => u.status === 'completed');
    expect(finish).toBeDefined();
    expect(finish!.completedAt).toBeInstanceOf(Date);
  });

  it('heartbeats as rows land, because a stopped heartbeat is the only crash signal', async () => {
    const { db, updates } = fakeDb();
    mocks.resolveRows.mockResolvedValue([
      { row: row(), disposition: 'create', userId: null, membershipId: null, pool: 'candidate' },
      { row: row({ rowNumber: 3, email: 'b@x.io' }), disposition: 'create', userId: null, membershipId: null, pool: 'candidate' },
    ]);
    mocks.landImportRow.mockResolvedValue({
      kind: 'created',
      userId: 'u-1',
      membershipId: 'm-1',
      incomplete: [],
    });

    await executeImportRun(db, TENANT, {
      validProfiles: [row(), row({ rowNumber: 3, email: 'b@x.io' })],
      validCompetencies: [],
      rejected: [],
    });

    // One per row, not one per run: a heartbeat stamped only at the start would
    // go stale on any file long enough to matter, which is every file that
    // caused this.
    const beats = updates.filter((u) => 'heartbeatAt' in u && !('status' in u));
    expect(beats.length).toBeGreaterThanOrEqual(2);
  });

  it('reports a run that THREW as failed, and releases the slot', async () => {
    /*
      Not a row's own refusal — those are outcomes (R170) and the run continues.
      This is the file-level failure: the taxonomy read threw, the connection
      went. It must not leave the organisation locked out of re-importing.
    */
    const { db, updates } = fakeDb();
    mocks.resolveRows.mockRejectedValue(new Error('connection terminated'));

    await executeImportRun(db, TENANT, {
      validProfiles: [row()],
      validCompetencies: [],
      rejected: [],
    });

    const failure = updates.find((u) => u.status === 'failed');
    expect(failure).toMatchObject({ status: 'failed', failureReason: 'connection terminated' });
    // Reported, not thrown: it runs on a detached promise, where a rejection is
    // an unhandled one and the run would sit `running` until the reaper caught it.
    const report = (await readRunReport(db, 'org-1', 'run-1'))!;
    expect(report.status).toBe('failed');
    expect(report.failureReason).toBe('connection terminated');
  });
});

describe('the concurrency guard — one active run per organisation', () => {
  it('REFUSES a second run while one is active, and names the one in flight', async () => {
    /*
      The single most important line of the rebuild. A second run against
      production would not corrupt anything — rows merge — but it would redo
      minutes of work and leave the operator with two reports of one file and no
      way to tell which was which.
    */
    const { db, runRows } = fakeDb({ run: runningRun() });

    const started = await startImportRun(
      db,
      TENANT,
      { validProfiles: [row()], validCompetencies: [], rejected: [] },
      new Date('2026-08-10T00:10:00Z'),
    );

    expect(started).toEqual({ refused: 'already_running', runId: 'run-live' });
    // And it started nothing: the refusal is the whole outcome.
    expect(runRows).toHaveLength(0);
    expect(mocks.landImportRow).not.toHaveBeenCalled();
  });

  it('refuses on the DATABASE’s index too, when both requests read “nothing running”', async () => {
    /*
      The race the read in front cannot close, and exactly the one a timed-out
      browser invites by leaving a live confirm button on screen. Postgres
      raises 23505 on the partial unique index; the loser reports the winner's
      run rather than an error, because the caller cannot tell the paths apart
      and should not have to.
    */
    const { db } = fakeDb({ run: null, conflictOnInsert: true });
    // Nothing running at the moment of the read…
    (db.query.importRuns.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined)
      // …and the winner's run by the time the insert has broken.
      .mockResolvedValue(runningRun());

    const started = await startImportRun(db, TENANT, {
      validProfiles: [row()],
      validCompetencies: [],
      rejected: [],
    });

    expect(started).toEqual({ refused: 'already_running', runId: 'run-live' });
  });

  it('ALLOWS a second run once the first has finished', async () => {
    // The guard is against a concurrent run, not against ever importing twice —
    // an Admin correcting a rejection list re-imports the fixed file.
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

    const first = await executeImportRun(db, TENANT, {
      validProfiles: [row()],
      validCompetencies: [],
      rejected: [],
    });
    expect(first).not.toHaveProperty('refused');

    const second = await executeImportRun(db, TENANT, {
      validProfiles: [row()],
      validCompetencies: [],
      rejected: [],
    });
    expect(second).not.toHaveProperty('refused');
    expect(runRows).toHaveLength(2);
  });

  it('reports the active run in full, so the screen shows progress not a form', async () => {
    const { db, runRows } = fakeDb({ run: runningRun() });
    runRows.push(
      { rowNumber: 2, subject: 'A', outcome: 'created', flagged: [], differences: [], competenciesRecorded: 0, competenciesUndated: 0, assessmentsAssigned: 0 },
      { rowNumber: 3, subject: 'B', outcome: 'created', flagged: [], differences: [], competenciesRecorded: 0, competenciesUndated: 0, assessmentsAssigned: 0 },
    );

    const active = (await readActiveRunReport(db, 'org-1', new Date('2026-08-10T00:10:00Z')))!;

    expect(active.status).toBe('running');
    expect(active.runId).toBe('run-live');
    // Counted rows against the file's real total — never an estimate. This is
    // the figure the operator was reduced to fetching with `select count(*)`.
    expect(active.rowsProcessed).toBe(2);
    expect(active.rowsTotal).toBe(191);
  });

  it('answers null when nothing is running, so the form comes back', async () => {
    const { db } = fakeDb();
    expect(await readActiveRunReport(db, 'org-1')).toBeNull();
  });
});

describe('a dead run — detected by a stopped heartbeat, never by silence', () => {
  /*
    Nothing writes `failed` when the process holding a run disappears — a
    redeploy mid-import, an OOM, a recycled container. The only evidence left is
    that the heartbeat stopped, so that is what is read. The alternative is a run
    that reads `running` forever, which is the same lie as an upload form over a
    live import, just pointed the other way.
  */
  const NOW = new Date('2026-08-10T00:10:00Z');

  it('reaps a run whose heartbeat went stale, and says WHY it stopped', async () => {
    const { db, run } = fakeDb({ run: runningRun(RUN_STALE_AFTER_MS + 1_000) });
    expect(run!.status).toBe('running');

    await reapAbandonedRuns(db, 'org-1', NOW);

    const report = (await readRunReport(db, 'org-1', 'run-live', NOW))!;
    expect(report.status).toBe('failed');
    expect(report.failureReason).toBe('abandoned');
  });

  it('leaves a run that is merely SLOW alone', async () => {
    // The failure mode of getting this wrong is worse than the bug: reaping a
    // healthy run would report a working import as dead and invite the operator
    // to start the second one this whole change exists to prevent.
    const { db } = fakeDb({ run: runningRun(RUN_STALE_AFTER_MS - 1_000) });

    const report = (await readRunReport(db, 'org-1', 'run-live', NOW))!;
    expect(report.status).toBe('running');
    expect(report.failureReason).toBeNull();
  });

  it('frees the slot, so the file can simply be run again', async () => {
    /*
      The recovery is to re-import, and it is safe because row landing merges
      rather than duplicating — the rows a dead run already committed are real
      people, and a second pass matches them. What must NOT happen is the dead
      run holding the organisation's one slot forever.
    */
    const { db } = fakeDb({ run: runningRun(RUN_STALE_AFTER_MS + 1_000) });
    mocks.resolveRows.mockResolvedValue([]);

    const started = await startImportRun(
      db,
      TENANT,
      { validProfiles: [], validCompetencies: [], rejected: [] },
      NOW,
    );

    expect(started).not.toHaveProperty('refused');
  });

  it('is not reported as active once reaped', async () => {
    const { db } = fakeDb({ run: runningRun(RUN_STALE_AFTER_MS + 1_000) });
    expect(await readActiveRunReport(db, 'org-1', NOW)).toBeNull();
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
      { rowNumber: 2, subject: 'A', outcome: 'created', seatPool: 'candidate', flagged: ['mobile'], differences: [], competenciesRecorded: 2, competenciesUndated: 1, assessmentsAssigned: 1 },
      { rowNumber: 3, subject: 'B', outcome: 'merged', seatPool: null, flagged: [], differences: [{ field: 'roles', existing: 'x', fromFile: 'y' }], competenciesRecorded: 0, competenciesUndated: 0, assessmentsAssigned: 0 },
      { rowNumber: 4, subject: 'C', outcome: 'reactivated', seatPool: 'staff', flagged: [], differences: [], competenciesRecorded: 1, competenciesUndated: 0, assessmentsAssigned: 2 },
      { rowNumber: 5, subject: 'D', outcome: 'rejected', reason: 'unknown_location', detail: 'Nowhere', flagged: [], differences: [], competenciesRecorded: 0, competenciesUndated: 0, assessmentsAssigned: 0 },
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
