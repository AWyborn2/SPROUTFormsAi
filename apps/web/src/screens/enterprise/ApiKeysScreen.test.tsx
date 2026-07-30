// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ApiKey, CreatedApiKey } from '../../lib/data/types.js';

const listResult: { data: ApiKey[]; isLoading: boolean } = { data: [], isLoading: false };
const createMutate = vi.fn();
const revokeMutate = vi.fn();
let sessionRole = 'owner';

vi.mock('../../lib/data/hooks.js', () => ({
  useApiKeys: () => listResult,
  useSession: () => ({ data: { role: sessionRole } }),
  useCreateApiKey: () => ({ mutate: createMutate, isPending: false }),
  useRevokeApiKey: () => ({ mutate: revokeMutate, isPending: false }),
}));

const toast = vi.fn();
vi.mock('@formai/ui', async () => {
  const actual = await vi.importActual<typeof import('@formai/ui')>('@formai/ui');
  return { ...actual, useToast: () => ({ toast }) };
});

const { ApiKeysScreen } = await import('./ApiKeysScreen.js');

const LIVE_KEY: ApiKey = {
  id: 'key-1',
  name: 'Induction agent',
  role: 'Reviewer',
  prefix: 'a1b2c3',
  createdAt: '2026-07-01T00:00:00.000Z',
  lastUsedAt: '2026-07-20T00:00:00.000Z',
  revokedAt: null,
};

function created(key: string): CreatedApiKey {
  return { ...LIVE_KEY, id: 'key-new', name: 'New agent', key };
}

afterEach(() => {
  vi.clearAllMocks();
  listResult.data = [];
  listResult.isLoading = false;
  sessionRole = 'owner';
});

describe('ApiKeysScreen', () => {
  it('lists keys by prefix and never renders a full key for an existing row', () => {
    listResult.data = [LIVE_KEY];
    render(<ApiKeysScreen />);

    expect(screen.getByText('Induction agent')).toBeDefined();
    expect(screen.getByText('fai_a1b2c3…')).toBeDefined();
    // Nothing that looks like a whole credential — the list has no secret half.
    expect(document.body.textContent).not.toMatch(/fai_[0-9a-f]+_[0-9a-f]+/);
  });

  it('marks a revoked key and offers no revoke control for it', () => {
    listResult.data = [{ ...LIVE_KEY, revokedAt: '2026-07-25T00:00:00.000Z' }];
    render(<ApiKeysScreen />);

    expect(screen.getByText('Revoked')).toBeDefined();
    expect(screen.queryByLabelText('Revoke Induction agent')).toBeNull();
  });

  it('shows the plaintext once and removes it from the DOM when dismissed', () => {
    const plaintext = 'fai_a1b2c3_deadbeefdeadbeef';
    createMutate.mockImplementation((_input, opts) => opts.onSuccess(created(plaintext)));
    render(<ApiKeysScreen />);

    fireEvent.click(screen.getByRole('button', { name: /new key/i }));
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'New agent' } });
    fireEvent.click(screen.getByRole('button', { name: /create key/i }));

    expect(screen.getByText(plaintext)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    expect(document.body.textContent).not.toContain(plaintext);
  });

  it('refuses to submit a nameless key and warns instead', () => {
    render(<ApiKeysScreen />);
    fireEvent.click(screen.getByRole('button', { name: /new key/i }));
    fireEvent.click(screen.getByRole('button', { name: /create key/i }));

    expect(createMutate).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'warning' }));
  });

  it('explains a 403 rather than reporting a generic failure', () => {
    createMutate.mockImplementation((_input, opts) => opts.onError({ status: 403 }));
    render(<ApiKeysScreen />);

    fireEvent.click(screen.getByRole('button', { name: /new key/i }));
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Escalation' } });
    fireEvent.click(screen.getByRole('button', { name: /create key/i }));

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'danger', message: expect.stringContaining('more authority') }),
    );
  });

  it('asks before revoking, and only calls the mutation on confirm', () => {
    listResult.data = [LIVE_KEY];
    render(<ApiKeysScreen />);

    fireEvent.click(screen.getByLabelText('Revoke Induction agent'));
    expect(revokeMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /revoke key/i }));
    expect(revokeMutate).toHaveBeenCalledWith('key-1', expect.anything());
  });

  it('is read-only for a member who cannot manage the team', () => {
    sessionRole = 'viewer';
    listResult.data = [LIVE_KEY];
    render(<ApiKeysScreen />);

    expect(screen.queryByRole('button', { name: /new key/i })).toBeNull();
    expect(screen.queryByLabelText('Revoke Induction agent')).toBeNull();
    expect(screen.getByText('Induction agent')).toBeDefined();
  });
});
