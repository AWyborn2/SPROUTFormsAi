import { beforeEach, describe, expect, it, vi } from 'vitest';

const resendMocks = vi.hoisted(() => ({
  send: vi.fn(),
  constructedWith: [] as string[],
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendMocks.send };
    constructor(apiKey: string) {
      resendMocks.constructedWith.push(apiKey);
    }
  },
}));

const envState = vi.hoisted(() => ({
  env: {
    RESEND_API_KEY: undefined as string | undefined,
    RESEND_FROM_EMAIL: 'FormAI <invites@formai.test>',
  },
}));

vi.mock('../env.js', () => ({
  get env() {
    return envState.env;
  },
}));

/** Fresh module per test so `getResend()`'s memoized client never leaks across cases. */
async function load() {
  vi.resetModules();
  return await import('./resend.js');
}

const input = {
  to: 'sam@x.io',
  orgName: 'Meridian Operations',
  inviterName: 'Ash Wyborn',
  acceptUrl: 'http://localhost:5000/invite/tok-abc',
};

beforeEach(() => {
  resendMocks.send.mockReset();
  resendMocks.constructedWith.length = 0;
  envState.env.RESEND_API_KEY = undefined;
});

describe('getResend', () => {
  it('returns null when RESEND_API_KEY is unset', async () => {
    const { getResend } = await load();
    expect(getResend()).toBeNull();
    expect(resendMocks.constructedWith).toEqual([]);
  });

  it('constructs the client with the configured key when set', async () => {
    envState.env.RESEND_API_KEY = 're_test_123';
    const { getResend } = await load();
    expect(getResend()).not.toBeNull();
    expect(resendMocks.constructedWith).toEqual(['re_test_123']);
  });
});

describe('sendInviteEmail', () => {
  it('no-ops (returns false) without a configured client, never touching the SDK', async () => {
    const { sendInviteEmail } = await load();
    await expect(sendInviteEmail(input)).resolves.toBe(false);
    expect(resendMocks.send).not.toHaveBeenCalled();
  });

  it('sends via resend.emails.send with the invitee address and org-name subject', async () => {
    envState.env.RESEND_API_KEY = 're_test_123';
    resendMocks.send.mockResolvedValue({ data: { id: 'email-1' }, error: null });
    const { sendInviteEmail } = await load();

    await expect(sendInviteEmail(input)).resolves.toBe(true);

    expect(resendMocks.send).toHaveBeenCalledTimes(1);
    const payload = resendMocks.send.mock.calls[0]?.[0] as Record<string, string>;
    expect(payload.to).toBe('sam@x.io');
    expect(payload.from).toBe('FormAI <invites@formai.test>');
    expect(payload.subject).toContain('Meridian Operations');
    expect(payload.text).toContain('Ash Wyborn');
    // The accept link is the invite — a mail that lost it authorizes nothing.
    expect(payload.text).toContain('http://localhost:5000/invite/tok-abc');
  });

  it('returns false when the SDK reports an error object', async () => {
    envState.env.RESEND_API_KEY = 're_test_123';
    resendMocks.send.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'bad from' } });
    const { sendInviteEmail } = await load();
    await expect(sendInviteEmail(input)).resolves.toBe(false);
  });

  it('returns false (never throws) when the SDK rejects', async () => {
    envState.env.RESEND_API_KEY = 're_test_123';
    resendMocks.send.mockRejectedValue(new Error('network down'));
    const { sendInviteEmail } = await load();
    await expect(sendInviteEmail(input)).resolves.toBe(false);
  });
});
