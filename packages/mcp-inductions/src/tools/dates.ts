import { z } from 'zod';
import type { InductionsClient } from '../client.js';
import { defineTool, ok, type ToolHost } from './host.js';

export const datesInput = z.object({
  count: z.number().int().min(1).max(26).optional().describe('How many upcoming dates to return.'),
});

export function registerDateTools(host: ToolHost, client: InductionsClient): void {
  defineTool(
    host,
    'next_induction_dates',
    {
      title: 'Next bookable induction dates',
      description:
        'Upcoming induction Mondays that satisfy the site rule: a Monday, not a public ' +
        'holiday, at least four clear business days away. holidayListExpired marks a date ' +
        'beyond the end of the stored public-holiday list, where the notice count may be ' +
        'treating a holiday as a working day — check it with a human before booking.',
      inputSchema: datesInput,
    },
    async (args) => ok(await client.nextDates(args.count)),
  );
}
