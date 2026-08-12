// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ApiError } from '../../lib/data/api-client.js';
import type { WorkforceImportPreview, WorkforceImportRun } from '../../lib/data/types.js';

/*
  The parser, the validator and the run each have their own suite. These cover
  what the SCREEN owns: the three states R144 separates, and that abandoning
  writes nothing because validating never did.
*/
const state: {
  preview: WorkforceImportPreview | undefined;
  validating: boolean;
  report: WorkforceImportRun | undefined;
  /** What `/workforce-import/active` answers — a run in flight, or none. */
  active: WorkforceImportRun | null;
  /** Whether that answer has arrived yet; the screen must not guess while it has not. */
  activePending: boolean;
  /** The 409 the server returns when one is already running, if it does. */
  runConflict: { runId: string } | undefined;
  validated: string[];
  ran: string[];
} = {
  preview: undefined,
  validating: false,
  report: undefined,
  active: null,
  activePending: false,
  runConflict: undefined,
  validated: [],
  ran: [],
};

vi.mock('../../lib/data/hooks.js', () => ({
  useActiveWorkforceImport: () => ({
    data: state.activePending ? undefined : { run: state.active },
    isPending: state.activePending,
    refetch: () => Promise.resolve(),
  }),
  useValidateWorkforceImport: () => ({
    mutate: (csv: string) => state.validated.push(csv),
    data: state.preview,
    isPending: state.validating,
    isError: false,
    reset: () => {
      state.preview = undefined;
    },
  }),
  useRunWorkforceImport: () => ({
    /*
      Calls back synchronously, as the real mutation does on success. Setting
      the run id from outside the click would land outside React's act() and
      never flush, so the assertion would read a screen the product never shows.
    */
    mutate: (
      csv: string,
      opts?: { onSuccess?: (r: { runId: string }) => void; onError?: (e: unknown) => void },
    ) => {
      state.ran.push(csv);
      // The 409 arm: the server refused because one is already running, and
      // named it. The screen is expected to watch that run, not report a failure.
      if (state.runConflict) {
        opts?.onError?.(new ApiError(409, { error: 'import_already_running', ...state.runConflict }));
        return;
      }
      opts?.onSuccess?.({ runId: 'run-1' });
    },
    isPending: false,
    reset: () => {
      state.runConflict = undefined;
    },
  }),
  useWorkforceImportRun: () => ({ data: state.report }),
}));

vi.mock('../../lib/data/store.js', () => ({
  store: { getWorkforceImportTemplate: async () => '#profiles\nname,email\n' },
}));

const { WorkforceImportScreen } = await import('./WorkforceImportScreen.js');

const cost = (over: Partial<WorkforceImportPreview['preview']> = {}) => ({
  candidate: { needed: 3, available: 100, covered: 3, overflow: 0 },
  staff: { needed: 1, available: 15, covered: 1, overflow: 0 },
  blocks: [],
  refusedForSeats: 0,
  ...over,
});

const preview = (over: Partial<WorkforceImportPreview> = {}): WorkforceImportPreview => ({
  validRows: 4,
  competencyLines: 2,
  rejected: [],
  preview: cost(),
  ...over,
});

/**
 * Actually pick a file, because the confirm button is gated on one being read.
 * Asserting against a screen that never received a file would pass for the
 * wrong reason — the button is disabled with no file whatever the preview says.
 */
async function uploadFile(contents = '#profiles\nname,email\nJane,jane@x.io\n') {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([contents], 'workforce.csv', { type: 'text/csv' });
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
}

afterEach(() => {
  vi.clearAllMocks();
  state.preview = undefined;
  state.validating = false;
  state.report = undefined;
  state.active = null;
  state.activePending = false;
  state.runConflict = undefined;
  state.validated = [];
  state.ran = [];
});

/** One run's report, in whichever state the case under test needs. */
const report = (over: Partial<WorkforceImportRun> = {}): WorkforceImportRun => ({
  runId: 'run-1',
  startedAt: '2026-08-10T00:00:00Z',
  completedAt: '2026-08-10T00:01:00Z',
  status: 'completed',
  failureReason: null,
  rowsTotal: 4,
  rowsProcessed: 4,
  profilesCreated: 2,
  membershipsAdded: 1,
  membershipsReactivated: 1,
  peopleMerged: 0,
  duplicateRows: 0,
  candidateSeats: 3,
  staffSeats: 1,
  competenciesRecorded: 5,
  linesFlaggedNoDate: 1,
  assessmentsAssigned: 2,
  profilesFlaggedIncomplete: 1,
  differencesReported: 0,
  rejected: [],
  flagged: [],
  differences: [],
  ...over,
});

