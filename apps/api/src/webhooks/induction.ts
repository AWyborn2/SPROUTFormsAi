/**
 * Outbound notification when an induction intake lands.
 *
 * The problem this solves: nothing on the server told anyone a CHC intake had
 * been submitted. The intake screen offers a `mailto:` link, which opens the
 * *submitter's* mail client — so the person who has to act on the form only
 * hears about it if the person filling it in happens to click. A form could sit
 * unseen past its Thursday booking cutoff, which costs the starter a week.
 *
 * The target this was built for is a Power Automate HTTP trigger, and two of
 * its properties shape everything here:
 *
 *  - **The URL is the credential.** Power Automate puts its authorisation in
 *    the query string, so anyone holding the URL can fire the flow. It is
 *    stored per-org, never returned in full by the API, and never logged.
 *  - **It is an address an org admin chose**, which makes this an SSRF surface
 *    exactly like the brand scan. It reuses `safeFetch` rather than calling
 *    `fetch` directly, so the scheme allowlist, address classification and
 *    connection pinning are the same code, not a second implementation that
 *    drifts.
 *
 * Redirects are refused outright (`maxRedirects: 0`). Following one would
 * re-send the payload to a host the admin never nominated, and a webhook
 * endpoint that redirects is misconfigured — better to fail where someone can
 * see it than to deliver somewhere unintended.
 */
import type { AssessedStarter } from '@formai/shared';
import { safeFetch, SafeFetchError } from '../brand-scan/safe-fetch.js';

/** Short: a form submission must not wait on someone else's HTTP endpoint. */
const WEBHOOK_TIMEOUT_MS = 5000;

/**
 * What the receiving flow is told.
 *
 * Deliberately the booking-shaped view and nothing more. Date of birth, home
 * address, licence number and emergency contact are all on the intake and none
 * of them are here: this payload crosses into a system outside the product's
 * control, so it carries what is needed to say "someone needs mobilising" and
 * stops there. Anything further is fetched back through the authenticated API,
 * where the export grant applies.
 */
export interface InductionWebhookPayload {
  event: 'induction_intake.submitted';
  submissionId: string;
  submittedAt: string;
  submittedBy: { name: string; email: string; verified: boolean };
  starter: {
    fullName: string;
    inductionDate: string;
    department: string;
    roles: string[];
  };
  readiness: AssessedStarter['readiness'];
  blockers: AssessedStarter['blockers'];
  warnings: AssessedStarter['warnings'];
}

/**
 * A form safe to show a human or write to an audit row.
 *
 * Keeps the origin and path shape so an admin can recognise which endpoint is
 * configured, and drops the query string entirely because that is where Power
 * Automate's signature lives.
 */
export function maskWebhookUrl(raw: string): string {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}${url.search ? '?…' : ''}`;
  } catch {
    return '(unparseable url)';
  }
}

export type WebhookOutcome =
  | { delivered: true; status: number }
  | { delivered: false; reason: string };

/**
 * Deliver the notification. Never throws.
 *
 * Fail-soft is the whole contract, and it is load-bearing rather than
 * defensive: the submission is already committed by the time this runs, and a
 * Power Automate outage must not turn a successful intake into a 500 that
 * tells the filler their form did not save. Mirrors `sendInviteEmail`, which
 * reports delivery instead of coupling row persistence to email infrastructure.
 *
 * The returned reason is for an audit row and never contains the URL.
 */
export async function sendInductionWebhook(
  url: string,
  payload: InductionWebhookPayload,
): Promise<WebhookOutcome> {
  if (!url) return { delivered: false, reason: 'not_configured' };

  try {
    const res = await safeFetch(url, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
      timeoutMs: WEBHOOK_TIMEOUT_MS,
      maxRedirects: 0,
      // The response is not used for anything; cap it low so a misconfigured
      // endpoint answering with a web page cannot make us read it all.
      maxBytes: 64 * 1024,
    });
    if (res.status >= 200 && res.status < 300) return { delivered: true, status: res.status };
    return { delivered: false, reason: `http_${res.status}` };
  } catch (err) {
    // `SafeFetchError.message` can quote the URL it refused; report the code
    // only, so a webhook secret cannot reach an audit row or a log line.
    if (err instanceof SafeFetchError) return { delivered: false, reason: err.code };
    return { delivered: false, reason: 'request_failed' };
  }
}
