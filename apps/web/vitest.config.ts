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
    // Data-layer modules only for now — node is enough (File/Blob are global
    // in Node 20+); switch to jsdom if component tests arrive later.
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts'],
  },
});
