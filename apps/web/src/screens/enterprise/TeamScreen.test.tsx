// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Member } from '../../lib/data/types.js';

/*
  The chips are driven entirely by what the members read returns — counts
  present renders the group, counts null renders an empty slot — so the hooks
  are the seam, as in the sibling screen tests.
*/
let members: Member[] = [];

vi.mock('../../lib/data/hooks.js', () => ({
  useMembers: () => ({ data: members }),
  useBilling: () => ({ data: undefined }),
  useSession: () => ({ data: { role: 'admin' } }),
  useInviteMember: () => ({ mutate: vi.fn(), isPending: false }),
  useSetMemberRole: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveMember: () => ({ mutate: vi.fn(), isPending: false }),
  useIssuePasswordReset: () => ({ mutate: vi.fn(), isPending: false }),
  // PlacementDialog's hooks — imported at module scope, rendered only on demand.
  useMemberPlacement: () => ({ data: undefined }),
  useSetMemberPlacement: () => ({ mutate: vi.fn(), isPending: false }),
  useTaxonomy: () => ({ data: undefined }),
}));

vi.mock('react-router-dom', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('@formai/ui', async () => {
  const actual = await vi.importActual<typeof import('@formai/ui')>('@formai/ui');
  return { ...actual, useToast: () => ({ toast: vi.fn() }) };
});

const { TeamScreen } = await import('./TeamScreen.js');

const MEMBER: Member = {
  id: 'm1',
  userId: 'u1',
  name: 'Bo Worker',
  email: 'bo@x.io',
  role: 'Candidate',
  status: 'active',
  counts: null,
};

afterEach(() => {
  vi.clearAllMocks();
  members = [];
});

describe('TeamScreen — competency count chips (R1, R3, R4)', () => {
  it('renders current, attention and muted optional counts on a row (AE1)', () => {
    members = [
      { ...MEMBER, counts: { requiredCurrent: 4, requiredAttention: 1, optionalLapsed: 1 } },
    ];
    render(<TeamScreen />);
    expect(screen.getByText('4 current')).toBeDefined();
    expect(screen.getByText('1 due')).toBeDefined();
    expect(screen.getByText('1 optional')).toBeDefined();
  });

  it('renders no chip group when the API withheld counts (R4)', () => {
    members = [MEMBER];
    render(<TeamScreen />);
    expect(screen.queryByText(/current/)).toBeNull();
  });

  it('renders no zero chips for attention or optional — zero means quiet', () => {
    members = [
      { ...MEMBER, counts: { requiredCurrent: 3, requiredAttention: 0, optionalLapsed: 0 } },
    ];
    render(<TeamScreen />);
    expect(screen.getByText('3 current')).toBeDefined();
    expect(screen.queryByText(/due/)).toBeNull();
    expect(screen.queryByText(/optional/)).toBeNull();
  });

  it('links the chip group to the member record (R3)', () => {
    members = [
      { ...MEMBER, counts: { requiredCurrent: 4, requiredAttention: 1, optionalLapsed: 0 } },
    ];
    render(<TeamScreen />);
    const link = screen.getByText('4 current').closest('a');
    expect(link?.getAttribute('href')).toBe('/app/profile/m1');
  });
});
