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
import type { Competency, CompetencyHolder, UnlinkedTool } from '../../lib/data/types.js';

const competencies: { data: Competency[] } = { data: [] };
const setValidityMutate = vi.fn();
const createMutate = vi.fn();
const grantMutate = vi.fn();
/*
  THE BACKFILL PANEL (U4). Defaults keep every pre-existing test blind to it:
  an admin session with an empty worklist renders no panel at all.
*/
const sessionResult: { data: { role: string } | undefined } = { data: { role: 'admin' } };
const unlinkedResult: { data: UnlinkedTool[] | undefined } = { data: [] };
/** Records the `enabled` option the screen passed, or null if never asked. */
let unlinkedEnabledWith: boolean | null = null;
const previewMutate = vi.fn();
const applyMutate = vi.fn();
const holdersResult: { data: CompetencyHolder[] | undefined; isLoading: boolean; isError: boolean } = {
  data: [],
  isLoading: false,
  isError: false,
};
/** Records which competency the register was asked for, or null if never. */
let holdersAskedFor: string | null = null;
/** Records which competency a grant was armed against, or null if never. */
let grantAskedFor: string | null = null;
const membersResult: { data: { id: string; userId: string | null; name: string; email: string }[] } = {
  data: [],
};
/** What `useForm` returns for the gating-rule form — the section source. */
const formDetail: { data: { fields: { id: string; type: string; label: string }[] } | undefined } = {
  data: undefined,
};

