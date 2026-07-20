import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `@formai/db`/`@formai/shared` resolve to their compiled `dist/` by
  // default (see their package.json `exports`) so the deployed API can run
  // as plain compiled JS instead of live `tsx` transpilation. Tests should
  // exercise current source, not a `dist/` that may be stale or unbuilt —
  // both `resolve` and `ssr.resolve` need the condition since Vitest's
  // node-environment runs go through Vite's SSR resolver.
  resolve: { conditions: ['development'] },
  ssr: { resolve: { conditions: ['development'] } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Force NODE_ENV=test regardless of the ambient shell env — env.ts's
    // production guard (SESSION_SECRET must not be the dev default) should
    // never fire for a test run, and tests should not depend on how the
    // shell that invokes them happens to be configured.
    env: { NODE_ENV: 'test' },
  },
});
