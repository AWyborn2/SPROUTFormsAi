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
        'Upcoming dates the site runs an induction on and can still be booked: Mondays, ' +
        'moving to the Tuesday when that Monday is a public holiday, and only while the ' +
        'Thursday-before cutoff has not passed. There is no minimum notice — a date a few ' +
        'days out is perfectly bookable. holidayListExpired marks a date beyond the end of ' +
        'the stored public-holiday list, where the day may in fact be a holiday nobody has ' +
        'recorded yet — check it with a human before booking.',
      inputSchema: datesInput,
    },
    async (args) => ok(await client.nextDates(args.count)),
  );
}
