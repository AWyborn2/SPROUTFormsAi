import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirror `vite.config.ts` (and `apps/api/vitest.config.ts`): `@formai/shared`
  // resolves to its compiled `dist/` by default, so without this a test would
  // exercise a stale or unbuilt build instead of current source. Both
  // `resolve` and `ssr.resolve` are needed — the node environment goes through
  // Vite's SSR resolver.
  resolve: { conditions: ['development'] },
  ssr: { resolve: { conditions: ['development'] } },
  test: {
    // Node by default — the data-layer suites need no DOM (File/Blob are
    // global in Node 20+). The few component suites opt into jsdom per file
    // with a `@vitest-environment jsdom` docblock, so adding one does not slow
    // down or change the environment of everything else.
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Vitest only defaults NODE_ENV to 'test' when it's unset; a shell that
    // already exports NODE_ENV=production (common in CI) leaks through
    // otherwise, resolving React's production build — which throws on
    // act(...) and breaks every @testing-library/react render.
    env: { NODE_ENV: 'test' },
  },
});
