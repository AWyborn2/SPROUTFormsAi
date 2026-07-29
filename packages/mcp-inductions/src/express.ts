import { Router } from 'express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { bearerToken } from './auth.js';
import { InductionsClient } from './client.js';
import { buildServer } from './server.js';

/**
 * The same six tools, served over Streamable HTTP instead of stdio.
 *
 * stdio requires the client to spawn a local process, which rules out any
 * hosted client — Cowork, a browser-based agent, anything running somewhere
 * other than the operator's laptop. Mounting this on the API means the tools
 * are reachable wherever the API already is, with no second deployment and no
 * second credential system.
 *
 * Two properties are load-bearing:
 *
 * 1. STATELESS, ONE SERVER PER REQUEST. Each request carries its own API key,
 *    so the client — and therefore everything the tools can see — is built
 *    from that caller's credential and thrown away with the response. A
 *    long-lived server shared across requests would be one bug away from
 *    answering one workspace's question with another's data.
 *
 * 2. THE TOOLS STILL GO THROUGH HTTP. They call the API back over loopback
 *    rather than reaching for the database, so tenancy, permissions,
 *    redaction, and audit keep exactly one implementation. The extra hop is a
 *    local socket; the alternative is a second copy of the rules that has to
 *    be kept in step with the first.
 */
export interface InductionMcpRouterOptions {
  /**
   * Where the tools send their calls — normally the API's own loopback
   * address, so the request never leaves the host.
   */
  apiUrl: string;
}

export function inductionMcpRouter(options: InductionMcpRouterOptions): Router {
  const router = Router();

  router.post('/', async (req, res) => {
    // The caller's own key is forwarded verbatim. This router mints no
    // authority of its own: whatever the key could reach directly, it reaches
    // here, and nothing more.
    const apiKey = bearerToken(req.header('authorization'));
    if (!apiKey) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }

    const server = buildServer(new InductionsClient({ apiUrl: options.apiUrl, apiKey }));
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    // A client that hangs up mid-response would otherwise leave the transport
    // and its server holding the socket.
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('mcp transport error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    }
  });

  // Streamable HTTP reserves GET for the server-to-client event stream and
  // DELETE for ending a session. This deployment is stateless, so it has
  // neither — answering 405 tells a client that plainly instead of letting it
  // wait on a stream that will never carry anything.
  router.all('/', (_req, res) => {
    res.status(405).json({ error: 'method_not_allowed', detail: 'This MCP endpoint is stateless; use POST.' });
  });

  return router;
}
