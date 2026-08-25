// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type {
  RetirementReview,
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
}));

/*
  The requirements editor is ITS OWN component since the U6 extraction — its
  behaviour lives in ScopeRequirements.test.tsx. Here it is stubbed to a
  marker so this suite pins exactly what the SCREEN owns: that an editor is
  MOUNTED for every scope, addressed with the right target (R1, R9).
*/
vi.mock('./ScopeRequirements.js', () => ({
  ScopeRequirements: ({
    target,
  }: {
    target: { scope: string; scopeId?: string; name: string; departmentId?: string };
  }) => (
    <div>{`requirements-editor:${target.scope}:${target.scopeId ?? ''}:${target.name}${
      target.departmentId ? `:dep=${target.departmentId}` : ''
    }`}</div>
  ),
}));

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

afterEach(() => {
  vi.clearAllMocks();
  taxonomy.data = undefined;
  taxonomy.isLoading = false;
  tighteningReview.data = undefined;
  retirementReview.data = undefined;
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

describe('TaxonomyScreen — a requirements editor mounts at every scope (U6, R1, R9)', () => {
  it('mounts the org editor in its own panel between Settings and Locations', () => {
    taxonomy.data = base();
    render(<TaxonomyScreen />);
    const heading = screen.getByText('Organisation-wide requirements');
    expect(screen.getByText('requirements-editor:org::the organisation')).toBeDefined();
    // Between Settings and Locations: after the settings heading, before the
    // locations heading, in document order (U6's placement).
    const settings = screen.getByText('Organisation settings');
    const locations = screen.getByText('Locations');
    expect(settings.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heading.compareDocumentPosition(locations) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('mounts one editor per Location row, carrying its retired state', () => {
    taxonomy.data = {
      ...base(),
      locations: [
        { id: 'loc-1', name: 'Boddington', status: 'active', createdAt: '' },
        { id: 'loc-2', name: 'Old Pit', status: 'retired', createdAt: '' },
      ],
    };
    render(<TaxonomyScreen />);
    expect(screen.getByText('requirements-editor:location:loc-1:Boddington')).toBeDefined();
    expect(screen.getByText('requirements-editor:location:loc-2:Old Pit')).toBeDefined();
  });

  it('mounts the Department editor above its Roles, and the Role editor named with its department (R3, R9)', () => {
    taxonomy.data = withOneRole();
    render(<TaxonomyScreen />);
    const dep = screen.getByText('requirements-editor:department:dep-1:Operations');
    // The role target carries departmentId — the inherited-population premise
    // the role editor's locked context is modelled on (R3).
    const role = screen.getByText('requirements-editor:role:role-1:Dozer Operator:dep=dep-1');
    expect(dep.compareDocumentPosition(role) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
