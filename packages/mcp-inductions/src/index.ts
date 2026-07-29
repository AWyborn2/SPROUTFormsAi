#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { ConfigError, loadConfig } from './config.js';
import { InductionsClient } from './client.js';
import type { ToolHost } from './tools/host.js';
import { registerCandidateTools } from './tools/candidates.js';
import { registerCohortTools } from './tools/cohorts.js';
import { registerDateTools } from './tools/dates.js';
import { registerBookingTools } from './tools/bookings.js';

/**
 * FormAI induction MCP server.
 *
 * Speaks stdio, so stdout belongs to the protocol — every diagnostic goes to
 * stderr. A stray console.log here corrupts the message stream and the client
 * disconnects with something far less informative than the message that caused
 * it.
 */
export function buildServer(client: InductionsClient): McpServer {
  const server = new McpServer({ name: 'formai-inductions', version: '0.1.0' });
  const host = server as unknown as ToolHost;
  registerCandidateTools(host, client);
  registerCohortTools(host, client);
  registerDateTools(host, client);
  registerBookingTools(host, client);
  return server;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const server = buildServer(new InductionsClient(config));
  await server.connect(new StdioServerTransport());
  console.error(`formai-inductions MCP server ready (${config.apiUrl})`);
}

// Only run when executed directly; importing this module for tests must not
// open a transport. `pathToFileURL` rather than string surgery — a Windows
// path has a drive letter and backslashes that never match `import.meta.url`
// as written.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    if (err instanceof ConfigError) {
      console.error(`formai-inductions: ${err.message}`);
      process.exit(1);
    }
    console.error('formai-inductions: failed to start', err);
    process.exit(1);
  });
}
