import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Requests to /api/* are same-origin from the browser's perspective (works
// identically in dev, the Replit preview, and production, with no CORS and
// no build-time API URL to configure) — vite strips the /api prefix before
// forwarding to the API process, which mounts its routes without one
// (/forms, /team, /auth, ...). See apps/web/src/lib/data/api-client.ts.
//
// The target follows the API's own port. `API_PORT` defaults to 8787 in the API
// (apps/api/src/env.ts) and in .env.example, so the default here matches it; an
// override via env keeps the two in step. `API_PROXY_TARGET` allows a full URL
// override (e.g. an API on another host). The previous hardcoded :8000 did not
// match the API's :8787, so every dev /api call 502'd.
const apiTarget =
  process.env.API_PROXY_TARGET ?? `http://localhost:${process.env.API_PORT ?? '8787'}`;
const apiProxy = {
  '/api': {
    target: apiTarget,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  plugins: [react()],
  // `@formai/shared` resolves to its compiled `dist/` by default (see its
  // package.json `exports`) so the API can run as plain compiled JS. Vite
  // bundles either form fine, but resolving live source here means editing
  // `packages/shared` is reflected immediately without a rebuild step.
  resolve: { conditions: ['development'] },
  server: {
    host: '0.0.0.0',
    port: 5000,
    allowedHosts: true,
    proxy: apiProxy,
  },
  preview: {
    host: '0.0.0.0',
    port: 5000,
    proxy: apiProxy,
  },
});
