// @vitest-environment jsdom
/**
 * The four-scope requirements editor (U6). The role-scope tests moved here
 * from TaxonomyScreen.test.tsx with the extraction; the scope-generalisation
 * and inherited-display tests are this round's. Hooks are mocked WHOLESALE
 * (the screen-test convention), keyed by scope ref so one mock serves the
 * editor's own read AND its inherited context reads.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type {
  Competency,
  RequirementScopeRef,
  ScopeRequirementsState,
  Taxonomy,
} from '../../lib/data/types.js';
import { ApiError } from '../../lib/data/api-client.js';

const tools: { data: Array<{ id: string; name: string }> } = { data: [] };
/** The org register the picker renders over. */
const competencies: { data: Competency[] } = { data: [] };
/** Requirement states per scope key — the editor's own scope AND every inherited read. */
const statesByScope: Record<string, ScopeRequirementsState | undefined> = {};
const scopeKey = (ref: RequirementScopeRef | undefined) =>
  ref ? `${ref.scope}:${ref.scopeId ?? ''}` : 'none';
const refetchRequirements = vi.fn();
// The refs the write hooks were mounted with — pins that each editor writes
// its OWN scope (KTD6/KTD7), not a role path.
let previewRef: RequirementScopeRef | undefined;
let setRef: RequirementScopeRef | undefined;
let removeLegacyRoleId: string | undefined;

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
/** Set to make the next save/remove fail — e.g. the KTD7 stale 409. */
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
  useAssessmentTools: () => tools,
  useCompetencies: () => competencies,
  useCreateCompetency: () => ({ mutate: createCompetency, isPending: false }),
  useScopeRequirements: (ref: RequirementScopeRef | undefined) => ({
    data: statesByScope[scopeKey(ref)],
    refetch: refetchRequirements,
  }),
  usePreviewScopeRequirements: (ref: RequirementScopeRef) => {
    previewRef = ref;
    return { mutate: previewRequirements, isPending: false };
  },
  useSetScopeRequirements: (ref: RequirementScopeRef) => {
    setRef = ref;
    return { mutate: setRequirements, isPending: false };
  },
  useRemoveLegacyRequirement: (roleId: string) => {
    removeLegacyRoleId = roleId;
    return { mutate: removeLegacy, isPending: false };
  },
}));

/** The awaitingLink "link me" pointer navigates to the register's backfill panel. */
const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

const toast = vi.fn();
vi.mock('@formai/ui', async () => {
  const actual = await vi.importActual<typeof import('@formai/ui')>('@formai/ui');
  return { ...actual, useToast: () => ({ toast }) };
});

const { ScopeRequirements } = await import('./ScopeRequirements.js');
type ScopeTarget = Parameters<typeof ScopeRequirements>[0]['target'];

/** A register entry for the picker. The two-entry default register derives
 *  all-singleton families, so the picker sits in FLAT mode (KTD10) and every
 *  checkbox is directly visible — group mechanics are the picker's own tests. */
function comp(id: string, name: string, code: string | null = null): Competency {
  return { id, name, code, holders: 0, validForMonths: null, gracePeriodDays: null, color: 'var(--accent)' };
}
const REGISTER = [
  comp('c-a', 'ATO - Track Dozer', 'Q34666893'),
  comp('c-b', 'First Aid'),
  comp('c-c', 'Site Induction', 'ZI-9'),
];

/** An empty, never-configured role-scope read with a stable fingerprint. */
function requirementState(over: Partial<ScopeRequirementsState> = {}): ScopeRequirementsState {
  return {
    configured: false,
    required: [],
    recommended: [],
    awaitingLink: [],
    fingerprint: 'fp-1',
    ...over,
  };
}

/** A non-role scope read: no configured flag, no legacy rows (KTD6). */
function bareState(over: Partial<ScopeRequirementsState> = {}): ScopeRequirementsState {
  return { required: [], recommended: [], fingerprint: 'fp-1', ...over };
}