vi.mock('../../lib/data/hooks.js', () => ({
  useForms: () => ({ data: [] }),
  useForm: () => formDetail,
  useMembers: () => membersResult,
  useCompetencies: () => competencies,
  useCompetencyRules: () => ({ data: [] }),
  useSession: () => sessionResult,
  useUnlinkedTools: (options?: { enabled?: boolean }) => {
    unlinkedEnabledWith = options?.enabled ?? true;
    // Mirrors react-query: a disabled query never fetches, so it has no data.
    return unlinkedEnabledWith ? unlinkedResult : { data: undefined };
  },
  usePreviewAwardLink: () => ({ mutate: previewMutate, isPending: false }),
  useApplyAwardLink: () => ({ mutate: applyMutate, isPending: false }),
  useAddRule: () => ({ mutate: vi.fn() }),
  useToggleRule: () => ({ mutate: vi.fn() }),
  useRemoveRule: () => ({ mutate: vi.fn() }),
  useSetCompetencyValidity: () => ({ mutate: setValidityMutate, isPending: false }),
  useCreateCompetency: () => ({ mutate: createMutate, isPending: false }),
  useGrantCompetency: (id: string) => {
    grantAskedFor = id;
    return { mutate: grantMutate, isPending: false };
  },
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
    revoked: false,
    standing: 'optional',
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
  grantAskedFor = null;
  membersResult.data = [];
  formDetail.data = undefined;
  sessionResult.data = { role: 'admin' };
  unlinkedResult.data = [];
  unlinkedEnabledWith = null;
});

describe('CompetencyScreen validity', () => {
  it('says a competency with no validity never expires', () => {
    competencies.data = [TRACK_DOZER];
    render(<CompetencyScreen />);

    expect(screen.getByText('Never expires')).toBeDefined();
  });

  it('renders a missing code as absent, never as "null" or a blank line', () => {
    // The em dash is what this screen already uses for a date it does not have.
    // An empty line where a mono code normally sits reads as a row that failed
    // to load; the literal string "null" reads as a bug.
    competencies.data = [{ ...TRACK_DOZER, name: 'Contractor Endorsement Form', code: null }];
    render(<CompetencyScreen />);

    // More than one: the register row and the gating-rule picker both name it.
    expect(screen.getAllByText('Contractor Endorsement Form').length).toBeGreaterThan(0);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.queryByText('null')).toBeNull();
    expect(screen.queryByText('undefined')).toBeNull();
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

  it('marks a revoked holder as revoked, not by a dated badge (R104)', () => {
    // The grant's date says held, but it was revoked. The reader must see the
    // act, not the date — so the currency badge is replaced by a revoked mark.
    competencies.data = [TRACK_DOZER];
    holdersResult.data = [holder({ status: 'held', revoked: true, current: false })];
    render(<CompetencyScreen />);
    openRegister();

    // The mark appears both on the sub-line and as the badge.
    expect(screen.getAllByText('Revoked').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Current')).toBeNull();
    // A revoked grant is no longer current, so it swells the lapsed count.
    expect(screen.getByText('1 of 1 no longer current')).toBeDefined();
  });

  it('shows each holder’s standing beside its currency (R108)', () => {
    competencies.data = [TRACK_DOZER];
    holdersResult.data = [
      holder({ userId: 'req', name: 'Ida Required', standing: 'required' }),
      holder({ userId: 'opt', name: 'Ola Optional', standing: 'optional' }),
    ];
    render(<CompetencyScreen />);
    openRegister();

    expect(screen.getByText('Required')).toBeDefined();
    expect(screen.getByText('Optional')).toBeDefined();
  });

  it('renders BOTH source scopes on a holder under a location AND a role requirement (U8, R5)', () => {
    // The register's dual-source rendering: the row says WHY it stands, in
    // the one comma-joined spelling every surface shares.
    competencies.data = [TRACK_DOZER];
    holdersResult.data = [
      holder({
        userId: 'req',
        name: 'Ida Required',
        standing: 'required',
        sources: [
          { scope: 'location', name: 'Boddington' },
          { scope: 'role', name: 'Dozer Operator' },
        ],
      }),
      // The gated shape: sources ABSENT — the row renders no source line at
      // all rather than an empty "from".
      holder({ userId: 'gated', name: 'Bo Gated', standing: 'required' }),
    ];
    render(<CompetencyScreen />);
    openRegister();

    expect(screen.getByText('Required — from Boddington and Dozer Operator')).toBeDefined();
    expect(screen.getAllByText(/— from/)).toHaveLength(1);
  });

  it('labels a recommended holder "Recommended" — never collapsed to Optional (U7, R12, KTD7)', () => {
    // The standing map is exhaustive over the union: the third tier gets its
    // own label, end to end from the API's standingOf to this register row.
    competencies.data = [TRACK_DOZER];
    holdersResult.data = [
      holder({ userId: 'rec', name: 'Ria Recommended', standing: 'recommended' }),
    ];
    render(<CompetencyScreen />);
    openRegister();

    expect(screen.getByText('Recommended')).toBeDefined();
    expect(screen.queryByText('Optional')).toBeNull();
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

  it('marks an undated holder distinctly from a perpetual one (R153, reversed)', () => {
    // Both end up with no expiresAt, but they are not the same claim: "No
    // expiry set" says the competency never expires; an undated holder says
    // the product does not know, because nobody supplied a grant date. Reading
    // them the same way would misreport a record-keeping gap as settled.
    competencies.data = [TRACK_DOZER];
    holdersResult.data = [holder({ status: 'undated', current: true, grantedAt: null, expiresAt: null })];
    render(<CompetencyScreen />);
    openRegister();

    expect(screen.getByText('Undated')).toBeDefined();
    expect(screen.getByText('Not yet dated')).toBeDefined();
    expect(screen.queryByText('No expiry set')).toBeNull();
    // Counts as current — a missing date is not evidence of a lapsed person.
    expect(screen.queryByText(/no longer current/)).toBeNull();
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

/*
  GRANTING BY HAND.

  POST /competencies/:id/holders predates this control and had no client
  caller, so the only grant path was an assessment sign-off. A PREREQUISITE
  competency — a driver's licence sighted at induction — is exactly the kind
  nobody earns through an assessment here, which made every prerequisite check
  permanently unsatisfiable.
*/
describe('CompetencyScreen granting by hand', () => {
  const crew = [
    { id: 'm1', userId: 'u-ada', name: 'Ada Current', email: 'ada@example.com' },
    { id: 'm2', userId: null, name: 'Ivy Invited', email: 'ivy@example.com' },
  ];

  function openGrant() {
    openRegister();
    fireEvent.click(screen.getByText('Record a holder by hand'));
  }

  it('grants to the picked person against the opened competency', () => {
    competencies.data = [TRACK_DOZER];
    membersResult.data = crew;
    render(<CompetencyScreen />);
    openGrant();

    fireEvent.change(screen.getByLabelText('Person'), { target: { value: 'u-ada' } });
    fireEvent.click(screen.getByText('Grant'));

    expect(grantAskedFor).toBe('c1');
    expect(grantMutate).toHaveBeenCalledWith({ userId: 'u-ada' }, expect.anything());
  });

  it('sends a set expiry as the end of that day', () => {
    /*
      A licence "expires 2027-03-15" is valid THROUGH the printed date.
      Midnight would lapse it the moment that day begins — reading a worker as
      unqualified for the whole final day the licence still counts.
    */
    competencies.data = [TRACK_DOZER];
    membersResult.data = crew;
    render(<CompetencyScreen />);
    openGrant();

    fireEvent.change(screen.getByLabelText('Person'), { target: { value: 'u-ada' } });
    fireEvent.change(screen.getByLabelText('Expires (optional)'), {
      target: { value: '2027-03-15' },
    });
    fireEvent.click(screen.getByText('Grant'));

    expect(grantMutate).toHaveBeenCalledWith(
      { userId: 'u-ada', expiresAt: '2027-03-15T23:59:59.000Z' },
      expect.anything(),
    );
  });

  it('refuses to grant to nobody', () => {
    competencies.data = [TRACK_DOZER];
    membersResult.data = crew;
    render(<CompetencyScreen />);
    openGrant();

    fireEvent.click(screen.getByText('Grant'));

    expect(grantMutate).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'warning' }));
  });

  it('offers only people who exist as users', () => {
    // A grant is keyed on the USER id, which an unaccepted invite does not
    // have yet — offering the invitee would post a null and 400.
    competencies.data = [TRACK_DOZER];
    membersResult.data = crew;
    render(<CompetencyScreen />);
    openGrant();

    const options = Array.from(screen.getByLabelText('Person').querySelectorAll('option')).map(
      (o) => o.textContent,
    );
    expect(options).toContain('Ada Current');
    expect(options).not.toContain('Ivy Invited');
  });

  it('is offered from the empty register — where it is needed most', () => {
    // "Nobody holds this yet" is precisely the moment an admin comes here to
    // record a sighted licence, so the empty state must carry the control.
    competencies.data = [TRACK_DOZER];
    holdersResult.data = [];
    membersResult.data = crew;
    render(<CompetencyScreen />);
    openRegister();

    expect(screen.getByText('Record a holder by hand')).toBeDefined();
  });
});

/*
  THE SECTION PICKER.

  A gating rule references a section by its printed heading. Typed from
  memory, a heading that matches nothing gates nothing — silently — so the
  picker offers the chosen form's own headers and free text survives only for
  forms that have none.
*/
describe('CompetencyScreen gating rule section picker', () => {
  it('offers the chosen form’s own printed sections', () => {
    formDetail.data = {
      fields: [
        { id: 'h1', type: 'section_header', label: 'Roof access items' },
        { id: 'f1', type: 'text', label: 'Name' },
        { id: 'h2', type: 'section_header', label: 'Working at heights' },
      ],
    };
    render(<CompetencyScreen />);

    const options = Array.from(
      screen.getByLabelText('Section to gate').querySelectorAll('option'),
    ).map((o) => o.textContent);
    expect(options).toEqual(['— pick a section —', 'Roof access items', 'Working at heights']);
  });

  it('falls back to free text for a form with no headers', () => {
    formDetail.data = { fields: [{ id: 'f1', type: 'text', label: 'Name' }] };
    render(<CompetencyScreen />);

    expect(screen.getByPlaceholderText('e.g. Roof access items')).toBeDefined();
  });
});

/*
  ADDING A COMPETENCY.

  POST /competencies existed since gating shipped and nothing called it, so an
  org with an empty register could only fill one with hand-written SQL — and
  the first real deployment reached sign-off with zero competencies recorded,
  granting nothing while every case still went competent and every certificate
  still printed.
*/
describe('CompetencyScreen add competency', () => {
  function openForm() {
    fireEvent.click(screen.getByText('Add competency'));
  }

  function type(label: string, value: string) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }

  it('adds a competency with its code and validity', () => {
    render(<CompetencyScreen />);
    openForm();

    type('Name', 'ATO - Track Dozer');
    type('Code (optional)', 'Q34666893');
    type('Valid for (years)', '3');
    fireEvent.click(screen.getByText('Add'));

    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'ATO - Track Dozer',
        code: 'Q34666893',
        validForMonths: 36,
      }),
      expect.anything(),
    );
  });

  it('adds a competency with no code, sending null rather than an empty string', () => {
    /*
      A code is still STRONGLY preferred — it is what the authoring script and
      every training-system export match on. But some competencies genuinely
      have none: a contractor endorsement form is internal, not a nationally
      coded unit, and requiring a code meant inventing one in the very column
      people cross-reference against their LMS.
    */
    render(<CompetencyScreen />);
    openForm();

    type('Name', 'Contractor Endorsement Form');
    fireEvent.click(screen.getByText('Add'));

    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Contractor Endorsement Form', code: null }),
      expect.anything(),
    );
  });

  it('refuses a competency with no name — the code is what became optional, not the name', () => {
    render(<CompetencyScreen />);
    openForm();

    fireEvent.click(screen.getByText('Add'));

    expect(createMutate).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'warning' }));
  });

  it('lets two codeless competencies coexist — absence is not a duplicate', () => {
    // The duplicate-code guard matches on the code. Two competencies that both
    // have none are not the same ticket twice, and matching on nothing would
    // block the second internal competency an org ever adds.
    competencies.data = [{ ...TRACK_DOZER, id: 'c-none', name: 'Bistrainer Basics', code: null }];
    render(<CompetencyScreen />);
    openForm();

    type('Name', 'Dieback Management');
    fireEvent.click(screen.getByText('Add'));

    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Dieback Management', code: null }),
      expect.anything(),
    );
  });

  it('refuses a name that is only whitespace', () => {
    render(<CompetencyScreen />);
    openForm();

    type('Name', '   ');
    type('Code (optional)', 'Q1');
    fireEvent.click(screen.getByText('Add'));

    expect(createMutate).not.toHaveBeenCalled();
  });

  it('creates a perpetual competency when no validity is given', () => {
    // Same rule as the editor: blank is perpetual, never zero.
    render(<CompetencyScreen />);
    openForm();

    type('Name', 'Site Induction');
    type('Code (optional)', 'SI-1');
    fireEvent.click(screen.getByText('Add'));

    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ validForMonths: null, gracePeriodDays: null }),
      expect.anything(),
    );
  });

  it('drops a grace period that has no expiry to be grace for', () => {
    render(<CompetencyScreen />);
    openForm();

    type('Name', 'Site Induction');
    type('Code (optional)', 'SI-1');
    type('Grace (days)', '30');
    fireEvent.click(screen.getByText('Add'));

    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ validForMonths: null, gracePeriodDays: null }),
      expect.anything(),
    );
  });

  it('trims what was typed', () => {
    render(<CompetencyScreen />);
    openForm();

    type('Name', '  ATO - Track Dozer  ');
    type('Code (optional)', ' Q34666893 ');
    fireEvent.click(screen.getByText('Add'));

    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ATO - Track Dozer', code: 'Q34666893' }),
      expect.anything(),
    );
  });

  it('offers no way to delete a competency', () => {
    /*
      competency_holders.competency_id CASCADES, so deleting a competency erases
      every record of who ever held it — the same erasure the revoke path was
      just fixed to avoid. A one-click control for that does not belong beside a
      create form, however convenient it would be.

      THIS USED TO ASSERT queryByLabelText(/Delete ATO - Track Dozer/), which
      passed trivially: *ByLabelText matches aria-label and <label> only, never
      button text, so the regex could not have matched a delete button even if
      one existed. Asserted over every control the screen actually renders
      instead — which does catch one being added.
    */
    competencies.data = [TRACK_DOZER];
    render(<CompetencyScreen />);

    const controls = [
      ...screen.getAllByRole('button'),
      ...screen.queryAllByRole('menuitem'),
    ].map((el) => `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`.toLowerCase());

    expect(controls.some((c) => /delete|remove|destroy/.test(c) && c.includes('track dozer'))).toBe(
      false,
    );
  });

  it('refuses a code the register already carries', () => {
    /*
      Nothing in the database stops two competencies sharing a code — there is
      no unique index on (org_id, code) — and the authoring script resolves a
      tool's competencies through a code→id map built from an unordered select,
      so a duplicate makes which one an assessment awards depend on row order.
    */
    competencies.data = [TRACK_DOZER];
    render(<CompetencyScreen />);
    openForm();

    type('Name', 'Track Dozer (old ticket)');
    type('Code (optional)', TRACK_DOZER.code!);
    fireEvent.click(screen.getByText('Add'));

    expect(createMutate).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'warning' }));
  });

  it('catches a duplicate code however it was cased', () => {
    competencies.data = [TRACK_DOZER];
    render(<CompetencyScreen />);
    openForm();

    type('Name', 'Track Dozer (old ticket)');
    type('Code (optional)', ' q34666893 ');
    fireEvent.click(screen.getByText('Add'));

    expect(createMutate).not.toHaveBeenCalled();
  });

  it('says so when the create fails, instead of looking like nothing happened', () => {
    /*
      The global mutation handler only reacts to 401, and nothing renders
      create.error — so without an onError a 403 from a plan without competency
      gating, or a 400 from a rejected body, left the button re-enabled with the
      form still filled and no way to tell the click had registered.
    */
    createMutate.mockImplementation((_input, opts) => opts?.onError?.(new Error('feature_not_available')));
    render(<CompetencyScreen />);
    openForm();

    type('Name', 'Site Induction');
    type('Code (optional)', 'SI-1');
    fireEvent.click(screen.getByText('Add'));

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'warning', message: expect.stringContaining('feature_not_available') }),
    );
  });
});

