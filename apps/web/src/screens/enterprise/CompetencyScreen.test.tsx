// @vitest-environment jsdom
/**
 * The one screen where expiry is SET, and the only one where it is SEEN.
 *
 * How long a competency stays valid is the single stored fact the whole feature
 * rests on, and it applies to every grant of that competency at once — so the
 * things worth pinning are that blank means perpetual (not zero, not "expires
 * today"), and that the register shows who a validity has just lapsed. The
 * stored `holders` count cannot answer that second question, which is exactly
 * why the register exists.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Competency, CompetencyHolder } from '../../lib/data/types.js';

const competencies: { data: Competency[] } = { data: [] };
const setValidityMutate = vi.fn();
const holdersResult: { data: CompetencyHolder[] | undefined; isLoading: boolean; isError: boolean } = {
  data: [],
  isLoading: false,
  isError: false,
};
/** Records which competency the register was asked for, or null if never. */
let holdersAskedFor: string | null = null;

vi.mock('../../lib/data/hooks.js', () => ({
  useForms: () => ({ data: [] }),
  useCompetencies: () => competencies,
  useCompetencyRules: () => ({ data: [] }),
  useAddRule: () => ({ mutate: vi.fn() }),
  useToggleRule: () => ({ mutate: vi.fn() }),
  useRemoveRule: () => ({ mutate: vi.fn() }),
  useSetCompetencyValidity: () => ({ mutate: setValidityMutate, isPending: false }),
  useCompetencyHolders: (id: string) => {
    holdersAskedFor = id;
    return holdersResult;
  },
}));

const toast = vi.fn();
vi.mock('@formai/ui', async () => {
  const actual = await vi.importActual<typeof import('@formai/ui')>('@formai/ui');
  return { ...actual, useToast: () => ({ toast }) };
});

const { CompetencyScreen } = await import('./CompetencyScreen.js');

const TRACK_DOZER: Competency = {
  id: 'c1',
  name: 'ATO - Track Dozer',
  code: 'Q34666893',
  holders: 12,
  validForMonths: null,
  gracePeriodDays: null,
  color: 'var(--accent)',
};

function holder(over: Partial<CompetencyHolder> = {}): CompetencyHolder {
  return {
    userId: 'u1',
    name: 'Ada Current',
    email: 'ada@example.com',
    evidenceRef: null,
    grantedAt: '2024-01-15T00:00:00.000Z',
    expiresAt: '2027-01-15T00:00:00.000Z',
    status: 'held',
    current: true,
    note: null,
    ...over,
  };
}

/** Open the inline validity editor for the first competency in the list. */
function openEditor(name = TRACK_DOZER.name) {
  fireEvent.click(screen.getByLabelText(`Set how long ${name} stays valid`));
}

/** Open the holder register for the first competency in the list. */
function openRegister(name = TRACK_DOZER.name) {
  fireEvent.click(screen.getByLabelText(`Show who holds ${name}`));
}

afterEach(() => {
  vi.clearAllMocks();
  competencies.data = [];
  holdersResult.data = [];
  holdersResult.isLoading = false;
  holdersResult.isError = false;
  holdersAskedFor = null;
});

describe('CompetencyScreen validity', () => {
  it('says a competency with no validity never expires', () => {
    competencies.data = [TRACK_DOZER];
    render(<CompetencyScreen />);

    expect(screen.getByText('Never expires')).toBeDefined();
  });

  it('shows a set validity in years, with its grace period', () => {
    competencies.data = [{ ...TRACK_DOZER, validForMonths: 36, gracePeriodDays: 90 }];
    render(<CompetencyScreen />);

    expect(screen.getByText('3 years · 90 day grace')).toBeDefined();
  });

  it('saves years as months', () => {
    // The column is months; the industry says years. The conversion belongs
    // here rather than in anyone's head.
    competencies.data = [TRACK_DOZER];
    render(<CompetencyScreen />);
    openEditor();

    fireEvent.change(screen.getByLabelText('Valid for (years)'), { target: { value: '3' } });
    fireEvent.click(screen.getByText('Save'));

    expect(setValidityMutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', validForMonths: 36 }),
      expect.anything(),
    );
  });

  it('treats a blank period as perpetual, not as zero', () => {
    // Clearing the field is how an admin says "this stops expiring". Reading it
    // as 0 would lapse every holder at once.
    competencies.data = [{ ...TRACK_DOZER, validForMonths: 36, gracePeriodDays: 90 }];
    render(<CompetencyScreen />);
    openEditor();

    fireEvent.change(screen.getByLabelText('Valid for (years)'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));

    expect(setValidityMutate).toHaveBeenCalledWith(
      expect.objectContaining({ validForMonths: null, gracePeriodDays: null }),
      expect.anything(),
    );
  });

  it('refuses a period that is not a whole number of years', () => {
    competencies.data = [TRACK_DOZER];
    render(<CompetencyScreen />);
    openEditor();

    fireEvent.change(screen.getByLabelText('Valid for (years)'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByText('Save'));

    expect(setValidityMutate).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'warning' }));
  });

  it('warns before saving that this reaches everyone who already holds it', () => {
    // Expiry counts from each person's own grant date, so setting a validity is
    // retroactive by design. An admin has to see that before pressing save.
    competencies.data = [TRACK_DOZER];
    render(<CompetencyScreen />);
    openEditor();

    expect(screen.getByText(/already holds it/)).toBeDefined();
  });
});

