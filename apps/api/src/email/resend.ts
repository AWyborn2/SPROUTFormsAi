import { Resend } from 'resend';
import { env } from '../env.js';

let client: Resend | null = null;

/**
 * Lazily construct the Resend client. Returns null when no key is configured —
 * mirrors `getAnthropic()`'s fail-soft pattern so invite
 * creation still succeeds (reporting `emailSent: false`) when email delivery
 * isn't set up. The key lives only in the API env and never reaches the client.
 */
export function getResend(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!client) client = new Resend(env.RESEND_API_KEY);
  return client;
}

export interface InviteEmailInput {
  to: string;
  orgName: string;
  inviterName: string;
  /** Carries the invite token — the only thing that authorizes joining. */
  acceptUrl: string;
}

/**
 * Sends the team-invite email. Best-effort by design: returns `false` (never
 * throws) when Resend is unconfigured, the API reports an error, or the send
 * rejects — callers report delivery via `emailSent` without ever coupling row
 * persistence to email infrastructure.
 */
export async function sendInviteEmail(input: InviteEmailInput): Promise<boolean> {
  const resend = getResend();
  if (!resend) return false;
  try {
    const { error } = await resend.emails.send({
      from: env.RESEND_FROM_EMAIL,
      to: input.to,
      subject: `You've been invited to ${input.orgName} on FormAI`,
      text: [
        `${input.inviterName} has invited you to join ${input.orgName} on FormAI.`,
        '',
        'To accept, open this link and sign in:',
        input.acceptUrl,
        '',
        `The link is personal to this invite — don't forward it, since anyone`,
        `who opens it can join ${input.orgName} as you.`,
        '',
        `If you weren't expecting this invite, you can ignore this email.`,
      ].join('\n'),
    });
    return !error;
  } catch {
    return false;
  }
}

export interface PooledCaseNoticeInput {
  to: string;
  /** The tool whose case has been invalidated and returned to the shared queue. */
  toolName: string;
  /** Whose case it was — named so an assessor recognises the work. */
  candidateName: string;
}

/**
 * Notify an eligible assessor that a pooled case has been invalidated and is
 * back in the shared queue (U18, R130). Best-effort, exactly like the invite
 * email: a missing key or a failed send returns `false` and never throws, so a
 * deactivation's remediation is never blocked by email infrastructure. This is
 * the higher-volume of the product's transactional emails — it fans out to every
 * eligible assessor at a Location rather than to one recipient.
 */
export async function sendPooledCaseNoticeEmail(input: PooledCaseNoticeInput): Promise<boolean> {
  const resend = getResend();
  if (!resend) return false;
  try {
    const { error } = await resend.emails.send({
      from: env.RESEND_FROM_EMAIL,
      to: input.to,
      subject: `A ${input.toolName} case is back in the shared queue`,
      text: [
        `A ${input.toolName} assessment for ${input.candidateName} has been`,
        `invalidated and returned to the shared queue for your Location.`,
        '',
        `You are eligible to pick it up. Open FormAI to take it on when you can.`,
      ].join('\n'),
    });
    return !error;
  } catch {
    return false;
  }
}
