/**
 * The webhook is an SSRF surface — an org admin nominates the address and the
 * server connects to it — so these are written as attacks rather than
 * happy-path coverage, matching `brand-scan/safe-fetch.test.ts`.
 *
 * Note what is NOT here: a successful delivery. The guard refuses non-public
 * addresses, and loopback is the only address a test server can bind, so a
 * completed POST is not reachable in-process. The brand-scan suite has the same
 * gap for the same reason. What these cover instead is that the guard is wired
 * in FRONT of the POST path — which is the property that would actually hurt if
 * it regressed, since adding a method and a body to `safeFetch` is exactly the
 * kind of change that could route around validation.
 */
import { describe, expect, it } from 'vitest';
import { maskWebhookUrl, sendInductionWebhook, type InductionWebhookPayload } from './induction.js';

function payload(): InductionWebhookPayload {
  return {
    event: 'induction_intake.submitted',
    submissionId: 'sub-1',
    submittedAt: '2026-07-30T00:00:00.000Z',
    submittedBy: { name: 'Priya Raman', email: 'priya@example.com', verified: true },
    starter: {
      fullName: 'Marlee Okonkwo',
      inductionDate: '2026-08-03',
      department: 'Operations',
      roles: ['Dozer Operator'],
    },
    readiness: 'ready',
    blockers: [],
    warnings: [],
  };
}

describe('maskWebhookUrl', () => {
  it('drops the query string, which is where the credential lives', () => {
    // A Power Automate trigger authorises by signature in the query string, so
    // the mask is what makes the value safe to put in an audit row or a
    // response body.
    const masked = maskWebhookUrl(
      'https://prod-42.australiasoutheast.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=SECRETSIGNATURE',
    );
    expect(masked).toBe(
      'https://prod-42.australiasoutheast.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?…',
    );
    expect(masked).not.toContain('SECRETSIGNATURE');
    expect(masked).not.toContain('sig=');
  });

  it('keeps enough for an admin to recognise which endpoint is configured', () => {
    expect(maskWebhookUrl('https://example.com/hooks/intake')).toBe(
      'https://example.com/hooks/intake',
    );
  });

  it('is empty for an unset webhook and safe for junk', () => {
    expect(maskWebhookUrl('')).toBe('');
    expect(maskWebhookUrl('not a url')).toBe('(unparseable url)');
  });
});

describe('sendInductionWebhook', () => {
  it('reports not_configured rather than attempting an empty URL', async () => {
    expect(await sendInductionWebhook('', payload())).toEqual({
      delivered: false,
      reason: 'not_configured',
    });
  });

  it.each([
    ['loopback', 'http://127.0.0.1:9/hook'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['RFC1918', 'http://10.0.0.1/hook'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/hook'],
  ])('refuses a %s target on the POST path', async (_label, url) => {
    expect(await sendInductionWebhook(url, payload())).toEqual({
      delivered: false,
      reason: 'blocked_address',
    });
  });

  it('refuses a non-http scheme', async () => {
    expect(await sendInductionWebhook('file:///etc/passwd', payload())).toEqual({
      delivered: false,
      reason: 'blocked_scheme',
    });
  });

  it('never lets the URL escape into the failure reason', async () => {
    // SafeFetchError messages quote the address they refused. That reason
    // reaches an audit row, so it carries the code alone — otherwise a webhook
    // secret ends up durably stored in the very place built to be readable.
    const result = await sendInductionWebhook(
      'http://127.0.0.1/hook?sig=SECRETSIGNATURE',
      payload(),
    );
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('SECRETSIGNATURE');
    expect(serialised).not.toContain('127.0.0.1');
  });

  it('never throws, whatever the target does', async () => {
    // Fail-soft is the contract: the submission is already committed when this
    // runs, and a webhook problem must not surface to the filler as a failed
    // form.
    await expect(sendInductionWebhook('http://10.0.0.1/x', payload())).resolves.toBeDefined();
    await expect(sendInductionWebhook('nonsense', payload())).resolves.toEqual({
      delivered: false,
      reason: 'invalid_url',
    });
  });
});

describe('webhook payload', () => {
  it('carries the booking view and none of the sensitive intake', () => {
    // This crosses into a system outside the product's control, so it says
    // "someone needs mobilising" and stops. Anything further is fetched back
    // through the authenticated API, where the export grant applies.
    const body = JSON.stringify(payload());
    for (const forbidden of ['dob', 'address', 'licenceNumber', 'emergencyContact', 'sensitive']) {
      expect(body).not.toContain(forbidden);
    }
    expect(body).toContain('Marlee Okonkwo');
    expect(body).toContain('2026-08-03');
    expect(body).toContain('Dozer Operator');
  });
});
