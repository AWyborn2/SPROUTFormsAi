# FormAI Enterprise

Multi-tenant B2B forms platform (PDF-to-form conversion + drag-and-drop builder). Imported from GitHub.

## Project overview
- pnpm monorepo (pnpm 10, Node 20)
  - `apps/web` — React 18 + Vite 6 + Tailwind frontend
  - `apps/api` — Express + tsx backend
  - `packages/db` — Drizzle ORM + postgres-js, migrations in `packages/db/drizzle`
  - `packages/shared`, `packages/ui` — shared code / design tokens
- Frontend dev server: port 5000, host 0.0.0.0, `allowedHosts: true` (required for Replit preview proxy). Vite proxies `/api` → `http://localhost:8000`.
- Backend: Express on localhost port 8000 (repo default was 8787; overridden via `API_PORT=8000` in the workflow because 8787 isn't an allowed Replit port).
- Database: Replit built-in PostgreSQL (`DATABASE_URL` env var). Migrations applied via `pnpm db:migrate`. Repo originally targeted Supabase Postgres; the same drizzle setup works with the Replit DB.
- Optional integrations not yet configured: Supabase storage, WorkOS, Anthropic, Stripe (all optional in `apps/api/src/env.ts`).

## Workflows
- `Start application` — `pnpm dev:web` (webview, port 5000)
- `Backend API` — `API_PORT=8000 pnpm dev:api` (console, port 8000)

## Deployment
- Autoscale. Build: `pnpm --filter @formai/web build`. Run: API via tsx + `vite preview` on 5000.

## User preferences
(none recorded yet)
