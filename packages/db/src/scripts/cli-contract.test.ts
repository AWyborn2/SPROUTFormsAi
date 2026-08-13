/**
 * The one thing worth spending a subprocess on: that BOTH scripts actually
 * refuse to start without a named database. `resolveDatabaseUrl` is unit-tested
 * next door, but a script that forgot to call it would still pass those tests
 * and would still connect to whatever `DATABASE_URL` happened to be — which is
 * the exact failure these tools exist to prevent.
 *
 * These runs never open a socket: the refusal happens before any connection.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

async function runScript(file: string): Promise<{ code: number; stderr: string }> {
  try {
    await run(
      process.execPath,
      [
        path.resolve(HERE, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(HERE, file),
      ],
      {
        // A deliberately populated ambient DATABASE_URL: the scripts must
        // ignore it, not use it.
        env: { ...process.env, DATABASE_URL: 'postgres://ambient/heliumdb' },
      },
    );
    return { code: 0, stderr: '' };
  } catch (err) {
    const e = err as { code?: number; stderr?: string };
    return { code: e.code ?? -1, stderr: e.stderr ?? '' };
  }
}

describe.each(['db-status.ts', 'db-baseline.ts'])('%s', (file) => {
  it('refuses to run without an explicit database URL, ignoring the ambient one', async () => {
    const { code, stderr } = await runScript(file);
    expect(code).toBe(2);
    expect(stderr).toContain('No database named');
    expect(stderr).toContain('DATABASE_URL is deliberately NOT used as a fallback');
  }, 60_000);
});
