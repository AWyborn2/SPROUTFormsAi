// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { PermState } from '../../lib/data/types.js';

const rolesResult: { data: PermState | undefined } = { data: undefined };
const membersResult: { data: Array<{ role: string }> } = { data: [] };
const toggleMutate = vi.fn();

vi.mock('../../lib/data/hooks.js', () => ({
  useMembers: () => membersResult,
  useRoles: () => rolesResult,
  useTogglePermission: () => ({ mutate: toggleMutate }),
}));

const toast = vi.fn();
vi.mock('@formai/ui', async () => {
  const actual = await vi.importActual<typeof import('@formai/ui')>('@formai/ui');
  return { ...actual, useToast: () => ({ toast }) };
});

const { RolesScreen } = await import('./RolesScreen.js');

/** A full seven-level matrix, as the API's GET now returns (stored-or-default). */
function fullPerms(): PermState {
  const empty = { forms: {}, submissions: {}, team: {}, billing: {}, audit: {}, assessments: {} };
  return {
    Owner: { ...empty, forms: { view: true, create: true, edit: true, delete: true } },
    Admin: { ...empty },
    Builder: { ...empty },
    Reviewer: { ...empty },
    Viewer: { ...empty },
    Assessor: {
      forms: { view: true },
      submissions: { view: true, export: true },
      team: { view: true },
      billing: {},
      audit: {},
      assessments: { view: true, create: true, edit: true, delete: false, export: true },
    },
    Candidate: {
      forms: {},
      submissions: {},
      team: {},
      billing: {},
      audit: {},
      assessments: { view: 'own', edit: 'own', create: false, delete: false, export: false },
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
  rolesResult.data = undefined;
  membersResult.data = [];
});

describe('RolesScreen', () => {
  it('renders all seven access levels in the rail (R28, R29)', () => {
    rolesResult.data = fullPerms();
    render(<RolesScreen />);
    for (const level of ['Owner', 'Admin', 'Builder', 'Reviewer', 'Viewer', 'Assessor', 'Candidate']) {
      expect(screen.getByText(level)).toBeDefined();
    }
  });

  it('shows the Assessor`s assessment grants (R30)', () => {
    rolesResult.data = fullPerms();
    render(<RolesScreen />);
    fireEvent.click(screen.getByText('Assessor'));
    const createSwitch = screen.getByLabelText('Assessments · Create for Assessor') as HTMLInputElement;
    expect(createSwitch.checked).toBe(true);
    const deleteSwitch = screen.getByLabelText('Assessments · Delete for Assessor') as HTMLInputElement;
    expect(deleteSwitch.checked).toBe(false);
  });

  it('renders a Candidate scoped grant as "Own only", not a toggle (R31)', () => {
    rolesResult.data = fullPerms();
    render(<RolesScreen />);
    fireEvent.click(screen.getByText('Candidate'));
    // The scoped view grant shows as a distinct marker.
    expect(screen.getAllByText('Own only').length).toBeGreaterThan(0);
    // And it is NOT a switch that could be toggled to full access.
    expect(screen.queryByLabelText('Assessments · View for Candidate')).toBeNull();
  });

  it('locks the Owner row', () => {
    rolesResult.data = fullPerms();
    render(<RolesScreen />);
    fireEvent.click(screen.getByText('Owner'));
    expect(screen.getByText('Locked')).toBeDefined();
  });
});
