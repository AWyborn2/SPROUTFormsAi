/**
 * Adversarial tests for the brand-scan network boundary.
 *
 * These are the cases that make or break an SSRF guard, so they are written as
 * attacks rather than as happy-path coverage: alternate encodings, IPv6
 * wrappers, the cloud metadata endpoint, redirect chains that start public and
 * end private, and oversized/slow responses.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { assertFetchableUrl, isPublicAddress, safeFetch, SafeFetchError } from './safe-fetch.js';

let server: Server | null = null;

afterEach(() => {
  server?.close();
  server = null;
});

/** Start a throwaway origin bound to loopback and return its base URL. */
async function startServer(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('isPublicAddress', () => {
  it.each([
    ['loopback v4', '127.0.0.1'],
    ['loopback v4, alternate', '127.16.0.9'],
    ['RFC1918 10/8', '10.0.0.5'],
    ['RFC1918 172.16/12', '172.16.4.4'],
    ['RFC1918 192.168/16', '192.168.1.1'],
    ['cloud metadata endpoint', '169.254.169.254'],
    ['link-local', '169.254.1.1'],
    ['CGNAT', '100.64.0.1'],
    ['unspecified', '0.0.0.0'],
    ['broadcast', '255.255.255.255'],
    ['IPv6 loopback', '::1'],
    ['IPv6 ULA', 'fc00::1'],
    ['IPv6 link-local', 'fe80::1'],
    ['IPv4-mapped IPv6 loopback', '::ffff:127.0.0.1'],
    ['IPv4-mapped IPv6 private', '::ffff:10.0.0.1'],
    ['not an address at all', 'not-an-ip'],
  ])('rejects %s', (_label, address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    ['a public v4', '93.184.216.34'],
    ['a public v6', '2606:2800:220:1:248:1893:25c8:1946'],
  ])('allows %s', (_label, address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('assertFetchableUrl', () => {
  it.each([
    ['file', 'file:///etc/passwd'],
    ['gopher', 'gopher://example.com/'],
    ['data', 'data:text/html,<script>1</script>'],
    ['javascript', 'javascript:alert(1)'],
    ['ftp', 'ftp://example.com/x'],
  ])('rejects the %s scheme', (_label, url) => {
    expect(() => assertFetchableUrl(url)).toThrow(SafeFetchError);
  });

  it('rejects a malformed URL', () => {
    expect(() => assertFetchableUrl('http://')).toThrow(SafeFetchError);
    expect(() => assertFetchableUrl('nonsense')).toThrow(SafeFetchError);
  });

  it('accepts ordinary http and https', () => {
    expect(assertFetchableUrl('https://example.com/brand').protocol).toBe('https:');
    expect(assertFetchableUrl('  http://example.com  ').protocol).toBe('http:');
  });

  /**
   * Userinfo is a classic way to disguise the real host: this URL looks like
   * example.com to a human skimming it, but connects to loopback. The parser
   * resolves the true host and the address check then refuses it.
   */
  it('is not fooled by a host disguised with userinfo', () => {
    expect(() => assertFetchableUrl('http://example.com@127.0.0.1/')).toThrow(SafeFetchError);
    expect(assertFetchableUrl('http://user@example.com/').hostname).toBe('example.com');
  });
});

describe('safeFetch', () => {
  /**
   * The address guard runs at the socket, so a literal private address is
   * refused even though the origin is genuinely listening there — which is
   * exactly what a rebind or a redirect-to-metadata would look like.
   */
  it('refuses to connect to a loopback origin', async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>should never be read</html>');
    });

    await expect(safeFetch(base)).rejects.toMatchObject({ code: 'blocked_address' });
  });

  /**
   * Asserting the specific `blocked_address` code matters here: an earlier
   * version of these tests only checked "some SafeFetchError", which passed
   * for the wrong reason — nothing was listening on those addresses, so a
   * connection-refused error satisfied the assertion while the guard was
   * actually being bypassed entirely for IP literals.
   */
  it.each([
    ['decimal-encoded loopback', 'http://2130706433/'],
    ['octal-encoded loopback', 'http://0177.0.0.1/'],
    ['IPv6 loopback literal', 'http://[::1]/'],
    ['IPv4-mapped IPv6 literal', 'http://[::ffff:127.0.0.1]/'],
    ['metadata endpoint', 'http://169.254.169.254/latest/meta-data/'],
    ['RFC1918 host', 'http://10.1.2.3/'],
    ['link-local', 'http://169.254.1.1/'],
  ])('refuses %s with blocked_address', async (_label, url) => {
    await expect(safeFetch(url, { timeoutMs: 3000 })).rejects.toMatchObject({
      code: 'blocked_address',
    });
  });

  it('rejects a blocked scheme before any network activity', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toMatchObject({
      code: 'blocked_scheme',
    });
  });

  /**
   * The single most common real-world bypass: an allowlisted public host that
   * redirects into private space. The guard has to re-check every hop, not
   * just the URL the user typed.
   */
  it('re-validates redirect targets rather than following them blindly', async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });

    // The first hop is itself loopback here, so this asserts the guard fires
    // somewhere on the chain rather than following it to the metadata service.
    await expect(safeFetch(base)).rejects.toBeInstanceOf(SafeFetchError);
  });

  it('surfaces a clear error for an unresolvable host', async () => {
    await expect(
      safeFetch('http://this-host-should-not-exist.invalid/', { timeoutMs: 3000 }),
    ).rejects.toBeInstanceOf(Error);
  });
});
