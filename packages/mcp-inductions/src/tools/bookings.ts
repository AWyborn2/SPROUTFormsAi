import { z } from 'zod';
import type { InductionsClient } from '../client.js';
import { defineTool, ISO_DATE, ok, type ToolHost } from './host.js';

export const recordBookingInput = z.object({
  date: z.string().regex(ISO_DATE, 'Use YYYY-MM-DD').describe('The induction date that was booked.'),
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
      'Why the site accepted a booking made after the Thursday cutoff for that date. Required ' +
      'when any starter is short-notice — the API refuses without it. Record what the human ' +
      'actually decided (who agreed, and on what basis); never invent a justification.',
    ),
});

export const listBookingsInput = z.object({
  date: z.string().regex(ISO_DATE, 'Use YYYY-MM-DD').optional(),
});

export const confirmBookingInput = z.object({
  bookingId: z
    .string()
    .min(1)
    .describe('The booking to confirm, from list_induction_bookings.'),
  submissionIds: z
    .array(z.string().min(1))
    .min(1)
    .max(50)
    .optional()
    .describe(
      "Confirm only these starters' seats, when the human confirmed some of a cohort but " +
      'not all of it. Omit to confirm every starter on the booking.',
    ),
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
        'notice_override_required error means the Thursday cutoff for that date has passed: ' +
        'stop and ask the human whether the site has agreed to it anyway, then pass their ' +
        'answer as noticeOverrideReason.',
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
        'whether a cohort has already gone through. A booking is TENTATIVE until a human ' +
        'confirms it after their pre-induction check: each starter seat carries confirmedAt, ' +
        'and the booking a derived confirmed flag that is true only when every seat is ' +
        'confirmed. An unconfirmed booking close to its date is a prompt to ask the human ' +
        'about their check — never something to resolve by confirming it yourself.',
      inputSchema: listBookingsInput,
    },
    async (args) => ok(await client.listBookings(args.date)),
  );

  defineTool(
    host,
    'confirm_induction_booking',
    {
      title: 'Confirm an induction booking',
      description:
        'Records that a HUMAN has confirmed booked seats after their own pre-induction ' +
        'check — at CHC, the 2pm Thursday gate check before the Monday induction. This tool ' +
        'stores a decision a person has already made and stated; it must NEVER be called ' +
        'because a booking looks ready, to tidy a list, or on your own judgement. If no human ' +
        'has said "confirmed", the booking stays unconfirmed and that is the accurate record. ' +
        'What the human verifies before confirming is their own checklist, outside this ' +
        'system. Idempotent: seats already confirmed keep their first timestamp and come back ' +
        'as alreadyConfirmed rather than as an error. Passing submissionIds confirms only ' +
        'those seats, and the booking reads confirmed overall only once every seat is.',
      inputSchema: confirmBookingInput,
    },
    async (args) => ok(await client.confirmBooking(args.bookingId, args.submissionIds)),
  );
}
