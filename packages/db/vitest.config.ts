import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The migration-ledger logic is pure — file contents and ledger rows in,
    // a report out — so the fast node environment is enough, matching
    // packages/shared and apps/api.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Vitest only defaults NODE_ENV to 'test' when it's unset; force it so a
    // shell that already exports NODE_ENV never leaks through.
    env: { NODE_ENV: 'test' },
  },
});
