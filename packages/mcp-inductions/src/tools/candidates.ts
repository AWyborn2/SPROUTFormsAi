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
});

export const getCandidateInput = z.object({
  submissionId: z.string().min(1),
  includeSensitive: z.boolean().optional()
    .describe(
      'Ask for date of birth, address, licence number and emergency contact. Only request these when the task genuinely needs them — a booking does not.',
    ),
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
        'public-holiday list, so its notice count is provisional.',
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
    async (args) => ok(await client.getCandidate(args.submissionId, args.includeSensitive)),
  );
}
