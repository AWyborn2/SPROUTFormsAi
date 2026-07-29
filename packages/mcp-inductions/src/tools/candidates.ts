import { z } from 'zod';
import type { InductionsClient } from '../client.js';
import { defineTool, ISO_DATE, ok, type ToolHost } from './host.js';

export const listCandidatesInput = z.object({
  from: z.string().regex(ISO_DATE, 'Use YYYY-MM-DD').optional()
    .describe('Only starters whose induction date is on or after this day.'),
  to: z.string().regex(ISO_DATE, 'Use YYYY-MM-DD').optional()
    .describe('Only starters whose induction date is on or before this day.'),
  readiness: z.enum(['ready', 'blocked']).optional()
    .describe('Narrow to starters who can be registered, or to those who cannot.'),
  allowLateNotice: z.boolean().optional()
    .describe(
      'Treat the four-business-day notice rule as waived, so a short-notice starter reads as ready with a notice_overridden warning. Set only when a human has decided the site will accept short notice. It does not change the calendar: a starter whose date is not a Monday, or is a public holiday, stays blocked either way.',
    ),
});

export const getCandidateInput = z.object({
  submissionId: z.string().min(1),
  includeSensitive: z.boolean().optional()
    .describe(
      'Ask for date of birth, address, licence number and emergency contact. Only request these when the task genuinely needs them — a booking does not.',
    ),
  allowLateNotice: z.boolean().optional()
    .describe('Treat the notice rule as waived for this starter. Set only when a human has decided the site will accept short notice. It does not change the calendar: a starter whose date is not a Monday, or is a public holiday, stays blocked either way.'),
});

export function registerCandidateTools(host: ToolHost, client: InductionsClient): void {
  defineTool(
    host,
    'list_induction_candidates',
    {
      title: 'List induction candidates',
      description:
        'Every starter who has submitted a CHC intake form, with a readiness verdict. ' +
        'A "blocked" starter cannot be registered: fix the cause in the intake form rather ' +
        'than working around it. Blocker codes are contact_missing, identity_missing, ' +
        'date_invalid (not a Monday, or a public holiday), date_notice_lapsed (valid when ' +
        'filled, now inside the four-business-day window) and already_booked. The ' +
        'holiday_list_expired warning means the date sits past the end of the stored ' +
        'public-holiday list, so its notice count is provisional. date_notice_lapsed is the ' +
        'one blocker an operator may waive — see allowLateNotice — and doing so is a human ' +
        'decision, not one to take on their behalf.',
      inputSchema: listCandidatesInput,
    },
    async (args) => ok(await client.listCandidates(args)),
  );

  defineTool(
    host,
    'get_induction_candidate',
    {
      title: 'Get one induction candidate',
      description:
        'Full detail for a single starter. Sensitive personal fields are withheld unless ' +
        'includeSensitive is set and the API key carries the export grant; when they are ' +
        'withheld the response says why in sensitiveOmitted.',
      inputSchema: getCandidateInput,
    },
    async (args) =>
      ok(
        await client.getCandidate(args.submissionId, {
          includeSensitive: args.includeSensitive,
          allowLateNotice: args.allowLateNotice,
        }),
      ),
  );
}
