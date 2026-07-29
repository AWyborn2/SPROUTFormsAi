import { z } from 'zod';
import type { InductionsClient } from '../client.js';
import { defineTool, ISO_DATE, ok, type ToolHost } from './host.js';

export const recordBookingInput = z.object({
  date: z.string().regex(ISO_DATE, 'Use YYYY-MM-DD').describe('The induction Monday that was booked.'),
  submissionIds: z
    .array(z.string().min(1))
    .min(1)
    .max(50)
    .describe('The starters the booking covers, by submission id.'),
  externalReference: z
    .string()
    .max(200)
    .optional()
    .describe('The booking handle in the external system, e.g. a BISTrainer transaction reference.'),
  note: z.string().max(500).optional(),
  noticeOverrideReason: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      'Why the site accepted a booking inside the four-business-day notice window. Required ' +
      'when any starter is short-notice — the API refuses without it. Record what the human ' +
      'actually decided (who agreed, and on what basis); never invent a justification.',
    ),
});

export const listBookingsInput = z.object({
  date: z.string().regex(ISO_DATE, 'Use YYYY-MM-DD').optional(),
});

export function registerBookingTools(host: ToolHost, client: InductionsClient): void {
  defineTool(
    host,
    'record_induction_booking',
    {
      title: 'Record an induction booking',
      description:
        'Records that a cohort has been booked. Call this AFTER the booking actually exists ' +
        'in the external system, never before — it is the record of a booking, not a request ' +
        'for one. Every starter must share the booking date. An already_booked error means a ' +
        'starter is covered by an existing booking; re-read the candidates rather than ' +
        'retrying, because a repeat call will never succeed for that person. A ' +
        'notice_override_required error means a starter is inside the notice window: stop and ' +
        'ask the human whether the site has agreed to it, then pass their answer as ' +
        'noticeOverrideReason.',
      inputSchema: recordBookingInput,
    },
    async (args) => ok(await client.recordBooking(args)),
  );

  defineTool(
    host,
    'list_induction_bookings',
    {
      title: 'List induction bookings',
      description:
        'Bookings already recorded, newest first. Check here before booking a date to see ' +
        'whether a cohort has already gone through.',
      inputSchema: listBookingsInput,
    },
    async (args) => ok(await client.listBookings(args.date)),
  );
}
