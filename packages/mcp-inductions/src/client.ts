import type { McpConfig } from './config.js';

/**
 * The HTTP client for the FormAI induction endpoints.
 *
 * The server is a CLIENT of the API, never a second database client. Tenancy,
 * permissions, redaction and audit all have exactly one implementation, on the
 * other side of this fetch — putting a DATABASE_URL on the agent's machine
 * would bypass every one of them.
 *
 * Failures are raised as `ApiError` carrying the API's own error code. That
 * matters more than it looks: an agent that receives an empty candidate list
 * concludes there is nobody to book, so a 401 or a 500 must never be able to
 * reach it wearing that disguise.
 */

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(`FormAI API ${status} (${code})`);
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export interface Candidate {
  submissionId: string;
  submittedAt: string;
  status: string;
  starter: Record<string, unknown>;
  readiness: 'ready' | 'blocked';
  blockers: string[];
  warnings: string[];
  sensitive?: Record<string, string>;
  sensitiveOmitted?: string;
}

export interface Cohort {
  date: string;
  seats: number;
  readyCount: number;
  blockedCount: number;
  starters: Candidate[];
}

export interface Booking {
  id: string;
  date: string;
  seats: number;
  externalReference: string;
  note: string;
  noticeOverrideReason: string;
  bookedByUserId: string | null;
  bookedByApiKeyId: string | null;
  createdAt: string;
  starters: { submissionId: string; starterName: string }[];
}

export class InductionsClient {
  constructor(
    private readonly config: McpConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string, query: Query = {}): string {
    const url = new URL(`${this.config.apiUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      // Unset parameters are omitted rather than sent empty — an empty `from`
      // is a malformed date to the API, not "no filter".
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async request<T>(path: string, query: Query = {}, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(this.url(path, query), {
      ...init,
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });

    const raw = await res.text();
    const body: unknown = raw ? safeParse(raw) : undefined;
    if (!res.ok) {
      const code =
        typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : 'http_error';
      throw new ApiError(res.status, code, body);
    }
    return body as T;
  }

  listCandidates(params: {
    from?: string;
    to?: string;
    readiness?: 'ready' | 'blocked';
    allowLateNotice?: boolean;
  }) {
    return this.request<{ candidates: Candidate[]; holidaysCoverThrough: string }>(
      '/inductions/candidates',
      { ...params, allowLateNotice: params.allowLateNotice ? 'true' : undefined },
    );
  }

  getCandidate(
    submissionId: string,
    options: { includeSensitive?: boolean; allowLateNotice?: boolean } = {},
  ) {
    return this.request<Candidate>(`/inductions/candidates/${encodeURIComponent(submissionId)}`, {
      includeSensitive: options.includeSensitive ? 'true' : undefined,
      allowLateNotice: options.allowLateNotice ? 'true' : undefined,
    });
  }

  nextDates(count?: number) {
    return this.request<{
      dates: { date: string; holidayListExpired: boolean }[];
      holidaysCoverThrough: string;
    }>('/inductions/dates', { count });
  }

  cohorts(date?: string, allowLateNotice?: boolean) {
    return this.request<{ cohorts: Cohort[]; holidaysCoverThrough: string }>('/inductions/cohorts', {
      date,
      allowLateNotice: allowLateNotice ? 'true' : undefined,
    });
  }

  recordBooking(body: {
    date: string;
    submissionIds: string[];
    externalReference?: string;
    note?: string;
    noticeOverrideReason?: string;
  }) {
    return this.request<Booking>('/inductions/bookings', {}, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  listBookings(date?: string) {
    return this.request<{ bookings: Booking[] }>('/inductions/bookings', { date });
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // A non-JSON body is still evidence — a proxy error page, usually — and is
    // more useful to the agent verbatim than swallowed.
    return { error: 'non_json_response', body: raw.slice(0, 500) };
  }
}
