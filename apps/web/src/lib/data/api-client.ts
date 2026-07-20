/**
 * Thin `fetch` wrapper for `apps/api`. Calls go to `/api/*`, same-origin —
 * `vite.config.ts` proxies that to the API process (stripping the `/api`
 * prefix) in dev, the Replit preview, and the deployed app alike, since both
 * processes run in the same container. This avoids CORS and any build-time
 * API URL to configure; `credentials: 'include'` is kept so the `fai_session`
 * cookie rides along regardless.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API request failed (${status})`);
  }
}

/** Hard ceiling on any single request — a stalled export must not hang forever. */
const REQUEST_TIMEOUT_MS = 30_000;

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  // Abort a request that outruns the timeout and surface it as an ApiError so
  // callers' onError paths fire (rather than an unhandled DOMException/hang).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'include',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError(0, { error: 'request_timeout' });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Error bodies are JSON even on binary endpoints (e.g. /pdf/round-trip).
    const errorBody = await res.json().catch(() => undefined);
    throw new ApiError(res.status, errorBody);
  }
  return res;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, body);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const apiClient = {
  get: <T>(path: string): Promise<T> => request<T>('GET', path),
  post: <T>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown): Promise<T> => request<T>('PATCH', path, body),
  delete: <T>(path: string): Promise<T> => request<T>('DELETE', path),
  /** POST to an endpoint that answers with a binary body (e.g. a PDF) instead of JSON. */
  postForBlob: (path: string, body?: unknown): Promise<Blob> =>
    send('POST', path, body).then((res) => res.blob()),
};
