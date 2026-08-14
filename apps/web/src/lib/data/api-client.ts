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

async function send(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  // Abort a request that outruns the timeout and surface it as an ApiError so
  // callers' onError paths fire (rather than an unhandled DOMException/hang).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
  const res = await send(method, path, body, timeoutMs);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Per-call overrides. `timeoutMs` raises the default ceiling for slow endpoints. */
export interface RequestOptions {
  timeoutMs?: number;
}

/**
 * Reads a File into the base64 the upload routes expect (no `data:` prefix).
 * `readAsDataURL` is used rather than `arrayBuffer` + manual encoding because
 * the browser's own base64 is both faster and immune to the stack-overflow
 * that `String.fromCharCode(...bytes)` hits on multi-megabyte inputs.
 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new ApiError(0, { error: 'file_read_failed' }));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Uploads one submission attachment and resolves to the stored ref.
 *
 * Deliberately XHR rather than `fetch`: a licence photo off a phone is
 * routinely 5–8 MB, and `fetch` still cannot report upload progress in any
 * browser this app supports. A respondent on a site connection staring at a
 * frozen control for thirty seconds will assume it broke and pick the file
 * again — so real percentages are a correctness matter for the flow, not
 * decoration. It also means no `REQUEST_TIMEOUT_MS`: the 30 s ceiling that
 * protects ordinary JSON calls would abort a legitimate large upload.
 *
 * `path` selects the door: `/uploads` for authenticated surfaces,
 * `/fill/:token/uploads` for a public fill link.
 */
export function uploadAttachment<T>(
  path: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<T> {
  return fileToBase64(file).then(
    (fileBase64) =>
      new Promise<T>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api${path}`);
        xhr.withCredentials = true;
        xhr.setRequestHeader('content-type', 'application/json');

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && onProgress) {
            onProgress(Math.round((e.loaded / e.total) * 100));
          }
        };
        xhr.onerror = () => reject(new ApiError(0, { error: 'network_error' }));
        xhr.onabort = () => reject(new ApiError(0, { error: 'aborted' }));
        xhr.onload = () => {
          let body: unknown;
          try {
            body = JSON.parse(xhr.responseText);
          } catch {
            body = undefined;
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            onProgress?.(100);
            resolve(body as T);
          } else {
            reject(new ApiError(xhr.status, body));
          }
        };

        xhr.send(
          JSON.stringify({ fileBase64, mimeType: file.type, fileName: file.name }),
        );
      }),
  );
}

export const apiClient = {
  get: <T>(path: string): Promise<T> => request<T>('GET', path),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> =>
    request<T>('POST', path, body, opts?.timeoutMs),
  patch: <T>(path: string, body?: unknown): Promise<T> => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown): Promise<T> => request<T>('PUT', path, body),
  /*
    DELETE accepts an optional body: the awaitingLink remove (U6, KTD9) is a
    guarded destructive act and must echo the requirement fingerprint, which a
    bare URL cannot carry.
  */
  delete: <T>(path: string, body?: unknown): Promise<T> => request<T>('DELETE', path, body),
  /** POST to an endpoint that answers with a binary body (e.g. a PDF) instead of JSON. */
  postForBlob: (path: string, body?: unknown): Promise<Blob> =>
    send('POST', path, body).then((res) => res.blob()),
  /**
   * GET an endpoint that answers with text rather than JSON — the workforce
   * import template, which is a CSV file the Admin fills in and sends back.
   * Parsing it as JSON would throw on the first comma.
   */
  getText: (path: string): Promise<string> => send('GET', path).then((res) => res.text()),
};