/*
  THE ONE-TIME BACKFILL PANEL (U4, R3, KTD5 — AE3).

  Tools created before awards were required at create are INERT: the engine
  treats their empty awards list as vacuously satisfied and assigns nothing,
  and sign-off grants nothing. Linking an award ACTIVATES assignment — real
  cases for real people — which is why every Accept here travels through a
  preview whose counts the admin confirms before anything lands.
*/
describe('CompetencyScreen backfill panel', () => {
  /** AE3's matched half: exact name match, so the server suggested it. */
  const MATCHED: UnlinkedTool = {
    id: 't-dozer',
    name: 'Track Dozer Assessment',
    templateId: 'tpl-1',
    suggestion: { competencyId: 'c1', name: 'ATO - Track Dozer' },
  };
  /** AE3's unmatched half: nothing on the register matches, no guessing. */
  const UNMATCHED: UnlinkedTool = {
    id: 't-fam',
    name: 'Site Familiarisation v2',
    templateId: 'tpl-2',
    suggestion: null,
  };

  it('is absent when nothing is unlinked', () => {
    competencies.data = [TRACK_DOZER];
    unlinkedResult.data = [];
    render(<CompetencyScreen />);

    expect(screen.queryByText(/awarding nothing/i)).toBeNull();
    expect(screen.queryByText('Link award')).toBeNull();
  });

  it('never fetches the worklist for a role the endpoint would 403', () => {
    // The unlinked read is admin-only server-side; an assessor mounting this
    // screen must not fire a request that lands as a 403 in every log.
    sessionResult.data = { role: 'assessor' };
    unlinkedResult.data = [MATCHED];
    render(<CompetencyScreen />);

    expect(unlinkedEnabledWith).toBe(false);
    expect(screen.queryByText(/awarding nothing/i)).toBeNull();
  });

  it('covers AE3: the matched row carries the suggestion, the unmatched row offers a prefilled create', () => {
    competencies.data = [TRACK_DOZER];
    unlinkedResult.data = [MATCHED, UNMATCHED];
    render(<CompetencyScreen />);

    // Both rows are on the worklist.
    expect(screen.getByText('Track Dozer Assessment')).toBeDefined();
    expect(screen.getByText('Site Familiarisation v2')).toBeDefined();

    // The matched row arrives with the server's suggestion already picked…
    const matchedPick = screen.getByLabelText(
      'What Track Dozer Assessment awards',
    ) as HTMLSelectElement;
    expect(matchedPick.value).toBe('c1');

    // …the unmatched row arrives with nothing picked — no guessing (R3).
    const unmatchedPick = screen.getByLabelText(
      'What Site Familiarisation v2 awards',
    ) as HTMLSelectElement;
    expect(unmatchedPick.value).toBe('');

    // And the unmatched row offers creating the competency, name prefilled
    // from the tool so accepting the default is the one-step path.
    fireEvent.click(screen.getByLabelText('Create a competency for Site Familiarisation v2'));
    expect((screen.getByLabelText('Competency name') as HTMLInputElement).value).toBe(
      'Site Familiarisation v2',
    );
  });

  it('shows the preview counts before anything is applied', () => {
    competencies.data = [TRACK_DOZER];
    unlinkedResult.data = [MATCHED];
    previewMutate.mockImplementation((_input, opts) =>
      opts?.onSuccess?.({ rolesLinked: 2, affected: 5, created: 3 }),
    );
    render(<CompetencyScreen />);

    fireEvent.click(screen.getByLabelText('Preview link for Track Dozer Assessment'));

    expect(previewMutate).toHaveBeenCalledWith(
      { toolId: 't-dozer', competencyId: 'c1' },
      expect.anything(),
    );
    // The counts, in the panel's own words — what the admin is agreeing to.
    expect(screen.getByText(/links 2 role requirements/i)).toBeDefined();
    expect(screen.getByText(/creates 3 cases for 5 people/i)).toBeDefined();
    // Preview is READ-ONLY: nothing has been applied yet.
    expect(applyMutate).not.toHaveBeenCalled();
  });

  it('applies the previewed link and reports the created cases', () => {
    competencies.data = [TRACK_DOZER];
    unlinkedResult.data = [MATCHED];
    previewMutate.mockImplementation((_input, opts) =>
      opts?.onSuccess?.({ rolesLinked: 2, affected: 5, created: 3 }),
    );
    applyMutate.mockImplementation((_input, opts) =>
      opts?.onSuccess?.({ rolesLinked: 2, affected: 5, created: 3 }),
    );
    render(<CompetencyScreen />);

    fireEvent.click(screen.getByLabelText('Preview link for Track Dozer Assessment'));
    fireEvent.click(screen.getByText('Link award'));

    expect(applyMutate).toHaveBeenCalledWith(
      { toolId: 't-dozer', competencyId: 'c1' },
      expect.anything(),
    );
    // The report AFTER: the admin learns what actually landed, not just that
    // a request returned 200.
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'success',
        message: expect.stringContaining('3 cases'),
      }),
    );
  });

  it('refuses to apply without a fresh preview of the picked competency', () => {
    /*
      The preview's counts belong to a (tool, competency) PAIR. Re-picking
      after previewing would let "Link award" apply a pair the admin never
      saw counts for — so a change of pick discards the preview.
    */
    competencies.data = [
      TRACK_DOZER,
      { ...TRACK_DOZER, id: 'c2', name: 'ATO - Grader', code: 'Q99' },
    ];
    unlinkedResult.data = [MATCHED];
    previewMutate.mockImplementation((_input, opts) =>
      opts?.onSuccess?.({ rolesLinked: 2, affected: 5, created: 3 }),
    );
    render(<CompetencyScreen />);

    fireEvent.click(screen.getByLabelText('Preview link for Track Dozer Assessment'));
    expect(screen.getByText('Link award')).toBeDefined();

    fireEvent.change(screen.getByLabelText('What Track Dozer Assessment awards'), {
      target: { value: 'c2' },
    });

    expect(screen.queryByText('Link award')).toBeNull();
    expect(screen.queryByText(/links 2 role requirements/i)).toBeNull();
  });

  it('cannot preview until a competency is picked', () => {
    competencies.data = [TRACK_DOZER];
    unlinkedResult.data = [UNMATCHED];
    render(<CompetencyScreen />);

    const previewBtn = screen.getByLabelText(
      'Preview link for Site Familiarisation v2',
    ) as HTMLButtonElement;
    expect(previewBtn.disabled).toBe(true);
    fireEvent.click(previewBtn);
    expect(previewMutate).not.toHaveBeenCalled();
  });

  it('creates the competency inline and picks it in one step', () => {
    competencies.data = [TRACK_DOZER];
    unlinkedResult.data = [UNMATCHED];
    createMutate.mockImplementation((input, opts) =>
      opts?.onSuccess?.({
        id: 'c-new',
        name: input.name,
        code: input.code,
        holders: 0,
        validForMonths: null,
        gracePeriodDays: null,
        color: 'var(--accent)',
      }),
    );
    render(<CompetencyScreen />);

    fireEvent.click(screen.getByLabelText('Create a competency for Site Familiarisation v2'));
    fireEvent.click(screen.getByText('Add & pick'));

    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Site Familiarisation v2', code: null }),
      expect.anything(),
    );
    // The new competency is now this row's pick — ready to preview.
    const pick = screen.getByLabelText('What Site Familiarisation v2 awards') as HTMLSelectElement;
    expect(pick.value).toBe('c-new');
  });
});