describe('CompetencyScreen holder register', () => {
  it('asks for nothing until a register is opened', () => {
    /*
      The register is a request per competency. Fetching all of them to render a
      collapsed list would issue twenty requests to show a list nobody has asked
      to see — so the hook must stay disabled until something is expanded.
    */
    competencies.data = [TRACK_DOZER];
    render(<CompetencyScreen />);

    expect(holdersAskedFor).toBeNull();

    openRegister();
    expect(holdersAskedFor).toBe('c1');
  });

  it('names each holder and how they stand', () => {
    competencies.data = [TRACK_DOZER];
    holdersResult.data = [
      holder({ userId: 'u-lapsed', name: 'Bo Lapsed', status: 'expired', current: false }),
      holder(),
    ];
    render(<CompetencyScreen />);
    openRegister();

    expect(screen.getByText('Bo Lapsed')).toBeDefined();
    expect(screen.getByText('Expired')).toBeDefined();
    expect(screen.getByText('Ada Current')).toBeDefined();
    expect(screen.getByText('Current')).toBeDefined();
  });

  it('counts how many are no longer current', () => {
    // The number on the row is grants, not currency. This line is the only
    // place the screen says how many of them actually still count.
    competencies.data = [TRACK_DOZER];
    holdersResult.data = [
      holder({ userId: 'a', status: 'expired', current: false }),
      holder({ userId: 'b', status: 'grace', current: true }),
      holder({ userId: 'c' }),
    ];
    render(<CompetencyScreen />);
    openRegister();

    expect(screen.getByText('1 of 3 no longer current')).toBeDefined();
  });

  it('says nothing alarming when everyone is current', () => {
    competencies.data = [TRACK_DOZER];
    holdersResult.data = [holder(), holder({ userId: 'u2', name: 'Cy Fine' })];
    render(<CompetencyScreen />);
    openRegister();

    expect(screen.queryByText(/no longer current/)).toBeNull();
  });

  it('preserves the order the API returned', () => {
    /*
      The API sorts by what needs doing — expired, grace, expiring, then held.
      Re-sorting here (by name, say) would bury the two people who need booking
      among the two hundred who do not, which is the whole reason the register
      exists.
    */
    competencies.data = [TRACK_DOZER];
    holdersResult.data = [
      holder({ userId: 'a', name: 'Zoe Expired', status: 'expired', current: false }),
      holder({ userId: 'b', name: 'Bo Grace', status: 'grace' }),
      holder({ userId: 'c', name: 'Ada Fine' }),
    ];
    render(<CompetencyScreen />);
    openRegister();

    const names = screen.getAllByText(/Zoe Expired|Bo Grace|Ada Fine/).map((n) => n.textContent);
    expect(names).toEqual(['Zoe Expired', 'Bo Grace', 'Ada Fine']);
  });

  it('shows a grace holder as a warning, not a failure', () => {
    // Someone inside the grace window still counts. Colouring it like a lapse
    // would send an admin to stand down a worker who is entitled to keep going.
    competencies.data = [TRACK_DOZER];
    holdersResult.data = [holder({ status: 'grace', current: true })];
    render(<CompetencyScreen />);
    openRegister();

    expect(screen.getByText('In grace')).toBeDefined();
    expect(screen.queryByText(/no longer current/)).toBeNull();
  });

  it('does not print an expiry date for a competency that never expires', () => {
    competencies.data = [TRACK_DOZER];
    holdersResult.data = [holder({ expiresAt: null })];
    render(<CompetencyScreen />);
    openRegister();

    expect(screen.getByText('No expiry set')).toBeDefined();
  });

  it('says a passed date in the past tense', () => {
    // "Expires 2025-01-15" against a lapsed ticket reads as a future event, and
    // leaves the badge beside it to do the correcting.
    competencies.data = [TRACK_DOZER];
    holdersResult.data = [
      holder({ status: 'expired', current: false, expiresAt: '2025-01-15T00:00:00.000Z' }),
    ];
    render(<CompetencyScreen />);
    openRegister();

    expect(screen.getByText('Expired 2025-01-15')).toBeDefined();
  });

  it('reads a grace holder in the past tense too', () => {
    // Grace still counts, but its date HAS passed — that is what separates it
    // from expiring, and saying "expires" would flatten the distinction.
    competencies.data = [TRACK_DOZER];
    holdersResult.data = [
      holder({ status: 'grace', current: true, expiresAt: '2025-06-01T00:00:00.000Z' }),
    ];
    render(<CompetencyScreen />);
    openRegister();

    expect(screen.getByText('Expired 2025-06-01')).toBeDefined();
  });

  it('keeps the future tense for a date still ahead', () => {
    competencies.data = [TRACK_DOZER];
    holdersResult.data = [
      holder({ status: 'expiring', expiresAt: '2027-01-15T00:00:00.000Z' }),
    ];
    render(<CompetencyScreen />);
    openRegister();

    expect(screen.getByText('Expires 2027-01-15')).toBeDefined();
  });

  it('says so when nobody holds it, rather than showing an empty box', () => {
    competencies.data = [TRACK_DOZER];
    holdersResult.data = [];
    render(<CompetencyScreen />);
    openRegister();

    expect(screen.getByText(/Nobody holds this yet/)).toBeDefined();
  });

  it('reports a failed load instead of reading as nobody', () => {
    // An errored fetch rendering the empty state would tell an admin the
    // register is empty when it is only unreachable.
    competencies.data = [TRACK_DOZER];
    holdersResult.data = undefined;
    holdersResult.isError = true;
    render(<CompetencyScreen />);
    openRegister();

    expect(screen.getByText(/Could not load/)).toBeDefined();
    expect(screen.queryByText(/Nobody holds this yet/)).toBeNull();
  });
});
