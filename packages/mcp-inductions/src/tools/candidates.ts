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
      'Treat the Thursday booking cutoff as waived, so a starter booked after it reads as ready with a notice_overridden warning. Set only when a human has decided the site will accept the late booking. It does not move the calendar: a date the site runs no induction on — anything but the Monday, or the Tuesday when that Monday is a public holiday — stays blocked either way.',
    ),
});

export const getCandidateInput = z.object({
  submissionId: z.string().min(1),
  includeSensitive: z.boolean().optional()
    .describe(
      'Ask for date of birth, address, licence number and emergency contact. Only request these when the task genuinely needs them — a booking does not.',
    ),
  allowLateNotice: z.boolean().optional()
    .describe('Treat the Thursday booking cutoff as waived for this starter. Set only when a human has decided the site will accept the late booking. It does not move the calendar: a date the site runs no induction on — anything but the Monday, or the Tuesday when that Monday is a public holiday — stays blocked either way.'),
});

export const documentLinkInput = z.object({
  submissionId: z.string().min(1),
  kind: z.enum(['photo', 'driversLicence']).describe('Which stored document to link to.'),
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
        'date_invalid (a day the site runs no induction on), date_notice_lapsed (the ' +
        'Thursday booking cutoff for that date has passed) and already_booked. The ' +
        'holiday_list_expired warning means the date sits past the end of the stored ' +
        'public-holiday list, so whether it is even an induction day is provisional. ' +
        'Inductions run on Mondays, moving to the Tuesday when that Monday is a public ' +
        'holiday. There is no minimum notice: a booking is fine right up to the Thursday ' +
        'before. date_notice_lapsed is the one blocker an operator may waive — see ' +
        'allowLateNotice — and doing so is a human decision, not one to take on their behalf. ' +
        'submittedBy is who lodged the form, which is usually not the starter: it is the ' +
        'address a booking confirmation is owed to alongside the starter\'s own. Its ' +
        'verified flag is false when the intake arrived through a public fill link, where ' +
        'the address was typed by the filler rather than stamped from a signed-in session.',
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
        'withheld the response says why in sensitiveOmitted. submittedBy carries who lodged ' +
        'the form — usually not the starter — so a confirmation can reach the requester as ' +
        'well as the person being inducted.',
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

  defineTool(
    host,
    'get_induction_document_link',
    {
      title: 'Link to a starter document',
      description:
        'A temporary download link for the profile photo or licence image a starter uploaded — ' +
        'use it to ' +
        'transfer the file into another system, such as a BISTrainer profile. The link expires ' +
        'in a few minutes and needs no credential, so treat it as the secret it is: fetch it, ' +
        'use it, and do not paste it into anything that keeps a record. These are identity ' +
        'documents; request one only when a task actually needs the file, not to inspect or ' +
        'describe the person.',
      inputSchema: documentLinkInput,
    },
    async (args) => ok(await client.documentLink(args.submissionId, args.kind)),
  );
}
