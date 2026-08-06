import { describe, expect, it, vi } from 'vitest';
import { ApiError, InductionsClient } from './client.js';
import type { ToolResult } from './tools/host.js';
import { documentLinkInput, listCandidatesInput, registerCandidateTools } from './tools/candidates.js';
import { cohortInput, registerCohortTools } from './tools/cohorts.js';
import { datesInput, registerDateTools } from './tools/dates.js';
import { confirmBookingInput, recordBookingInput, registerBookingTools } from './tools/bookings.js';

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
  it('exposes the eight induction tools with usable descriptions', () => {
    const tools = setup({});
    expect([...tools.keys()].sort()).toEqual([
      'confirm_induction_booking',
      'get_induction_candidate',
      'get_induction_document_link',
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

  it('describes the date rules the server actually enforces', () => {
    // These strings are the only account of the rules an agent ever reads, so
    // they drift silently when the rules change — this pins them to the two
    // that actually apply. The four-business-day notice rule was replaced by
    // the Thursday cutoff and must not survive in any description.
    const tools = setup({});
    const descriptions = [...tools.values()].map((t) => t.config.description).join(' ');
    expect(descriptions).not.toMatch(/business[ -]day/i);
    // Saying there is NO minimum notice is the point — an agent that assumes
    // one will refuse a booking the site would happily take.
    expect(descriptions).toMatch(/no minimum notice/i);
    expect(tools.get('next_induction_dates')!.config.description).toContain('Thursday');
    expect(tools.get('next_induction_dates')!.config.description).toContain('Tuesday');
  });

  it('tells the agent that seats come from the server, not from counting the roster', () => {
    const tools = setup({});
    expect(tools.get('plan_induction_cohort')!.config.description).toContain('READY starters only');
  });

  it('tells the agent to record a booking only after it exists externally', () => {
    const tools = setup({});
    expect(tools.get('record_induction_booking')!.config.description).toContain('AFTER');
  });

  it('tells the agent that confirmation records a human decision, never its own', () => {
    // The confirm tool stores the outcome of the human's pre-induction check.
    // These strings are the only guard against an agent "helpfully" confirming
    // a booking that merely looks ready, so the constraint must survive in
    // every description that mentions confirmation.
    const tools = setup({});
    const confirm = tools.get('confirm_induction_booking')!.config.description;
    expect(confirm).toContain('HUMAN');
    expect(confirm).toContain('NEVER');
    expect(confirm).toMatch(/idempotent/i);
    expect(tools.get('list_induction_bookings')!.config.description).toMatch(/tentative/i);
    expect(tools.get('get_induction_candidate')!.config.description).toContain('bookingConfirmed');
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

  it('passes the booking id and seat subset through to the confirm endpoint', async () => {
    const confirmBooking = vi.fn(async () => ({
      id: 'b1',
      confirmed: false,
      newlyConfirmed: ['s1'],
      alreadyConfirmed: [],
      starters: [],
    }));
    const tools = setup({ confirmBooking } as unknown as Partial<InductionsClient>);

    const result = await tools.get('confirm_induction_booking')!.call({
      bookingId: 'b1',
      submissionIds: ['s1'],
    });
    expect(confirmBooking).toHaveBeenCalledWith('b1', ['s1']);
    expect((payload(result) as { newlyConfirmed: string[] }).newlyConfirmed).toEqual(['s1']);
  });

  it('surfaces a confirm rejection as a named tool error, not an empty result', async () => {
    const confirmBooking = vi.fn(async () => {
      throw new ApiError(400, 'not_on_booking', { submissionIds: ['s-stray'] });
    });
    const tools = setup({ confirmBooking } as unknown as Partial<InductionsClient>);

    const result = await tools.get('confirm_induction_booking')!.call({ bookingId: 'b1', submissionIds: ['s-stray'] });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not_on_booking');
    expect(result.content[0]!.text).toContain('s-stray');
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

describe('document links', () => {
  it('composes an absolute URL from the configured base', async () => {
    const documentLink = vi.fn(async () => ({
      url: 'https://forms.example.com/api/inductions/documents/tok',
      path: '/inductions/documents/tok',
      expiresAt: '2026-03-10T09:05:00.000Z',
      fileName: 'marlee.jpg',
      contentType: 'image/jpeg',
      size: 2048,
    }));
    const tools = setup({ documentLink } as unknown as Partial<InductionsClient>);

    const result = await tools.get('get_induction_document_link')!.call({
      submissionId: 'sub-1',
      kind: 'photo',
    });
    expect(documentLink).toHaveBeenCalledWith('sub-1', 'photo');
    expect((payload(result) as { url: string }).url).toContain('/inductions/documents/tok');
  });

  it('warns the agent that the link is a secret and the file is an identity document', () => {
    const tools = setup({});
    const description = tools.get('get_induction_document_link')!.config.description;
    expect(description).toContain('expires');
    expect(description).toContain('identity');
  });

  it('rejects a document kind the form does not collect', () => {
    expect(documentLinkInput.safeParse({ submissionId: 's1', kind: 'passport' }).success).toBe(false);
    expect(documentLinkInput.safeParse({ submissionId: 's1', kind: 'photo' }).success).toBe(true);
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

  it('lets a confirmation name a seat subset or omit it, but never an empty list', () => {
    expect(confirmBookingInput.safeParse({ bookingId: 'b1' }).success).toBe(true);
    expect(confirmBookingInput.safeParse({ bookingId: 'b1', submissionIds: ['s1'] }).success).toBe(true);
    expect(confirmBookingInput.safeParse({ bookingId: 'b1', submissionIds: [] }).success).toBe(false);
    expect(confirmBookingInput.safeParse({}).success).toBe(false);
  });

  it('bounds the number of dates requested', () => {
    expect(datesInput.safeParse({ count: 0 }).success).toBe(false);
    expect(datesInput.safeParse({ count: 99 }).success).toBe(false);
    expect(datesInput.safeParse({ count: 4 }).success).toBe(true);
    expect(datesInput.safeParse({}).success).toBe(true);
  });
});