describe('WorkforceImportScreen — before upload', () => {
  it('offers the template and a file picker, and nothing else', () => {
    render(<WorkforceImportScreen />);
    expect(screen.getByText('Download template')).toBeDefined();
    expect(screen.getByText(/Choose a filled file/)).toBeDefined();
    // No cost and no confirmation until a file has actually been read.
    expect(screen.queryByText('Confirm and import')).toBeNull();
    expect(screen.queryByText(/What this will cost/)).toBeNull();
  });

  it('states the configure-then-import ordering BEFORE a run (R172)', () => {
    /*
      Importing people before their Roles carry requirements assigns nothing,
      which reads as a broken import rather than the correct outcome. Saying so
      afterwards is too late.
    */
    render(<WorkforceImportScreen />);
    expect(screen.getByText(/Configure your Locations, Departments, Roles/)).toBeDefined();
  });
});

describe('WorkforceImportScreen — after validation (R144)', () => {
  it('prices BOTH pools, even where one is zero', () => {
    // An Admin reading one figure cannot tell which allocation it came out of,
    // and the two are metered separately.
    state.preview = preview({ preview: cost({ staff: { needed: 0, available: 15, covered: 0, overflow: 0 } }) });
    render(<WorkforceImportScreen />);
    expect(screen.getByText('Candidate seats')).toBeDefined();
    expect(screen.getByText('Staff seats')).toBeDefined();
  });

  it('quotes the blocks a candidate overflow would buy (R86)', () => {
    state.preview = preview({
      preview: cost({
        candidate: { needed: 105, available: 100, covered: 100, overflow: 5 },
        blocks: [{ size: 50, count: 1, seats: 50, discount: 0 }],
      }),
    });
    render(<WorkforceImportScreen />);
    expect(screen.getByText(/1 × 50 candidate seats/)).toBeDefined();
    expect(screen.getByText(/added and charged/)).toBeDefined();
  });

  it('warns that a staff overflow is REFUSED rather than bought', () => {
    // That pool does not expand — R84 and R86 are candidate-seat rules.
    state.preview = preview({ preview: cost({ refusedForSeats: 3 }) });
    render(<WorkforceImportScreen />);
    expect(screen.getByText(/3 rows will be refused for want of a staff seat/)).toBeDefined();
  });

  it('lists the rejected rows with their row number and reason', () => {
    state.preview = preview({
      validRows: 1,
      rejected: [
        { rowNumber: 4, subject: 'Bad Row', reason: 'unknown_location', detail: 'Nowhere' },
        { rowNumber: 7, subject: 'Worse Row', reason: 'role_not_offered' },
      ],
    });
    render(<WorkforceImportScreen />);
    expect(screen.getByText('Rows that will be skipped (2)')).toBeDefined();
    expect(screen.getByText('#4')).toBeDefined();
    expect(screen.getByText('Bad Row')).toBeDefined();
    // Underscores are the wire format, not something to show a person.
    expect(screen.getByText('unknown location')).toBeDefined();
  });

  it('offers confirm and abandon, and abandoning writes NOTHING', async () => {
    state.preview = preview();
    render(<WorkforceImportScreen />);
    await uploadFile();

    fireEvent.click(screen.getByText('Abandon'));
    // Validation never wrote anything, so there is nothing to undo — the only
    // proof needed is that no run was started.
    expect(state.ran).toEqual([]);
  });

  it('does not offer the run where every row was rejected', async () => {
    // A file IS picked here, so the button is disabled for the reason under
    // test rather than for want of a file.
    state.preview = preview({ validRows: 0, rejected: [{ rowNumber: 2, subject: 'X', reason: 'missing_name' }] });
    render(<WorkforceImportScreen />);
    await uploadFile();
    expect((screen.getByText('Confirm and import') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('WorkforceImportScreen — the run report (R171)', () => {
  it('names every figure R171 lists once the run is confirmed', async () => {
    state.preview = preview();
    state.report = report();
    render(<WorkforceImportScreen />);
    await uploadFile();
    fireEvent.click(screen.getByText('Confirm and import'));

    expect(screen.getByText('Import complete')).toBeDefined();
    for (const label of [
      'Profiles created',
      'People merged',
      'Memberships reactivated',
      'Candidate seats used',
      'Staff seats used',
      'Competencies recorded',
      'Lines with no date',
      'Assessments assigned',
      'Profiles flagged incomplete',
      'Differences reported',
      'Rows rejected',
    ]) {
      expect(screen.getByText(label), `${label} missing from the report`).toBeDefined();
    }
  });

  it('shows progress against the total while the run is in flight', async () => {
    state.preview = preview();
    state.report = report({ status: 'running', completedAt: null, rowsProcessed: 2 });
    render(<WorkforceImportScreen />);
    await uploadFile();
    fireEvent.click(screen.getByText('Confirm and import'));

    expect(screen.getByText('Importing…')).toBeDefined();
    // Counted rows, not an estimate — the figure the operator was reduced to
    // fetching with `select count(*)` by hand.
    expect(screen.getByText('2 of 4 rows')).toBeDefined();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2');
  });

  it('says the run does not need this page open, because it does not', async () => {
    // The reassurance that was missing. The request that started it ended
    // seconds later; the browser closing changes nothing about the run.
    state.preview = preview();
    state.report = report({ status: 'running', completedAt: null, rowsProcessed: 2 });
    render(<WorkforceImportScreen />);
    await uploadFile();
    fireEvent.click(screen.getByText('Confirm and import'));

    expect(screen.getByText(/You can close this page/)).toBeDefined();
  });

  it('reports a FAILED run as stopped, not as still running', async () => {
    /*
      A run whose process died stops heartbeating and is reaped. Left reading
      `running` it would spin forever, which is the same lie by a different
      route as the upload form that replaced a live import.
    */
    state.preview = preview();
    state.report = report({
      status: 'failed',
      failureReason: 'abandoned',
      rowsProcessed: 61,
      rowsTotal: 191,
    });
    render(<WorkforceImportScreen />);
    await uploadFile();
    fireEvent.click(screen.getByText('Confirm and import'));

    expect(screen.getByText('Import stopped')).toBeDefined();
    expect(screen.getByText(/the server it was running on went away/)).toBeDefined();
    // The rows that landed are real and were kept — re-importing merges them.
    expect(screen.getByText(/merges rather than duplicating/)).toBeDefined();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('lists a difference with a link to the record, and says nothing was overwritten (R149)', async () => {
    /*
      An import must not be able to demote an administrator to a candidate on the
      strength of a column, so a difference against an existing ACTIVE membership
      is reported for an Admin to settle rather than written.
    */
    state.preview = preview();
    state.report = report({
      differencesReported: 1,
      differences: [
        {
          rowNumber: 3,
          subject: 'Priya Nair',
          membershipId: 'm-9',
          items: [{ field: 'accessLevel', existing: 'admin', fromFile: 'candidate' }],
        },
      ],
    });
    render(<WorkforceImportScreen />);
    await uploadFile();
    fireEvent.click(screen.getByText('Confirm and import'));

    expect(screen.getByText(/Nothing was overwritten/)).toBeDefined();
    expect(screen.getByText('Priya Nair')).toBeDefined();
    expect((screen.getByText('Open record') as HTMLAnchorElement).getAttribute('href')).toBe(
      '/app/profile/m-9',
    );
  });

  it('keeps the run reference visible, because the report outlives the tab', async () => {
    state.preview = preview();
    state.report = report();
    render(<WorkforceImportScreen />);
    await uploadFile();
    fireEvent.click(screen.getByText('Confirm and import'));

    expect(screen.getByText(/stays readable after you close this page/)).toBeDefined();
  });
});

describe('WorkforceImportScreen — a run already in flight', () => {
  /*
    THE INCIDENT, as a suite. An operator's browser timed out waiting on a
    191-person import; the screen fell back to the upload form and offered a
    live "Confirm and import" button while the first run was still writing rows.
    He came within one click of running the whole file a second time against
    production, and only avoided it by asking.
  */
  it('shows the run in progress rather than an upload form', () => {
    state.active = report({ status: 'running', completedAt: null, rowsProcessed: 61, rowsTotal: 191 });
    render(<WorkforceImportScreen />);

    expect(screen.getByText('Importing…')).toBeDefined();
    expect(screen.getByText('61 of 191 rows')).toBeDefined();
    // The button that nearly did the damage is not on the page at all.
    expect(screen.queryByText('Confirm and import')).toBeNull();
    expect(screen.queryByText('Download template')).toBeNull();
  });

  it('offers nothing at all until it knows whether one is running', () => {
    // Drawing the form on "not yet loaded" would reproduce the bug exactly:
    // the screen would be guessing, and guessing wrong is what happened.
    state.activePending = true;
    render(<WorkforceImportScreen />);

    expect(screen.getByText(/Checking whether an import is already running/)).toBeDefined();
    expect(screen.queryByText('Confirm and import')).toBeNull();
  });

  it('offers the upload form again once nothing is running', () => {
    // The guard is against a CONCURRENT run, not against ever importing twice.
    state.active = null;
    render(<WorkforceImportScreen />);

    expect(screen.getByText('Download template')).toBeDefined();
  });

  it('watches the named run when the server refuses with a 409', async () => {
    /*
      Two tabs, or a double submit. The work the Admin wanted IS happening, so
      the honest response is to show them that run — not an error, which would
      read as "your import did not happen" and invite them to try again.
    */
    state.preview = preview();
    state.runConflict = { runId: 'run-already' };
    state.report = report({ runId: 'run-already', status: 'running', completedAt: null, rowsProcessed: 7 });
    render(<WorkforceImportScreen />);
    await uploadFile();
    await act(async () => {
      fireEvent.click(screen.getByText('Confirm and import'));
    });

    expect(screen.getByText('Importing…')).toBeDefined();
    expect(screen.getByText(/run-already/)).toBeDefined();
  });
});