function taxonomyFixture(): Taxonomy {
  return {
    locations: [
      { id: 'loc-b', name: 'Boddington', status: 'active', createdAt: '' },
      { id: 'loc-r', name: 'Raw Materials', status: 'active', createdAt: '' },
      { id: 'loc-x', name: 'Old Pit', status: 'retired', createdAt: '' },
    ],
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
    settings: {
      allowMultipleLocations: false,
      allowMultipleDepartments: false,
      allowSelfAssessment: false,
      displayIdentifier: 'employee_number',
      pooledCaseOverdueDays: 14,
      notificationLeadDays: 30,
      dateFormat: 'dmy',
      candidateSelfStartRecommended: false,
    },
  };
}

const ROLE_TARGET: ScopeTarget = {
  scope: 'role',
  scopeId: 'role-1',
  name: 'Dozer Operator',
  retired: false,
  departmentId: 'dep-1',
};
const ORG_TARGET: ScopeTarget = { scope: 'org', name: 'the organisation' };
const LOCATION_TARGET: ScopeTarget = {
  scope: 'location',
  scopeId: 'loc-b',
  name: 'Boddington',
  retired: false,
};
const DEPARTMENT_TARGET: ScopeTarget = {
  scope: 'department',
  scopeId: 'dep-1',
  name: 'Operations',
  retired: false,
};

const onError = vi.fn();
function renderScope(target: ScopeTarget) {
  return render(
    <ScopeRequirements target={target} taxonomy={taxonomyFixture()} onError={onError} />,
  );
}
const openEditor = (name: string) =>
  fireEvent.click(screen.getByLabelText(`Requirements for ${name}`));
const requireBox = (competency: string, scope: string) =>
  screen.getByLabelText(`Require ${competency} for ${scope}`) as HTMLInputElement;
const recommendBox = (competency: string, scope: string) =>
  screen.getByLabelText(`Recommend ${competency} for ${scope}`) as HTMLInputElement;

afterEach(() => {
  vi.clearAllMocks();
  tools.data = [];
  competencies.data = [];
  for (const key of Object.keys(statesByScope)) delete statesByScope[key];
  writeError.value = null;
  previewRef = undefined;
  setRef = undefined;
  removeLegacyRoleId = undefined;
  previewEffects.value = {
    addedCompetencyIds: ['c-a'],
    removedCompetencyIds: [],
    affected: 3,
    created: 2,
    inFlightContinuing: 0,
    competenciesDemoting: 0,
  };
});

