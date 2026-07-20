import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Data-layer modules only for now — node is enough (File/Blob are global
    // in Node 20+); switch to jsdom if component tests arrive later.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
