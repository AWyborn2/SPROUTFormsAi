// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type {
  Competency,
  RetirementReview,
  RoleRequirements,
  Taxonomy,
  TighteningReviewItem,
} from '../../lib/data/types.js';
import { ApiError } from '../../lib/data/api-client.js';

const taxonomy: { data: Taxonomy | undefined; isLoading: boolean } = {
  data: undefined,
  isLoading: false,
};
const createLocation = vi.fn();
const updateLocation = vi.fn();
const createDepartment = vi.fn();
const updateDepartment = vi.fn();
const createRole = vi.fn();
const updateRole = vi.fn();
const stopOffering = vi.fn();
const resolveTightening = vi.fn();
const previewLocationTransfer = vi.fn();
const transferLocation = vi.fn();
const transferRole = vi.fn();
const updateSettings = vi.fn();
/** The tightening-review query result (U17); empty by default so no review shows. */
const tighteningReview: { data: TighteningReviewItem[] | undefined } = { data: undefined };
/** The retirement-review query result (U18); empty by default so no panel shows. */
const retirementReview: { data: RetirementReview | undefined } = { data: undefined };
const tools: { data: Array<{ id: string; name: string }> } = { data: [] };
/** The org register the two toggle grids render over (U6). */
const competencies: { data: Competency[] } = { data: [] };
const roleRequirements: { data: RoleRequirements | undefined } = { data: undefined };
const refetchRequirements = vi.fn();
// The preview mutation resolves with the effects the confirmation panel shows
// — COMPETENCY terms since U3's effects rename.
const previewEffects: { value: Record<string, unknown> } = {
  value: {
    addedCompetencyIds: ['c-a'],
    removedCompetencyIds: [],
    affected: 3,
    created: 2,
    inFlightContinuing: 0,
    competenciesDemoting: 0,
  },
};
const previewRequirements = vi.fn(
  (
    _body: Record<string, unknown>,
    opts?: { onSuccess?: (r: { effects: Record<string, unknown> }) => void },
  ) => opts?.onSuccess?.({ effects: previewEffects.value }),
);
/** Set to make the next save/remove fail — e.g. the KTD9 stale 409. */
const writeError: { value: unknown } = { value: null };
const setRequirements = vi.fn(
  (
    _body: Record<string, unknown>,
    opts?: { onSuccess?: () => void; onError?: (e: unknown) => void },
  ) => (writeError.value ? opts?.onError?.(writeError.value) : opts?.onSuccess?.()),
);
const removeLegacy = vi.fn(
  (
    _input: Record<string, unknown>,
    opts?: { onSuccess?: () => void; onError?: (e: unknown) => void },
  ) => (writeError.value ? opts?.onError?.(writeError.value) : opts?.onSuccess?.()),
);
const createCompetency = vi.fn(
  (
    input: { name: string; code: string | null },
    opts?: { onSuccess?: (added: Competency) => void },
  ) =>
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

vi.mock('../../lib/data/hooks.js', () => ({
  useTaxonomy: () => taxonomy,
  useCreateLocation: () => ({ mutate: createLocation }),
  useUpdateLocation: () => ({ mutate: updateLocation }),
  useCreateDepartment: () => ({ mutate: createDepartment }),
  useUpdateDepartment: () => ({ mutate: updateDepartment }),
  useCreateRole: () => ({ mutate: createRole }),
  useUpdateRole: () => ({ mutate: updateRole }),
  useStopOfferingRole: () => ({ mutate: stopOffering }),
  useTighteningReview: () => tighteningReview,
  useResolveTightening: () => ({ mutate: resolveTightening, isPending: false }),
  useRetirementReview: () => retirementReview,
  usePreviewLocationTransfer: () => ({ mutate: previewLocationTransfer, isPending: false }),
  useTransferLocation: () => ({ mutate: transferLocation, isPending: false }),
  useTransferRole: () => ({ mutate: transferRole, isPending: false }),
  useUpdateTaxonomySettings: () => ({ mutate: updateSettings }),
  useAssessmentTools: () => tools,
  useCompetencies: () => competencies,
  useCreateCompetency: () => ({ mutate: createCompetency, isPending: false }),
  useRoleRequiredAssessments: () => ({ ...roleRequirements, refetch: refetchRequirements }),
  usePreviewRoleRequiredAssessments: () => ({ mutate: previewRequirements, isPending: false }),
  useSetRoleRequiredAssessments: () => ({ mutate: setRequirements, isPending: false }),
  useRemoveLegacyRequirement: () => ({ mutate: removeLegacy, isPending: false }),
}));

/** The awaitingLink "link me" pointer navigates to the register's backfill panel (U6). */
const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

const toast = vi.fn();
vi.mock('@formai/ui', async () => {
  const actual = await vi.importActual<typeof import('@formai/ui')>('@formai/ui');
  return { ...actual, useToast: () => ({ toast }) };
});

const { TaxonomyScreen } = await import('./TaxonomyScreen.js');

function base(): Taxonomy {
  return {
    locations: [],
    departments: [],
    settings: {
      allowMultipleLocations: false,
      allowMultipleDepartments: false,
      allowSelfAssessment: false,
      allowLabelledSignoff: true,
      displayIdentifier: 'employee_number',
      pooledCaseOverdueDays: 14,
      notificationLeadDays: 30,
      dateFormat: 'dmy',
      candidateSelfStartRecommended: false,
    },
  };
}

/** A register entry for the requirement grids. */
function comp(id: string, name: string, code: string | null = null): Competency {
  return { id, name, code, holders: 0, validForMonths: null, gracePeriodDays: null, color: 'var(--accent)' };
}

/** An empty, never-configured requirement read with a stable fingerprint. */
function requirementState(over: Partial<RoleRequirements> = {}): RoleRequirements {
  return {
    configured: false,
    required: [],
    recommended: [],
    awaitingLink: [],
    fingerprint: 'fp-1',
    ...over,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  taxonomy.data = undefined;
  taxonomy.isLoading = false;
  tools.data = [];
  competencies.data = [];
  roleRequirements.data = undefined;
  tighteningReview.data = undefined;
  retirementReview.data = undefined;
  writeError.value = null;
  previewEffects.value = {
    addedCompetencyIds: ['c-a'],
    removedCompetencyIds: [],
    affected: 3,
    created: 2,
    inFlightContinuing: 0,
    competenciesDemoting: 0,
  };
});

const withOneRole = (roleOver: Record<string, unknown> = {}): Taxonomy => ({
  ...base(),
  departments: [
    {
      id: 'dep-1',
      name: 'Operations',
      allowsMultipleRoles: true,
      status: 'active',
      createdAt: '',
      roles: [
        { id: 'role-1', departmentId: 'dep-1', name: 'Dozer Operator', status: 'active', createdAt: '', ...roleOver },
      ],
    },
  ],
});

describe('TaxonomyScreen', () => {
  it('shows a Role nested under its Department (R5)', () => {
    taxonomy.data = {
      ...base(),
      departments: [
        {
          id: 'dep-1',
          name: 'Operations',
          allowsMultipleRoles: true,
          status: 'active',
          createdAt: '',
          roles: [
            { id: 'role-1', departmentId: 'dep-1', name: 'Dozer Operator', status: 'active', createdAt: '' },
          ],
        },
      ],
    };
    render(<TaxonomyScreen />);
    expect(screen.getByText('Operations')).toBeDefined();
    expect(screen.getByText('Dozer Operator')).toBeDefined();
    // The Role sits inside the Department's own add-a-Role affordance.
    expect(screen.getByLabelText('New role in Operations')).toBeDefined();
  });

  it('offers no add-a-Role control until a Department exists (R5)', () => {
    taxonomy.data = base();
    render(<TaxonomyScreen />);
    expect(screen.queryByRole('button', { name: /add role/i })).toBeNull();
  });

  it('persists a Department toggled to several Roles', () => {
    taxonomy.data = {
      ...base(),
      departments: [
        { id: 'dep-1', name: 'Maintenance', allowsMultipleRoles: false, status: 'active', createdAt: '', roles: [] },
      ],
    };
    render(<TaxonomyScreen />);
    fireEvent.click(screen.getByLabelText('Maintenance allows several Roles'));
    expect(updateDepartment).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'dep-1', allowsMultipleRoles: true }),
      expect.anything(),
    );
  });

  it('renders a retired Location struck through with a Return action, never a delete', () => {
    taxonomy.data = {
      ...base(),
      locations: [{ id: 'loc-1', name: 'Old Pit', status: 'retired', createdAt: '' }],
    };
    render(<TaxonomyScreen />);
    expect(screen.getByText('Old Pit')).toBeDefined();
    expect(screen.getByText('Retired')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Return' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });

  it('offers the two workforce numbers and persists the display-identifier choice (R40)', () => {
    taxonomy.data = base();
    render(<TaxonomyScreen />);
    const select = screen.getByLabelText('Display identifier') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain('employee_number');
    expect(values).toContain('swipe_card_number');
    fireEvent.change(select, { target: { value: 'swipe_card_number' } });
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ displayIdentifier: 'swipe_card_number' }),
      expect.anything(),
    );
  });

  it('offers the two date conventions and persists the date-format choice', () => {
    taxonomy.data = base();
    render(<TaxonomyScreen />);
    const select = screen.getByLabelText('Date format') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toContain('dmy');
    expect(values).toContain('mdy');
    fireEvent.change(select, { target: { value: 'mdy' } });
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ dateFormat: 'mdy' }),
      expect.anything(),
    );
  });

  it('creates a Location from the add field', () => {
    taxonomy.data = base();
    render(<TaxonomyScreen />);
    fireEvent.change(screen.getByLabelText('New location name'), { target: { value: 'Raw Materials' } });
    const panel = screen.getByText('Locations').closest('div')!;
    fireEvent.click(within(panel).getByRole('button', { name: 'Add' }));
    expect(createLocation).toHaveBeenCalledWith('Raw Materials', expect.anything());
  });
});

