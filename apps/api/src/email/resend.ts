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
