// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Taxonomy } from '../../lib/data/types.js';

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
const updateSettings = vi.fn();
const setRequirements = vi.fn();
const tools: { data: Array<{ id: string; name: string }> } = { data: [] };
const roleRequirements: { data: { configured: boolean; toolIds: string[] } | undefined } = {
  data: undefined,
};
// The preview mutation resolves with the effects the confirmation panel shows.
const previewEffects: { value: Record<string, unknown> } = {
  value: {
    addedToolIds: ['tool-a'],
    removedToolIds: [],
    affected: 3,
    created: 2,
    inFlightContinuing: 0,
    competenciesDemoting: 0,
  },
};
const previewRequirements = vi.fn(
  (_ids: string[], opts?: { onSuccess?: (r: { effects: Record<string, unknown> }) => void }) =>
    opts?.onSuccess?.({ effects: previewEffects.value }),
);

vi.mock('../../lib/data/hooks.js', () => ({
  useTaxonomy: () => taxonomy,
  useCreateLocation: () => ({ mutate: createLocation }),
  useUpdateLocation: () => ({ mutate: updateLocation }),
  useCreateDepartment: () => ({ mutate: createDepartment }),
  useUpdateDepartment: () => ({ mutate: updateDepartment }),
  useCreateRole: () => ({ mutate: createRole }),
  useUpdateRole: () => ({ mutate: updateRole }),
  useUpdateTaxonomySettings: () => ({ mutate: updateSettings }),
  useAssessmentTools: () => tools,
  useRoleRequiredAssessments: () => roleRequirements,
  usePreviewRoleRequiredAssessments: () => ({ mutate: previewRequirements, isPending: false }),
  useSetRoleRequiredAssessments: () => ({ mutate: setRequirements, isPending: false }),
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
      displayIdentifier: 'employee_number',
      pooledCaseOverdueDays: 14,
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
  taxonomy.data = undefined;
  taxonomy.isLoading = false;
  tools.data = [];
  roleRequirements.data = undefined;
  previewEffects.value = {
    addedToolIds: ['tool-a'],
    removedToolIds: [],
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

  it('creates a Location from the add field', () => {
    taxonomy.data = base();
    render(<TaxonomyScreen />);
    fireEvent.change(screen.getByLabelText('New location name'), { target: { value: 'Raw Materials' } });
    const panel = screen.getByText('Locations').closest('div')!;
    fireEvent.click(within(panel).getByRole('button', { name: 'Add' }));
    expect(createLocation).toHaveBeenCalledWith('Raw Materials', expect.anything());
  });
});

describe('TaxonomyScreen — a Role’s required assessments (U10)', () => {
  const openEditor = () =>
    fireEvent.click(screen.getByLabelText('Required assessments for Dozer Operator'));

  it('shows "not set up" apart from "requires nothing" (R50)', () => {
    taxonomy.data = withOneRole();

    roleRequirements.data = { configured: false, toolIds: [] };
    const { rerender } = render(<TaxonomyScreen />);
    expect(screen.getByText(/not set up/)).toBeDefined();

    roleRequirements.data = { configured: true, toolIds: [] };
    rerender(<TaxonomyScreen />);
    expect(screen.getByText(/requires nothing/)).toBeDefined();
  });

  it('reviews the blast radius, then applies on confirm (R43, R84, R87)', () => {
    taxonomy.data = withOneRole();
    tools.data = [
      { id: 'tool-a', name: 'Track Dozer' },
      { id: 'tool-b', name: 'Excavator' },
    ];
    roleRequirements.data = { configured: false, toolIds: [] };
    render(<TaxonomyScreen />);
    openEditor();

    fireEvent.click(screen.getByRole('button', { name: 'Track Dozer' }));
    // Save now goes through a preview first — nothing is written yet.
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    expect(previewRequirements).toHaveBeenCalledWith(['tool-a'], expect.anything());
    expect(setRequirements).not.toHaveBeenCalled();

    // The blast radius is shown; confirming applies it.
    expect(screen.getByText(/affects 3 people, creating 2 cases/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    expect(setRequirements).toHaveBeenCalledWith(['tool-a'], expect.anything());
  });

  it('abandons the change on cancel, writing nothing (R86)', () => {
    taxonomy.data = withOneRole();
    tools.data = [{ id: 'tool-a', name: 'Track Dozer' }];
    roleRequirements.data = { configured: false, toolIds: [] };
    render(<TaxonomyScreen />);
    openEditor();

    fireEvent.click(screen.getByRole('button', { name: 'Track Dozer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(setRequirements).not.toHaveBeenCalled();
    // Back to the review affordance, nothing committed.
    expect(screen.getByRole('button', { name: 'Review change' })).toBeDefined();
  });

  it('describes a removal by what it changes, not what it creates (R85)', () => {
    previewEffects.value = {
      addedToolIds: [],
      removedToolIds: ['tool-a'],
      affected: 4,
      created: 0,
      inFlightContinuing: 2,
      competenciesDemoting: 3,
    };
    taxonomy.data = withOneRole();
    tools.data = [{ id: 'tool-a', name: 'Track Dozer' }];
    roleRequirements.data = { configured: true, toolIds: ['tool-a'] };
    render(<TaxonomyScreen />);
    openEditor();

    // Deselect the only tool, then review.
    fireEvent.click(screen.getByRole('button', { name: 'Track Dozer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));

    expect(screen.getByText(/2 cases already in progress will run to completion/)).toBeDefined();
    expect(screen.getByText(/3 competency standings become optional/)).toBeDefined();
    // A removal never advertises a creation count.
    expect(screen.queryByText(/creating/)).toBeNull();
  });

  it('reads only for a retired Role — no toggles, no review (R121)', () => {
    taxonomy.data = withOneRole({ status: 'retired' });
    tools.data = [{ id: 'tool-a', name: 'Track Dozer' }];
    roleRequirements.data = { configured: true, toolIds: ['tool-a'] };
    render(<TaxonomyScreen />);
    openEditor();

    expect(screen.getByText(/no new requirements/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Review change' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Track Dozer' })).toHaveProperty('disabled', true);
  });
});
