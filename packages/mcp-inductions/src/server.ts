import { McpServer } from '@modelcontextprotocol/server';
import type { InductionsClient } from './client.js';
import type { ToolHost } from './tools/host.js';
import { registerCandidateTools } from './tools/candidates.js';
import { registerCohortTools } from './tools/cohorts.js';
import { registerDateTools } from './tools/dates.js';
import { registerBookingTools } from './tools/bookings.js';

export const SERVER_NAME = 'formai-inductions';
export const SERVER_VERSION = '0.1.0';

/**
 * The tool surface, bound to one client.
 *
 * Kept apart from the stdio entry point because the HTTP transport builds a
 * server per request — each with its own client carrying that caller's API key
 * — and must not import a module whose top level can start a stdio process.
 */
export function buildServer(client: InductionsClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const host = server as unknown as ToolHost;
  registerCandidateTools(host, client);
  registerCohortTools(host, client);
  registerDateTools(host, client);
  registerBookingTools(host, client);
  return server;
}
