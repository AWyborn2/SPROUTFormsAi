#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { ConfigError, loadConfig } from './config.js';
import { InductionsClient } from './client.js';
import { buildServer } from './server.js';

/**
 * FormAI induction MCP server — stdio entry point.
 *
 * stdout belongs to the protocol here, so every diagnostic goes to stderr. A
 * stray console.log corrupts the message stream and the client disconnects
 * with something far less informative than the message that caused it.
 *
 * For a hosted deployment reachable by a cloud client, see `./express.js`,
 * which serves the same tools over Streamable HTTP.
 */
export { buildServer } from './server.js';

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
