// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
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
  validated: string[];
  ran: string[];
} = { preview: undefined, validating: false, report: undefined, validated: [], ran: [] };

vi.mock('../../lib/data/hooks.js', () => ({
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
    mutate: (csv: string, opts?: { onSuccess?: (r: { runId: string }) => void }) => {
      state.ran.push(csv);
      opts?.onSuccess?.({ runId: 'run-1' });
    },
    isPending: false,
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
  state.validated = [];
  state.ran = [];
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
  const report = (over: Partial<WorkforceImportRun> = {}): WorkforceImportRun => ({
    runId: 'run-1',
    startedAt: '2026-08-10T00:00:00Z',
    completedAt: '2026-08-10T00:01:00Z',
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
    state.report = report({ completedAt: null, rowsProcessed: 2 });
    render(<WorkforceImportScreen />);
    await uploadFile();
    fireEvent.click(screen.getByText('Confirm and import'));

    expect(screen.getByText('Importing…')).toBeDefined();
    expect(screen.getByText('2 of 4 rows')).toBeDefined();
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
