import { z } from 'zod';
import type { InductionsClient } from '../client.js';
import { defineTool, ok, type ToolHost } from './host.js';

export const cohortInput = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .optional()
    .describe('One induction Monday. Omit to see every upcoming cohort.'),
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
    async (args) => ok(await client.cohorts(args.date)),
  );
}
