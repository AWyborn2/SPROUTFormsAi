import { describe, expect, it, vi } from 'vitest';
import { ApiError, InductionsClient } from './client.js';
import { API_KEY_VAR, API_URL_VAR, ConfigError, loadConfig } from './config.js';

function respond(status: number, body: unknown, contentType = 'application/json') {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType },
  });
}

function client(fetchImpl: typeof fetch, apiUrl = 'https://forms.example.com/api') {
  return new InductionsClient({ apiUrl, apiKey: 'fai_abc_secret' }, fetchImpl);
}

describe('loadConfig', () => {
  it('names the variable that is missing', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(API_URL_VAR);
    expect(() => loadConfig({ [API_URL_VAR]: 'https://x.test' })).toThrow(API_KEY_VAR);
  });

  it('treats whitespace as unset', () => {
    expect(() => loadConfig({ [API_URL_VAR]: '  ', [API_KEY_VAR]: 'k' })).toThrow(API_URL_VAR);
  });

  it('strips a trailing slash so paths concatenate cleanly', () => {
    expect(loadConfig({ [API_URL_VAR]: 'https://x.test/api/', [API_KEY_VAR]: 'k' }).apiUrl).toBe(
      'https://x.test/api',
    );
  });
});

describe('InductionsClient', () => {
  it('presents the key as a bearer token on every request', async () => {
    const fetchImpl = vi.fn(async () => respond(200, { candidates: [] }));
    await client(fetchImpl as unknown as typeof fetch).listCandidates({});

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer fai_abc_secret');
    expect(headers.accept).toBe('application/json');
  });

  it('sends set filters and omits unset ones', async () => {
    const fetchImpl = vi.fn(async () => respond(200, { candidates: [] }));
    await client(fetchImpl as unknown as typeof fetch).listCandidates({
      from: '2026-03-16',
      readiness: 'ready',
    });

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain('from=2026-03-16');
    expect(url).toContain('readiness=ready');
    expect(url).not.toContain('to=');
  });

  it('builds the same URL whether or not the base has a trailing slash', async () => {
    const withSlash = vi.fn(async () => respond(200, {}));
    const withoutSlash = vi.fn(async () => respond(200, {}));
    // loadConfig normalises this, so the client only ever sees the stripped
    // form — this pins that the two agree.
    await client(withoutSlash as unknown as typeof fetch, 'https://forms.example.com/api').nextDates(3);
    await client(
      withSlash as unknown as typeof fetch,
      loadConfig({ [API_URL_VAR]: 'https://forms.example.com/api/', [API_KEY_VAR]: 'k' }).apiUrl,
    ).nextDates(3);

    expect((withSlash.mock.calls[0] as unknown as string[])[0]).toBe(
      (withoutSlash.mock.calls[0] as unknown as string[])[0],
    );
  });

  it('posts a booking as JSON', async () => {
    const fetchImpl = vi.fn(async () => respond(201, { id: 'b1', seats: 2 }));
    await client(fetchImpl as unknown as typeof fetch).recordBooking({
      date: '2026-03-16',
      submissionIds: ['s1', 's2'],
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/inductions/bookings');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string).submissionIds).toEqual(['s1', 's2']);
  });

  it('raises the API error code rather than returning an empty result', async () => {
    const fetchImpl = vi.fn(async () => respond(401, { error: 'unauthenticated' }));
    await expect(client(fetchImpl as unknown as typeof fetch).listCandidates({})).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
  });

  it('preserves already_booked so a caller can tell it from a transport failure', async () => {
    const fetchImpl = vi.fn(async () =>
      respond(409, { error: 'already_booked', submissionIds: ['s1'] }),
    );
    const err = await client(fetchImpl as unknown as typeof fetch)
      .recordBooking({ date: '2026-03-16', submissionIds: ['s1'] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('already_booked');
    expect((err as ApiError).detail).toMatchObject({ submissionIds: ['s1'] });
  });

  it('reports a non-JSON error body verbatim instead of throwing a parse error', async () => {
    const fetchImpl = vi.fn(async () => respond(502, '<html>bad gateway</html>', 'text/html'));
    const err = (await client(fetchImpl as unknown as typeof fetch)
      .nextDates()
      .catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(502);
    expect(err.code).toBe('non_json_response');
    expect(JSON.stringify(err.detail)).toContain('bad gateway');
  });

  it('encodes a submission id into the path', async () => {
    const fetchImpl = vi.fn(async () => respond(200, {}));
    await client(fetchImpl as unknown as typeof fetch).getCandidate('sub/1', true);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain('/inductions/candidates/sub%2F1');
    expect(url).toContain('includeSensitive=true');
  });
});