describe('ScopeRequirements — role scope (moved from TaxonomyScreen with the U6 extraction)', () => {
  it('shows "not set up" apart from "requires nothing" (R50)', () => {
    statesByScope['role:role-1'] = requirementState({ configured: false });
    const { rerender } = renderScope(ROLE_TARGET);
    expect(screen.getByText(/not set up/)).toBeDefined();

    statesByScope['role:role-1'] = requirementState({ configured: true });
    rerender(
      <ScopeRequirements target={ROLE_TARGET} taxonomy={taxonomyFixture()} onError={onError} />,
    );
    expect(screen.getByText(/requires nothing/)).toBeDefined();
  });

  it('renders both tier checkboxes over the register with the code (R5, R6)', () => {
    competencies.data = REGISTER;
    statesByScope['role:role-1'] = requirementState();
    renderScope(ROLE_TARGET);
    openEditor('Dozer Operator');

    expect(requireBox('ATO - Track Dozer', 'Dozer Operator').checked).toBe(false);
    expect(recommendBox('ATO - Track Dozer', 'Dozer Operator').checked).toBe(false);
    // The nationally-recognised code rides the option row (once — one row per
    // competency now, both tiers beside it).
    expect(screen.getAllByText('Q34666893').length).toBe(1);
  });

  it('previews a required change in competency terms, then applies with the fingerprint (R6, KTD7)', () => {
    competencies.data = REGISTER;
    statesByScope['role:role-1'] = requirementState();
    renderScope(ROLE_TARGET);
    openEditor('Dozer Operator');

    fireEvent.click(requireBox('ATO - Track Dozer', 'Dozer Operator'));
    // A required edit goes through a preview first — nothing is written yet.
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    expect(previewRequirements).toHaveBeenCalledWith(
      { required: ['c-a'], recommended: [] },
      expect.anything(),
    );
    expect(setRequirements).not.toHaveBeenCalled();

    // The blast radius is shown in competency terms; confirming applies it,
    // echoing the GET's fingerprint.
    expect(screen.getByText(/Adds 1 competency: affects 3 people, creating 2 cases/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    expect(setRequirements).toHaveBeenCalledWith(
      { required: ['c-a'], recommended: [], fingerprint: 'fp-1' },
      expect.anything(),
    );
    expect(setRef).toEqual({ scope: 'role', scopeId: 'role-1' });
  });

  it('abandons the change on cancel, writing nothing', () => {
    competencies.data = REGISTER;
    statesByScope['role:role-1'] = requirementState();
    renderScope(ROLE_TARGET);
    openEditor('Dozer Operator');

    fireEvent.click(requireBox('ATO - Track Dozer', 'Dozer Operator'));
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(setRequirements).not.toHaveBeenCalled();
    // Back to the review affordance, nothing committed.
    expect(screen.getByRole('button', { name: 'Review change' })).toBeDefined();
  });

  it('describes a removal by what it changes, not what it creates', () => {
    previewEffects.value = {
      addedCompetencyIds: [],
      removedCompetencyIds: ['c-a'],
      affected: 4,
      created: 0,
      inFlightContinuing: 2,
      competenciesDemoting: 3,
    };
    competencies.data = REGISTER;
    statesByScope['role:role-1'] = requirementState({ configured: true, required: ['c-a'] });
    renderScope(ROLE_TARGET);
    openEditor('Dozer Operator');

    // Deselect the only required competency, then review.
    fireEvent.click(requireBox('ATO - Track Dozer', 'Dozer Operator'));
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));

    expect(screen.getByText(/2 cases already in progress will run to completion/)).toBeDefined();
    expect(screen.getByText(/3 competency standings become optional/)).toBeDefined();
    // A removal never advertises a creation count.
    expect(screen.queryByText(/creating/)).toBeNull();
  });

  it('saves a recommended-only edit directly, with no preview gate (R13 of the prior round)', () => {
    competencies.data = REGISTER;
    statesByScope['role:role-1'] = requirementState({ configured: false });
    renderScope(ROLE_TARGET);
    openEditor('Dozer Operator');

    fireEvent.click(recommendBox('First Aid', 'Dozer Operator'));
    expect(screen.queryByRole('button', { name: 'Review change' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(previewRequirements).not.toHaveBeenCalled();
    expect(setRequirements).toHaveBeenCalledWith(
      { required: [], recommended: ['c-b'], fingerprint: 'fp-1' },
      expect.anything(),
    );
  });

  it('blocks a tier overlap client-side — selecting in one tier moves it out of the other (KTD1)', () => {
    competencies.data = REGISTER;
    statesByScope['role:role-1'] = requirementState();
    renderScope(ROLE_TARGET);
    openEditor('Dozer Operator');

    fireEvent.click(requireBox('First Aid', 'Dozer Operator'));
    fireEvent.click(recommendBox('First Aid', 'Dozer Operator'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(setRequirements).toHaveBeenCalledWith(
      { required: [], recommended: ['c-b'], fingerprint: 'fp-1' },
      expect.anything(),
    );
  });

  it('creates a competency inline and selects it in the chosen tier', () => {
    competencies.data = REGISTER;
    statesByScope['role:role-1'] = requirementState();
    renderScope(ROLE_TARGET);
    openEditor('Dozer Operator');

    fireEvent.click(screen.getByLabelText('Create a competency for Dozer Operator'));
    fireEvent.change(screen.getByLabelText('Competency name'), { target: { value: 'Grade Control' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create & require' }));

    expect(createCompetency).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Grade Control', code: null }),
      expect.anything(),
    );
    // Pickable immediately, and already selected in the required tier.
    expect(requireBox('Grade Control', 'Dozer Operator').checked).toBe(true);
  });

  it('renders awaitingLink rows with link-me and a previewed remove (role-only, KTD6)', () => {
    previewEffects.value = {
      addedCompetencyIds: [],
      removedCompetencyIds: [],
      affected: 2,
      created: 0,
      inFlightContinuing: 1,
      competenciesDemoting: 0,
    };
    competencies.data = REGISTER;
    tools.data = [{ id: 'tool-l', name: 'Site Familiarisation v2' }];
    statesByScope['role:role-1'] = requirementState({ configured: true, awaitingLink: ['tool-l'] });
    renderScope(ROLE_TARGET);
    openEditor('Dozer Operator');

    // The legacy row is named by TOOL NAME, never a raw id.
    expect(screen.getByText('Site Familiarisation v2')).toBeDefined();

    // Link-me points the admin at the backfill panel on the register — one
    // linking flow, not a duplicate here.
    fireEvent.click(screen.getByLabelText('Link the award for Site Familiarisation v2'));
    expect(navigate).toHaveBeenCalledWith('/app/competency');

    // Remove confirms through the SAME preview door…
    fireEvent.click(screen.getByLabelText('Remove legacy requirement Site Familiarisation v2'));
    expect(previewRequirements).toHaveBeenCalledWith(
      { required: [], recommended: [], removeLegacyToolIds: ['tool-l'] },
      expect.anything(),
    );
    expect(removeLegacy).not.toHaveBeenCalled();
    expect(screen.getByText(/1 case already in progress will run to completion/)).toBeDefined();

    // …and only the confirm calls the fingerprint-guarded DELETE, addressed
    // to this role.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));
    expect(removeLegacy).toHaveBeenCalledWith(
      { toolId: 'tool-l', fingerprint: 'fp-1' },
      expect.anything(),
    );
    expect(removeLegacyRoleId).toBe('role-1');
  });

  it('reads only for a retired Role — no toggles, no review (R121 posture)', () => {
    competencies.data = REGISTER;
    statesByScope['role:role-1'] = requirementState({ configured: true, required: ['c-a'] });
    renderScope({ ...ROLE_TARGET, retired: true });
    openEditor('Dozer Operator');

    expect(screen.getByText(/no new requirements/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Review change' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(requireBox('ATO - Track Dozer', 'Dozer Operator').disabled).toBe(true);
  });
});

describe('ScopeRequirements — the same flow at org, location and department scope (U6, R1, R6)', () => {
  it('org: a required change previews (the whole-workforce radius, AE3) then applies at the org address', () => {
    competencies.data = REGISTER;
    statesByScope['org:'] = bareState();
    renderScope(ORG_TARGET);
    openEditor('the organisation');

    fireEvent.click(requireBox('First Aid', 'the organisation'));
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    expect(previewRequirements).toHaveBeenCalledWith(
      { required: ['c-b'], recommended: [] },
      expect.anything(),
    );
    expect(previewRef).toEqual({ scope: 'org' });

    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    expect(setRequirements).toHaveBeenCalledWith(
      { required: ['c-b'], recommended: [], fingerprint: 'fp-1' },
      expect.anything(),
    );
    expect(setRef).toEqual({ scope: 'org' });
  });

  it('location: a recommended-only edit saves directly, addressed to the location', () => {
    competencies.data = REGISTER;
    statesByScope['location:loc-b'] = bareState();
    renderScope(LOCATION_TARGET);
    openEditor('Boddington');

    fireEvent.click(recommendBox('Site Induction', 'Boddington'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(previewRequirements).not.toHaveBeenCalled();
    expect(setRequirements).toHaveBeenCalledWith(
      { required: [], recommended: ['c-c'], fingerprint: 'fp-1' },
      expect.anything(),
    );
    expect(setRef).toEqual({ scope: 'location', scopeId: 'loc-b' });
  });

  it('department: the preview → confirm gate holds, addressed to the department', () => {
    competencies.data = REGISTER;
    statesByScope['department:dep-1'] = bareState();
    renderScope(DEPARTMENT_TARGET);
    openEditor('Operations');

    fireEvent.click(requireBox('ATO - Track Dozer', 'Operations'));
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    expect(setRequirements).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    expect(setRef).toEqual({ scope: 'department', scopeId: 'dep-1' });
  });

  it('reloads with the notice on a stale-fingerprint 409 at a non-role scope too (KTD7)', () => {
    writeError.value = new ApiError(409, { error: 'requirements_changed' });
    competencies.data = REGISTER;
    statesByScope['location:loc-b'] = bareState();
    renderScope(LOCATION_TARGET);
    openEditor('Boddington');

    fireEvent.click(requireBox('First Aid', 'Boddington'));
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));

    // The other change survives: the editor refetches, drops the draft, and
    // says why — never a silent overwrite.
    expect(refetchRequirements).toHaveBeenCalled();
    expect(screen.getByText(/Requirements changed elsewhere/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Confirm change' })).toBeNull();
  });

  it('reads only for a retired location (scope_retired posture)', () => {
    competencies.data = REGISTER;
    statesByScope['location:loc-x'] = bareState({ required: ['c-c'] });
    renderScope({ scope: 'location', scopeId: 'loc-x', name: 'Old Pit', retired: true });
    openEditor('Old Pit');

    expect(screen.getByText(/no new requirements/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(requireBox('Site Induction', 'Old Pit').disabled).toBe(true);
  });
});

describe('ScopeRequirements — the inherited display and the location lens (U6, R9, KTD9)', () => {
  it('renders locked, source-named chips with the population copy on the role editor', () => {
    competencies.data = REGISTER;
    statesByScope['role:role-1'] = requirementState({ configured: true });
    statesByScope['org:'] = bareState({ required: ['c-b'] });
    statesByScope['department:dep-1'] = bareState({ required: ['c-a'] });
    renderScope(ROLE_TARGET);
    openEditor('Dozer Operator');

    // The population premise is stated (R3): without a lens, department only.
    expect(screen.getByText('for a member placed in Operations')).toBeDefined();

    const inherited = screen.getByLabelText('Inherited requirements for Dozer Operator');
    expect(within(inherited).getByText('First Aid')).toBeDefined();
    expect(within(inherited).getByText('from org-wide')).toBeDefined();
    expect(within(inherited).getByText('ATO - Track Dozer')).toBeDefined();
    expect(within(inherited).getByText('from Operations')).toBeDefined();
    // Locked: nothing in the inherited block is a control (R9).
    expect(within(inherited).queryAllByRole('checkbox').length).toBe(0);
    expect(within(inherited).queryAllByRole('button').length).toBe(0);
  });

  it('required beats recommended across inherited scopes, sourced to the requiring scope (R2)', () => {
    competencies.data = REGISTER;
    statesByScope['role:role-1'] = requirementState({ configured: true });
    statesByScope['org:'] = bareState({ recommended: ['c-a'] });
    statesByScope['department:dep-1'] = bareState({ required: ['c-a'] });
    renderScope(ROLE_TARGET);
    openEditor('Dozer Operator');

    const inherited = screen.getByLabelText('Inherited requirements for Dozer Operator');
    // One chip, not two — and it names the REQUIRING scope, not the recommender.
    expect(within(inherited).getAllByText('ATO - Track Dozer').length).toBe(1);
    expect(within(inherited).getByText('from Operations')).toBeDefined();
    expect(within(inherited).queryByText(/recommended/)).toBeNull();
  });

  it('the lens lists only active locations and swaps the displayed stack — display only', () => {
    competencies.data = REGISTER;
    statesByScope['role:role-1'] = requirementState({ configured: true });
    statesByScope['org:'] = bareState();
    statesByScope['department:dep-1'] = bareState();
    statesByScope['location:loc-b'] = bareState({ required: ['c-c'] });
    renderScope(ROLE_TARGET);
    openEditor('Dozer Operator');

    const lens = screen.getByLabelText('Location lens for Dozer Operator') as HTMLSelectElement;
    // Defaults to unselected; retired locations are not offered.
    expect(lens.value).toBe('');
    const options = Array.from(lens.options).map((o) => o.label);
    expect(options).toContain('Boddington');
    expect(options).not.toContain('Old Pit');
    // No lens: nothing inherited yet, so no chip container at all — the
    // picker's own 'Site Induction' option row is a control, not a chip.
    expect(screen.queryByLabelText('Inherited requirements for Dozer Operator')).toBeNull();
    expect(screen.getByText('Nothing inherited')).toBeDefined();

    fireEvent.change(lens, { target: { value: 'loc-b' } });
    expect(screen.getByText('for a member placed in Operations at Boddington')).toBeDefined();
    const inherited = screen.getByLabelText('Inherited requirements for Dozer Operator');
    expect(within(inherited).getByText('Site Induction')).toBeDefined();
    expect(within(inherited).getByText('from Boddington')).toBeDefined();
    // Swapping the lens away removes the location's rows again.
    fireEvent.change(lens, { target: { value: '' } });
    expect(screen.getByText('for a member placed in Operations')).toBeDefined();
    expect(screen.queryByText('from Boddington')).toBeNull();
    // Display only: the lens changed no draft, so there is nothing to save.
    expect(setRequirements).not.toHaveBeenCalled();
    expect(previewRequirements).not.toHaveBeenCalled();
  });

  it('derives the KTD9 summary — "requires nothing of its own · N inherited"', () => {
    competencies.data = REGISTER;
    statesByScope['role:role-1'] = requirementState({ configured: true, required: [] });
    statesByScope['org:'] = bareState({ required: ['c-b'] });
    statesByScope['department:dep-1'] = bareState({ required: ['c-a'] });
    renderScope(ROLE_TARGET);

    expect(screen.getByText(/requires nothing of its own · 2 inherited/)).toBeDefined();
  });

  it('appends the inherited count to "not set up" too — the case KTD9 was written for', () => {
    /*
      A never-configured role is EXACTLY where the inherited stack is doing all
      the work. "not set up" alone reads as "this role owes nothing", which is
      the false conclusion KTD9 named: the org and the department may already
      oblige its holders. The flag half is unchanged — R50's never-set-up vs
      deliberately-empty distinction still shows — the inherited count is added
      beside it.
    */
    competencies.data = REGISTER;
    statesByScope['role:role-1'] = requirementState({ configured: false, required: [] });
    statesByScope['org:'] = bareState({ required: ['c-b'] });
    statesByScope['department:dep-1'] = bareState({ required: ['c-a'] });
    renderScope(ROLE_TARGET);

    expect(screen.getByText(/not set up · 2 inherited/)).toBeDefined();
  });

  it('keeps the plain "requires nothing" while the inherited sets are unfetched (KTD9 lazy)', () => {
    statesByScope['role:role-1'] = requirementState({ configured: true, required: [] });
    // No org/department states: the editor was never expanded, nothing
    // inherited has been fetched — the own-list summary stands.
    renderScope(ROLE_TARGET);
    expect(screen.getByText(/requires nothing/)).toBeDefined();
    expect(screen.queryByText(/inherited/)).toBeNull();
  });

  it('renders one identical "Nothing inherited" line on all four editor types', () => {
    competencies.data = REGISTER;
    statesByScope['role:role-1'] = requirementState({ configured: true });
    statesByScope['org:'] = bareState();
    statesByScope['department:dep-1'] = bareState();
    statesByScope['location:loc-b'] = bareState();

    for (const target of [ORG_TARGET, LOCATION_TARGET, DEPARTMENT_TARGET, ROLE_TARGET]) {
      const { unmount } = renderScope(target);
      openEditor(target.name);
      expect(screen.getByText('Nothing inherited')).toBeDefined();
      unmount();
    }
  });
});
