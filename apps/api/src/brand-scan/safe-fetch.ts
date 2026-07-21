/**
 * The network boundary for the brand scan: fetching a URL the user typed.
 *
 * This is the only place in the product where the server makes an outbound
 * request to an address an outsider influences, which makes it an SSRF surface
 * rather than "just a fetch". The defences below are deliberately layered,
 * because each one alone has a known bypass:
 *
 * - **Scheme allowlist.** `file:`, `gopher:`, `data:` and friends are rejected
 *   before anything else happens.
 * - **Address classification.** Every resolved address must be public unicast.
 *   Loopback, RFC1918, link-local (which covers the cloud metadata endpoint at
 *   169.254.169.254), CGNAT, ULA and IPv4-mapped IPv6 are all rejected. The
 *   classification uses `ipaddr.js` rather than hand-rolled regexes, because
 *   the encodings attackers reach for (decimal, octal, IPv4-in-IPv6) are
 *   exactly what naive string checks miss.
 * - **Connection pinned to the validated address.** Validating a hostname and
 *   then calling `fetch` is a check-then-use race: an attacker's DNS can
 *   return a public address for the check and a private one for the connection
 *   (DNS rebinding). Passing our own `lookup` into the socket means the
 *   address the kernel connects to is the address we approved — there is no
 *   second resolution to poison. The hostname still goes out in `Host` and
 *   SNI, so TLS verification is unaffected.
 * - **Manual redirect handling.** Redirects are followed by hand with the full
 *   check re-run on every hop. An allowlisted public host that 302s to
 *   169.254.169.254 is the single most common real-world bypass, and
 *   `redirect: 'follow'` would walk straight into it.
 * - **Byte cap and timeout.** The body is capped while streaming rather than
 *   trusting `Content-Length`, and the whole request is deadlined.
 *
 * Nothing here is specific to brand extraction; it is a general guarded
 * fetcher that happens to have one caller today.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import ipaddr from 'ipaddr.js';

export class SafeFetchError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_url'
      | 'blocked_scheme'
      | 'blocked_address'
      | 'too_many_redirects'
      | 'too_large'
      | 'timeout'
      | 'request_failed',
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export interface SafeFetchOptions {
  /** Total deadline for the whole chain, including redirects. */
  timeoutMs?: number;
  /** Hard ceiling on the decoded body. */
  maxBytes?: number;
  maxRedirects?: number;
}

const DEFAULTS = { timeoutMs: 8000, maxBytes: 2 * 1024 * 1024, maxRedirects: 3 };

/**
 * True when an address is safe to connect to: public unicast only.
 *
 * `ipaddr.js` ranges do the heavy lifting. IPv4-mapped IPv6 (`::ffff:127.0.0.1`)
 * is unwrapped first — it classifies as `ipv4Mapped` rather than `loopback`,
 * so checking the range alone would let it through.
 */
export function isPublicAddress(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return false;
  }

  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) return isPublicAddress(v6.toIPv4Address().toString());
  }

  return parsed.range() === 'unicast';
}

/**
 * Parse, scheme-check, and — when the host is already a literal address —
 * classify it here.
 *
 * The literal case has to be caught at this level because Node skips DNS
 * resolution entirely when the host is an IP, which means the validating
 * `lookup` below is never invoked for `http://127.0.0.1/`. Relying on the
 * lookup alone leaves raw-IP SSRF wide open; an adversarial test caught
 * exactly that. Hostnames still go through the lookup, which is what closes
 * the rebinding window.
 */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SafeFetchError(`Not a valid URL: ${raw}`, 'invalid_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeFetchError(`Unsupported scheme: ${url.protocol}`, 'blocked_scheme');
  }

  // `URL` keeps IPv6 literals bracketed in `hostname`; strip so ipaddr sees a
  // bare address. Decimal and octal IPv4 forms are normalised by `URL` itself.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host) && !isPublicAddress(host)) {
    throw new SafeFetchError(`Refusing to fetch a non-public address (${host})`, 'blocked_address');
  }

  return url;
}

/**
 * A `lookup` that resolves normally then refuses to hand back a private
 * address. Installed on the socket, so the address validated here is the one
 * actually connected to — closing the rebinding window.
 */
const validatingLookup: typeof dnsLookup = ((
  hostname: string,
  options: unknown,
  callback: (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void,
) => {
  const cb = typeof options === 'function' ? (options as typeof callback) : callback;
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return cb(err);
    const entries = Array.isArray(addresses) ? addresses : [];
    if (entries.length === 0) {
      return cb(new SafeFetchError(`${hostname} did not resolve`, 'blocked_address'));
    }
    // Every answer must be public. Accepting the first safe one while others
    // are private would still let a multi-record rebind land somewhere private
    // on a retry.
    for (const entry of entries) {
      if (!isPublicAddress(entry.address)) {
        return cb(
          new SafeFetchError(
            `${hostname} resolves to a non-public address (${entry.address})`,
            'blocked_address',
          ),
        );
      }
    }
    const first = entries[0]!;
    cb(null, first.address, first.family);
  });
}) as typeof dnsLookup;

export interface SafeFetchResult {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

function once(url: URL, timeoutMs: number, maxBytes: number): Promise<{
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
}> {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      {
        method: 'GET',
        lookup: validatingLookup,
        headers: {
          // Identify honestly; some sites serve a different shell to unknown
          // agents, and pretending to be a browser invites blocking anyway.
          'user-agent': 'FormAI-BrandScan/1.0 (+https://formai.app)',
          accept: 'text/html,text/css,*/*;q=0.5',
          'accept-encoding': 'identity',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            req.destroy();
            reject(new SafeFetchError('Response exceeded the size cap', 'too_large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', (err) => reject(err));
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new SafeFetchError('Request timed out', 'timeout'));
    });
    req.on('error', (err) =>
      reject(
        err instanceof SafeFetchError
          ? err
          : new SafeFetchError((err as Error).message, 'request_failed'),
      ),
    );
    req.end();
  });
}

/**
 * Fetch a user-supplied URL with every guard applied, following redirects by
 * hand and re-validating each hop.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const { timeoutMs, maxBytes, maxRedirects } = { ...DEFAULTS, ...options };
  const deadline = Date.now() + timeoutMs;

  let url = assertFetchableUrl(rawUrl);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SafeFetchError('Request timed out', 'timeout');

    const res = await once(url, remaining, maxBytes);

    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.location;
    if (!isRedirect) {
      return {
        url: url.toString(),
        status: res.status,
        contentType: String(res.headers['content-type'] ?? ''),
        body: res.body,
      };
    }

    // Re-run the full check on the target. Resolving against the current URL
    // handles relative Location values.
    url = assertFetchableUrl(new URL(String(res.headers.location), url).toString());
  }

  throw new SafeFetchError('Too many redirects', 'too_many_redirects');
}
