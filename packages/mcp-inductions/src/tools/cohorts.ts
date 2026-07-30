import { z } from 'zod';
import type { InductionsClient } from '../client.js';
import { defineTool, ISO_DATE, ok, type ToolHost } from './host.js';

export const cohortInput = z.object({
  date: z
    .string()
    .regex(ISO_DATE, 'Use YYYY-MM-DD')
    .optional()
    .describe('One induction date. Omit to see every upcoming cohort.'),
  allowLateNotice: z.boolean().optional()
    .describe(
      'Count starters booked after the Thursday cutoff toward the seat total, as if it were waived. Set only when a human has decided the site will accept the late booking. It does not move the calendar: a date the site runs no induction on — anything but the Monday, or the Tuesday when that Monday is a public holiday — stays blocked either way.',
    ),
});

export function registerCohortTools(host: ToolHost, client: InductionsClient): void {
  defineTool(
    host,
    'plan_induction_cohort',
    {
      title: 'Plan an induction cohort',
      description:
        'The seat count and roster for an induction date — what a BISTrainer booking needs. ' +
        'seats counts READY starters only; blocked starters are still listed so the gap is ' +
        'visible, but must not be given a seat. Use the seats figure as-is rather than ' +
        'counting the roster yourself: the two differ whenever a starter is blocked.',
      inputSchema: cohortInput,
    },
    async (args) => ok(await client.cohorts(args.date, args.allowLateNotice)),
  );
}