describe('TaxonomyScreen — a Role’s requirements in competency terms (U6)', () => {
  const openEditor = () =>
    fireEvent.click(screen.getByLabelText('Requirements for Dozer Operator'));
  const REGISTER = [comp('c-a', 'ATO - Track Dozer', 'Q34666893'), comp('c-b', 'First Aid')];

  it('shows "not set up" apart from "requires nothing" (R50)', () => {
    taxonomy.data = withOneRole();

    roleRequirements.data = requirementState({ configured: false });
    const { rerender } = render(<TaxonomyScreen />);
    expect(screen.getByText(/not set up/)).toBeDefined();

    roleRequirements.data = requirementState({ configured: true });
    rerender(<TaxonomyScreen />);
    expect(screen.getByText(/requires nothing/)).toBeDefined();
  });

  it('renders the two tiers over the register with the code chip (R5, R6)', () => {
    taxonomy.data = withOneRole();
    competencies.data = REGISTER;
    roleRequirements.data = requirementState();
    render(<TaxonomyScreen />);
    openEditor();

    expect(screen.getByLabelText('Require ATO - Track Dozer for Dozer Operator')).toBeDefined();
    expect(screen.getByLabelText('Recommend ATO - Track Dozer for Dozer Operator')).toBeDefined();
    // The nationally-recognised code rides the chip (twice — once per tier).
    expect(screen.getAllByText('Q34666893').length).toBe(2);
  });

  it('previews a required change in competency terms, then applies with the fingerprint (R8, KTD9)', () => {
    taxonomy.data = withOneRole();
    competencies.data = REGISTER;
    roleRequirements.data = requirementState();
    render(<TaxonomyScreen />);
    openEditor();

    fireEvent.click(screen.getByLabelText('Require ATO - Track Dozer for Dozer Operator'));
    // A required edit goes through a preview first — nothing is written yet.
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    expect(previewRequirements).toHaveBeenCalledWith(
      { required: ['c-a'], recommended: [] },
      expect.anything(),
    );
    expect(setRequirements).not.toHaveBeenCalled();

    // The blast radius is shown in competency terms; confirming applies it,
    // echoing the GET's fingerprint (KTD9).
    expect(screen.getByText(/Adds 1 competency: affects 3 people, creating 2 cases/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    expect(setRequirements).toHaveBeenCalledWith(
      { required: ['c-a'], recommended: [], fingerprint: 'fp-1' },
      expect.anything(),
    );
  });

  it('abandons the change on cancel, writing nothing (R86)', () => {
    taxonomy.data = withOneRole();
    competencies.data = REGISTER;
    roleRequirements.data = requirementState();
    render(<TaxonomyScreen />);
    openEditor();

    fireEvent.click(screen.getByLabelText('Require ATO - Track Dozer for Dozer Operator'));
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(setRequirements).not.toHaveBeenCalled();
    // Back to the review affordance, nothing committed.
    expect(screen.getByRole('button', { name: 'Review change' })).toBeDefined();
  });

  it('describes a removal by what it changes, not what it creates (R85)', () => {
    previewEffects.value = {
      addedCompetencyIds: [],
      removedCompetencyIds: ['c-a'],
      affected: 4,
      created: 0,
      inFlightContinuing: 2,
      competenciesDemoting: 3,
    };
    taxonomy.data = withOneRole();
    competencies.data = REGISTER;
    roleRequirements.data = requirementState({ configured: true, required: ['c-a'] });
    render(<TaxonomyScreen />);
    openEditor();

    // Deselect the only required competency, then review.
    fireEvent.click(screen.getByLabelText('Require ATO - Track Dozer for Dozer Operator'));
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));

    expect(screen.getByText(/2 cases already in progress will run to completion/)).toBeDefined();
    expect(screen.getByText(/3 competency standings become optional/)).toBeDefined();
    // A removal never advertises a creation count.
    expect(screen.queryByText(/creating/)).toBeNull();
  });

  it('saves a recommended-only edit directly, with no preview gate (R13)', () => {
    // Recommending enforces nothing — no blast radius exists to confirm — and
    // on a fresh Role the save leaves `configured` alone server-side (KTD9);
    // the client simply sends the tiers as edited.
    taxonomy.data = withOneRole();
    competencies.data = REGISTER;
    roleRequirements.data = requirementState({ configured: false });
    render(<TaxonomyScreen />);
    openEditor();

    fireEvent.click(screen.getByLabelText('Recommend First Aid for Dozer Operator'));
    expect(screen.queryByRole('button', { name: 'Review change' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(previewRequirements).not.toHaveBeenCalled();
    expect(setRequirements).toHaveBeenCalledWith(
      { required: [], recommended: ['c-b'], fingerprint: 'fp-1' },
      expect.anything(),
    );
  });

  it('blocks a tier overlap client-side — selecting in one tier moves it out of the other (KTD1)', () => {
    taxonomy.data = withOneRole();
    competencies.data = REGISTER;
    roleRequirements.data = requirementState();
    render(<TaxonomyScreen />);
    openEditor();

    // Require it, then recommend it: one row per (role, competency), so the
    // second click MOVES it rather than doubling it — the save can never hit
    // the 400 `tiers_overlap`.
    fireEvent.click(screen.getByLabelText('Require First Aid for Dozer Operator'));
    fireEvent.click(screen.getByLabelText('Recommend First Aid for Dozer Operator'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(setRequirements).toHaveBeenCalledWith(
      { required: [], recommended: ['c-b'], fingerprint: 'fp-1' },
      expect.anything(),
    );
  });

  it('reloads the editor with a notice on a stale-fingerprint 409 (KTD9)', () => {
    writeError.value = new ApiError(409, { error: 'requirements_changed' });
    taxonomy.data = withOneRole();
    competencies.data = REGISTER;
    roleRequirements.data = requirementState();
    render(<TaxonomyScreen />);
    openEditor();

    fireEvent.click(screen.getByLabelText('Require ATO - Track Dozer for Dozer Operator'));
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));

    // The other change survives: the editor refetches, drops the draft, and
    // says why — never a silent overwrite.
    expect(refetchRequirements).toHaveBeenCalled();
    expect(screen.getByText(/Requirements changed elsewhere/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Confirm change' })).toBeNull();
  });

  it('creates a competency inline and selects it in the chosen tier (R5)', () => {
    taxonomy.data = withOneRole();
    competencies.data = REGISTER;
    roleRequirements.data = requirementState();
    render(<TaxonomyScreen />);
    openEditor();

    fireEvent.click(screen.getByLabelText('Create a competency for Dozer Operator'));
    fireEvent.change(screen.getByLabelText('Competency name'), { target: { value: 'Grade Control' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create & require' }));

    expect(createCompetency).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Grade Control', code: null }),
      expect.anything(),
    );
    // Pickable immediately, and already selected in the required tier.
    expect(
      screen.getByLabelText('Require Grade Control for Dozer Operator').getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('renders awaitingLink rows with link-me and a previewed remove (R15, KTD9)', () => {
    previewEffects.value = {
      addedCompetencyIds: [],
      removedCompetencyIds: [],
      affected: 2,
      created: 0,
      inFlightContinuing: 1,
      competenciesDemoting: 0,
    };
    taxonomy.data = withOneRole();
    competencies.data = REGISTER;
    tools.data = [{ id: 'tool-l', name: 'Site Familiarisation v2' }];
    roleRequirements.data = requirementState({ configured: true, awaitingLink: ['tool-l'] });
    render(<TaxonomyScreen />);
    openEditor();

    // The legacy row is named by TOOL NAME, never a raw id.
    expect(screen.getByText('Site Familiarisation v2')).toBeDefined();

    // Link-me points the admin at the backfill panel on the register (U4) —
    // one linking flow, not a duplicate here.
    fireEvent.click(screen.getByLabelText('Link the award for Site Familiarisation v2'));
    expect(navigate).toHaveBeenCalledWith('/app/competency');

    // Remove confirms through the SAME preview door (KTD9, KTD10)…
    fireEvent.click(screen.getByLabelText('Remove legacy requirement Site Familiarisation v2'));
    expect(previewRequirements).toHaveBeenCalledWith(
      { required: [], recommended: [], removeLegacyToolIds: ['tool-l'] },
      expect.anything(),
    );
    expect(removeLegacy).not.toHaveBeenCalled();
    expect(screen.getByText(/1 case already in progress will run to completion/)).toBeDefined();

    // …and only the confirm calls the fingerprint-guarded DELETE.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));
    expect(removeLegacy).toHaveBeenCalledWith(
      { toolId: 'tool-l', fingerprint: 'fp-1' },
      expect.anything(),
    );
  });

  it('reads only for a retired Role — no toggles, no review (R121)', () => {
    taxonomy.data = withOneRole({ status: 'retired' });
    competencies.data = REGISTER;
    roleRequirements.data = requirementState({ configured: true, required: ['c-a'] });
    render(<TaxonomyScreen />);
    openEditor();

    expect(screen.getByText(/no new requirements/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Review change' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(
      screen.getByLabelText('Require ATO - Track Dozer for Dozer Operator'),
    ).toHaveProperty('disabled', true);
  });
});

describe('TaxonomyScreen — the candidate self-start setting (U7, R14)', () => {
  it('persists the toggle through the settings PATCH', () => {
    taxonomy.data = base();
    render(<TaxonomyScreen />);
    fireEvent.click(screen.getByLabelText('Candidates can self-start recommended training'));
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ candidateSelfStartRecommended: true }),
      expect.anything(),
    );
  });
});

describe('TaxonomyScreen — Role withdrawal and tightening (U17)', () => {
  it('stops offering a Role, a distinct act from retiring (R52)', () => {
    taxonomy.data = withOneRole();
    render(<TaxonomyScreen />);

    fireEvent.click(screen.getByRole('button', { name: 'Stop offering' }));
    expect(stopOffering).toHaveBeenCalledWith('role-1', expect.anything());
  });

  it('does not offer stop-offering on an already-retired Role', () => {
    taxonomy.data = withOneRole({ status: 'retired' });
    render(<TaxonomyScreen />);

    expect(screen.queryByRole('button', { name: 'Stop offering' })).toBeNull();
  });

  it('shows no tightening review while the Department allows several Roles', () => {
    taxonomy.data = withOneRole(); // allowsMultipleRoles: true
    tighteningReview.data = [
      { membershipId: 'm1', userId: 'u1', name: 'Bo Multi', heldRoles: [{ id: 'role-1', name: 'Dozer Operator' }] },
    ];
    render(<TaxonomyScreen />);

    expect(screen.queryByText(/holds several Roles here|hold several Roles here/)).toBeNull();
  });

  it('surfaces the people a single-Role Department still has to resolve (R112)', () => {
    taxonomy.data = {
      ...base(),
      departments: [
        {
          id: 'dep-1',
          name: 'Operations',
          allowsMultipleRoles: false,
          status: 'active',
          createdAt: '',
          roles: [
            { id: 'role-1', departmentId: 'dep-1', name: 'Dozer Operator', status: 'active', createdAt: '' },
            { id: 'role-2', departmentId: 'dep-1', name: 'Grader Operator', status: 'active', createdAt: '' },
          ],
        },
      ],
    };
    tighteningReview.data = [
      {
        membershipId: 'm1',
        userId: 'u1',
        name: 'Bo Multi',
        heldRoles: [
          { id: 'role-1', name: 'Dozer Operator' },
          { id: 'role-2', name: 'Grader Operator' },
        ],
      },
    ];
    render(<TaxonomyScreen />);

    expect(screen.getByText('Bo Multi')).toBeDefined();
    // Keeping a chosen Role applies the per-person choice (R113).
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(resolveTightening).toHaveBeenCalledWith(
      { membershipId: 'm1', survivingRoleId: 'role-1' },
      expect.anything(),
    );
  });
});

describe('TaxonomyScreen — retirement review (U18)', () => {
  it('shows no review panel when nothing retired is still held (R123)', () => {
    taxonomy.data = base();
    retirementReview.data = { locations: [], departments: [], roles: [] };
    render(<TaxonomyScreen />);
    expect(screen.queryByText('Retired values still held')).toBeNull();
  });

  it('lists a retired Location still held and transfers people off it (R116, R133)', () => {
    taxonomy.data = {
      ...base(),
      locations: [
        { id: 'loc-new', name: 'New Site', status: 'active', createdAt: '' },
        { id: 'loc-old', name: 'Old Site', status: 'retired', createdAt: '' },
      ],
    };
    retirementReview.data = {
      locations: [
        { id: 'loc-old', name: 'Old Site', holders: [{ membershipId: 'm1', userId: 'u1', name: 'Bo Holder' }] },
      ],
      departments: [],
      roles: [],
    };
    render(<TaxonomyScreen />);

    expect(screen.getByText('Retired values still held')).toBeDefined();
    expect(screen.getByText(/Bo Holder/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }));
    expect(transferLocation).toHaveBeenCalledWith(
      { locationId: 'loc-old', replacementLocationId: 'loc-new', caseOutcome: 'carry' },
      expect.anything(),
    );
  });
});
