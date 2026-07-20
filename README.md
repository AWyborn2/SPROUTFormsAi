# FormAI Enterprise

Multi-tenant B2B SaaS for digitising forms two ways: **AI-powered PDF-to-form
conversion** (audit-grade round-trip fidelity — the proven differentiator) and a
**from-scratch drag-and-drop builder**.

> See [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) for the full
> v1 blueprint, data model, and phased roadmap.

## Monorepo layout

```
/apps
  /web        React + TypeScript + Vite SPA          (@formai/web)
  /api        Node + Express backend                 (@formai/api)
/packages
  /ui         design-system layer (tokens + React)   (@formai/ui)
  /db         Drizzle schema + migrations            (@formai/db)
  /shared     shared TypeScript types                (@formai/shared)
```

## Stack

- **Frontend**: React 18 · TypeScript · Vite · React Router · TanStack Query · Tailwind (token-driven)
- **Backend**: Node · Express · TypeScript
- **Database**: Supabase Postgres via Drizzle ORM (WorkOS owns identity; Supabase is data + storage only)
- **Auth**: WorkOS (multi-tenant orgs, SSO/SCIM-ready)
- **AI**: Claude API (server-side only) for PDF field extraction
- **Payments**: Stripe

## Getting started

```bash
pnpm install                 # install all workspaces
cp .env.example .env         # fill in secrets
pnpm typecheck               # type-check every package
pnpm dev                     # run web + api in parallel
```

- Web dev server: http://localhost:5173
- API dev server: http://localhost:8787

## Workspace scripts

| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` across all packages |
| `pnpm build` | Build every package |
| `pnpm dev:web` / `pnpm dev:api` | Run one app |
| `pnpm db:generate` | Generate a Drizzle migration from schema changes |
| `pnpm db:migrate` | Apply migrations |

## Status

**Phase 0 — Foundation** (this milestone): monorepo, shared types, Drizzle
schema, design-system layer, both app shells, keyboard scaffolding. Feature
phases (onboarding, core loop, PDF pipeline, admin, competency, mobile) follow —
see the implementation plan.