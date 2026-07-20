import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Component tests need a real DOM (focus(), document.activeElement,
    // keydown dispatch) — unlike apps/web/apps/api's node environment.
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    // Vitest only defaults NODE_ENV to 'test' when it's unset; a shell that
    // already exports NODE_ENV=production (common in CI) leaks through
    // otherwise, resolving React's production build — which throws on
    // act(...) and breaks every @testing-library/react render.
    env: { NODE_ENV: 'test' },
  },
});
