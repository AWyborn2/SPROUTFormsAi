import { describe, expect, it, vi } from 'vitest';
import { ApiError, InductionsClient } from './client.js';
import type { ToolResult } from './tools/host.js';
import { listCandidatesInput, registerCandidateTools } from './tools/candidates.js';
import { cohortInput, registerCohortTools } from './tools/cohorts.js';
import { datesInput, registerDateTools } from './tools/dates.js';
import { recordBookingInput, registerBookingTools } from './tools/bookings.js';

interface Registered {
  config: { title: string; description: string };
  call: (args: unknown) => Promise<ToolResult>;
}

/** A two-line stand-in for `McpServer`, so handlers can be called directly. */
function fakeHost() {
  const tools = new Map<string, Registered>();
  const host = {
    registerTool(name: string, config: unknown, cb: (args: unknown) => Promise<ToolResult>) {
      tools.set(name, { config: config as Registered['config'], call: cb });
      return undefined;
    },
  };
  return { host: host as never, tools };
}

function setup(client: Partial<InductionsClient>) {
  const { host, tools } = fakeHost();
  const c = client as InductionsClient;
  registerCandidateTools(host, c);
  registerCohortTools(host, c);
  registerDateTools(host, c);
  registerBookingTools(host, c);
  return tools;
}

function payload(result: ToolResult): unknown {
  return JSON.parse(result.content[0]!.text);
}

describe('tool registration', () => {
  it('exposes the six induction tools with usable descriptions', () => {
    const tools = setup({});
    expect([...tools.keys()].sort()).toEqual([
      'get_induction_candidate',
      'list_induction_bookings',
      'list_induction_candidates',
      'next_induction_dates',
      'plan_induction_cohort',
      'record_induction_booking',
    ]);
    for (const [, tool] of tools) {
      expect(tool.config.description.length).toBeGreaterThan(40);
    }
  });

  it('tells the agent that seats come from the server, not from counting the roster', () => {
    const tools = setup({});
    expect(tools.get('plan_induction_cohort')!.config.description).toContain('READY starters only');
  });

  it('tells the agent to record a booking only after it exists externally', () => {
    const tools = setup({});
    expect(tools.get('record_induction_booking')!.config.description).toContain('AFTER');
  });
});

describe('tool handlers', () => {
  it('passes filters straight through and returns the API payload unchanged', async () => {
    const listCandidates = vi.fn(async () => ({ candidates: [{ submissionId: 's1' }], holidaysCoverThrough: '2026-12-28' }));
    const tools = setup({ listCandidates } as unknown as Partial<InductionsClient>);

    const result = await tools.get('list_induction_candidates')!.call({
      from: '2026-03-16',
      readiness: 'ready',
    });

    expect(listCandidates).toHaveBeenCalledWith({ from: '2026-03-16', readiness: 'ready' });
    expect(payload(result)).toEqual({
      candidates: [{ submissionId: 's1' }],
      holidaysCoverThrough: '2026-12-28',
    });
  });

  it('returns the cohort seat count exactly as the server computed it', async () => {
    const cohorts = vi.fn(async () => ({
      cohorts: [{ date: '2026-03-16', seats: 1, readyCount: 1, blockedCount: 2, starters: [] }],
      holidaysCoverThrough: '2026-12-28',
    }));
    const tools = setup({ cohorts } as unknown as Partial<InductionsClient>);

    const result = (await tools.get('plan_induction_cohort')!.call({ date: '2026-03-16' })) as ToolResult;
    const body = payload(result) as { cohorts: { seats: number; blockedCount: number }[] };
    // Three starters, one seat — the client must not "correct" this by counting.
    expect(body.cohorts[0]!.seats).toBe(1);
    expect(body.cohorts[0]!.blockedCount).toBe(2);
  });

  it('surfaces an API error as a tool error carrying the code', async () => {
    const recordBooking = vi.fn(async () => {
      throw new ApiError(409, 'already_booked', { submissionIds: ['s1'] });
    });
    const tools = setup({ recordBooking } as unknown as Partial<InductionsClient>);

    const result = await tools.get('record_induction_booking')!.call({
      date: '2026-03-16',
      submissionIds: ['s1'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('already_booked');
    expect(result.content[0]!.text).toContain('409');
  });

  it('names the credential when the API rejects the key', async () => {
    const listCandidates = vi.fn(async () => {
      throw new ApiError(401, 'unauthenticated');
    });
    const tools = setup({ listCandidates } as unknown as Partial<InductionsClient>);

    const result = await tools.get('list_induction_candidates')!.call({});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('FORMAI_API_KEY');
  });

  it('reports a transport failure as an error rather than an empty result', async () => {
    const nextDates = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const tools = setup({ nextDates } as unknown as Partial<InductionsClient>);

    const result = await tools.get('next_induction_dates')!.call({});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('request_failed');
    expect(result.content[0]!.text).toContain('fetch failed');
  });
});

describe('input schemas', () => {
  it('rejects a date that is not ISO before any request could be made', () => {
    expect(cohortInput.safeParse({ date: '16/03/2026' }).success).toBe(false);
    expect(cohortInput.safeParse({ date: '2026-03-16' }).success).toBe(true);
    expect(listCandidatesInput.safeParse({ from: 'next monday' }).success).toBe(false);
    expect(recordBookingInput.safeParse({ date: 'soon', submissionIds: ['s1'] }).success).toBe(false);
  });

  it('requires at least one starter on a booking', () => {
    expect(recordBookingInput.safeParse({ date: '2026-03-16', submissionIds: [] }).success).toBe(false);
    expect(recordBookingInput.safeParse({ date: '2026-03-16', submissionIds: ['s1'] }).success).toBe(true);
  });

  it('bounds the number of dates requested', () => {
    expect(datesInput.safeParse({ count: 0 }).success).toBe(false);
    expect(datesInput.safeParse({ count: 99 }).success).toBe(false);
    expect(datesInput.safeParse({ count: 4 }).success).toBe(true);
    expect(datesInput.safeParse({}).success).toBe(true);
  });
});
