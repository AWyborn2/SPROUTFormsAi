---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
title: "feat: Wire a real database connection and run migrations"
plan_type: feat
created: 2026-07-15
---

# feat: Wire a real database connection and run migrations

## Summary

FormAI Enterprise's Drizzle schema, migration pipeline, and DB client factory are already fully built (`packages/db`) but nothing has ever run them against a live database, and `apps/api` never constructs or holds a DB connection — `DATABASE_URL` is read into env and then unused. This plan closes that gap only: provision/point a real Postgres at the app, apply the existing migrations, and wire `apps/api` to hold a live client at boot with a health signal. It intentionally stops there — no auth, no domain API routes, no web wiring. Those are separate, later plans that this one unblocks.

---

## Problem Frame

The current dev environment (Replit) has no confirmed live database. `packages/db` exports `createDb(connectionString)` (Drizzle + `postgres-js`) and a complete schema (organizations, users, memberships, form_templates + versions, submissions, competencies, competency_rules, role_permissions, audit_log_entries) with one generated migration (`packages/db/drizzle/0000_neat_hellion.sql`), but:

- No process has ever run `pnpm db:migrate` against a real instance — schema-vs-database drift is unverified.
- `apps/api/src/app.ts` never calls `createDb()`; there is no shared DB client any route could import.
- `DATABASE_URL` is optional in `apps/api/src/env.ts` and CI never exercises a live-DB path (its "Drizzle drift" check only runs `drizzle-kit generate`, which diffs the schema file against migration snapshots — no connection required).

Every future phase (auth/tenant middleware, forms/submissions API, enterprise API, PDF storage) depends on a working DB connection existing first. This plan is that unblock.

---

## Requirements

- **R1**: A real Postgres instance is reachable from `apps/api` via `DATABASE_URL` in the current dev environment (Replit).
- **R2**: The existing Drizzle migration(s) apply cleanly against that instance, producing a schema that matches `packages/db/src/schema` exactly.
- **R3**: `apps/api` constructs a single shared DB client at boot using `createDb()` and exposes its connectivity state without crashing the process when `DATABASE_URL` is absent or the DB is unreachable.
- **R4**: No existing route (`/health`, `/pdf`) changes behavior for a caller that doesn't care about DB state.

---

## Key Technical Decisions

**KTD1 — Target Replit's built-in Postgres for this environment, not Supabase.** `drizzle.config.ts` and `createDb()` both take a plain `DATABASE_URL` connection string and are provider-agnostic (standard `postgresql` dialect over `postgres-js`) — no *schema* change is needed to point at Replit's addon instead of Supabase, and no code change is anticipated. `createDb()`'s connection options (e.g., SSL mode) may still need a small adjustment if Replit's instance requires it — see the Risk below, which is the one place this decision could touch code. Supabase remains the documented target for the eventual production environment (object storage, connection pooling) but is out of scope here; switching later is a config change, not a migration.

**KTD2 — `DATABASE_URL` stays optional; the API degrades, it doesn't crash.** `apps/api/src/env.ts` already types `DATABASE_URL` as optional. Keep it that way for this phase rather than promoting it to required — the API must still boot cleanly in any environment (e.g., a future CI job, a fresh clone) where a DB hasn't been provisioned yet. The new DB module treats an absent `DATABASE_URL` as an explicit `unconfigured` state, not an error.

**KTD3 — No migrate-on-boot.** Migrations are applied explicitly via the existing `pnpm db:migrate` (drizzle-kit CLI) script, run once against the environment, not automatically from `apps/api` at process startup. This keeps "deploy the API" and "change the schema" decoupled and avoids concurrent-boot migration races — consistent with how `db:generate`/`db:migrate` are already split out as standalone scripts.

**KTD4 — Extend `/health` rather than adding a new endpoint.** `/health` is the one existing route any deployment/monitoring tooling would already point at. Add DB connectivity as a field on its existing response rather than introducing a second health surface.

---

## Implementation Units

### U1. Provision and migrate the database

**Goal:** A real Postgres instance exists in the dev environment, `DATABASE_URL` points at it, and the existing migration has been applied and verified.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- `.env.example` — add a short note that `DATABASE_URL` may point at any standard Postgres (Replit's built-in DB in dev; Supabase in production), not Supabase-only as currently implied.

**Approach:** This unit is primarily operational, not code:
1. Provision/enable a Postgres instance in the Replit environment (Replit's built-in Database tool auto-populates a `DATABASE_URL` secret when enabled).
2. Confirm `DATABASE_URL` is present in the environment `apps/api` and `packages/db` read from (`process.env`).
3. Run the existing migration: `pnpm db:migrate` (root script → `drizzle-kit migrate`, reading `packages/db/drizzle.config.ts`, which already sources `DATABASE_URL`).
4. Verify against the live database that every table in `packages/db/src/schema/index.ts` exists with the expected columns (e.g., `organizations`, `users`, `memberships`, `form_templates`, `form_template_versions`, `submissions`, `competencies`, `competency_rules`, `role_permissions`, `audit_log_entries`).

**Execution note:** This is an environment/infra step with no unit test of its own — the check is direct inspection (a `\dt` / information_schema query, or `pnpm --filter @formai/db studio`) confirming table presence and column shape, not an automated test file. Record any deviation from the schema (a table Drizzle didn't create, an unexpected error) as a blocker back to the schema, not silently worked around.

**Patterns to follow:** `packages/db/drizzle.config.ts` already wires `dbCredentials.url` to `process.env.DATABASE_URL` with `casing: 'snake_case'` — no changes needed there.

**Test scenarios:**
Test expectation: none — this unit provisions infrastructure and applies a pre-existing, already-reviewed migration; there is no new behavior to unit test. Verification is the manual schema inspection described above.

**Verification:** `pnpm db:migrate` exits 0 with no errors. A direct query against the live database lists all tables from `packages/db/src/schema`, and `pnpm --filter @formai/db generate` (the CI drift check) reports no pending schema changes.

---

### U2. Wire a shared DB client into `apps/api` at boot

**Goal:** `apps/api` constructs one shared `Db` instance via `createDb()` when `DATABASE_URL` is present, exposes it for future routes to import, and reports its connectivity state on `/health` — without ever crashing boot.

**Requirements:** R3, R4

**Dependencies:** U1 (needs a real, migrated database to verify connectivity against; the code itself can be written in parallel but verification depends on U1)

**Files:**
- `apps/api/src/db.ts` (new) — constructs and exports the shared `Db` client (or `null` when unconfigured), plus a small connectivity check.
- `apps/api/src/routes/health.ts` (modify) — extend the response to include DB state.
- `apps/api/src/db.test.ts` (new) — test file for this unit.

**Approach:** Add a small module that:
- Exposes a `checkDbConnection(client: Db | null)` function that takes an explicit client argument rather than reading a module-level singleton — this is what makes the three states (below) directly testable without an env-injection or module-reset trick, since neither `apps/api/src/env.ts` nor `apps/api/src/anthropic.ts` currently demonstrate a pattern for swapping their singleton per test. It runs a trivial query (e.g., `select 1`) against the client and resolves to `'connected' | 'error' | 'unconfigured'` (`null` client → `'unconfigured'` without attempting a connection; a rejecting query → `'error'`, never a thrown exception).
- Separately, constructs the real singleton once at import time — `createDb(env.DATABASE_URL)` when `DATABASE_URL` is set, else `null` — and exports it as `db: Db | null`, mirroring `apps/api/src/anthropic.ts`'s `getAnthropic()` lazy, fail-soft construction. Production code (`health.ts`) calls `checkDbConnection(db)`; tests call `checkDbConnection(...)` with a mocked client or `null` directly, without touching the module singleton at all.
- `health.ts`'s handler awaits `checkDbConnection(db)` and includes the result in the JSON response (e.g., `{ status: 'ok', service: 'formai-api', db: 'connected' }`), keeping the existing `status`/`service` fields unchanged so current callers aren't broken. `/health` keeps returning HTTP 200 regardless of the `db` value (`'connected' | 'error' | 'unconfigured'` are all reported in the body, not the status code) — this is a deliberate choice to satisfy R4's "no behavior change for callers that don't inspect `db`" guarantee; a future phase that wires `/health` into a readiness probe can add a stricter status-code contract then, without this plan pre-committing to one.

**Execution note:** Add characterization coverage for both states (configured vs. unconfigured) — this is new integration surface (API boot ↔ DB), so prove both branches before considering it done, not just the happy path.

**Patterns to follow:** `apps/api/src/anthropic.ts`'s `getAnthropic()` — lazy client construction that returns `null` when its env var is absent, exactly the shape `db.ts` should mirror for `DATABASE_URL`. `apps/api/src/pdf/*.test.ts` for the existing vitest conventions (`describe`/`it`, `vi.fn()` mocks) to match in `db.test.ts`.

**Test scenarios:**
- Happy path: `checkDbConnection(client)` called with a mocked client whose query resolves successfully returns `'connected'`.
- Configuration edge case: `checkDbConnection(null)` returns `'unconfigured'` without attempting a connection (no query call on the mock).
- Failure path: `checkDbConnection(client)` called with a mocked client whose query rejects returns `'error'`, not a thrown exception.
- Integration: `GET /health` (via `createApp()` + a request, matching the existing route-test pattern if one exists, or a direct handler-level test) always returns HTTP 200 with the `db` field reflecting whichever of the three states the wired-in client produces, while leaving `status`/`service` unchanged.

**Verification:** `pnpm --filter @formai/api typecheck` and `pnpm --filter @formai/api build` pass. `pnpm --filter @formai/api test` passes, including the new `db.test.ts`. Manually hitting `GET /health` in the Replit dev environment (post-U1) returns `db: "connected"`; temporarily unsetting `DATABASE_URL` and restarting still boots the API and returns `db: "unconfigured"`.

---

## Scope Boundaries

**In scope:** Provisioning/pointing a real Postgres at the app, applying the existing migration, and giving `apps/api` a live, health-checked DB client other code can build on.

**Out of scope — explicitly deferred to later plans (per the user's own stated roadmap):**
1. WorkOS auth + real tenant middleware (`apps/api/src/middleware/tenant.ts` stays a stub after this plan).
2. Forms/templates/submissions API routes and the corresponding `apps/web` fixture-store → fetch wiring.
3. Team/roles/audit/competency API routes and their web wiring.
4. PDF storage wiring (Supabase Storage / object storage for source PDFs).
5. Billing (Stripe).

None of these are touched by this plan; the DB client this plan produces is unused by any route until the next phase starts consuming it.

### Deferred to Follow-Up Work

- Seeding the database with any initial data (e.g., default `role_permissions` rows via `defaultMatrixFor`) is naturally part of the auth/tenant phase (org creation needs to happen before seeding makes sense) — not this plan.
- Promoting `DATABASE_URL` from optional to required in `env.ts` once every environment (including CI, if it ever runs against a live DB) reliably provisions one.

---

## Risks & Dependencies

- **Risk:** Replit's built-in Postgres may have connection-pooling or SSL requirements `postgres-js` needs specific options for (e.g., `ssl: 'require'`). Mitigate by checking the actual connection error during U1/U2 verification and adjusting `createDb()`'s options only if needed — don't pre-guess unfamiliar SSL flags into the code before seeing a real failure.
- **Dependency:** This plan assumes the Replit environment used to verify it is the same one already inspected in this session (the `SPROUTFormsAi` repl with the existing `.replit` workflow config). If verification happens in a different environment, U1's provisioning step must be redone there.

---

## Verification Contract

- `pnpm -r typecheck` passes across all packages.
- `pnpm --filter @formai/api build` and `pnpm --filter @formai/web build` both still succeed (no regression to existing builds).
- `pnpm --filter @formai/api test` passes, including new coverage from U2.
- `pnpm db:migrate` has been run once against a real `DATABASE_URL` in the dev environment, and a direct inspection confirms every table in `packages/db/src/schema` exists.
- `GET /health` returns `db: "connected"` when a valid `DATABASE_URL` is set and the DB is reachable, and `db: "unconfigured"` when it is not — in neither case does the API fail to boot or crash.
- The CI "Verify Drizzle migrations are up to date" step continues to pass unmodified.

## Definition of Done

All six Verification Contract items are true, and no route's existing behavior (`/health`'s `status`/`service` fields, `/pdf`'s endpoints) has changed for callers that don't inspect the new `db` field.

---

## Sources & Research

- `packages/db/src/client.ts`, `packages/db/drizzle.config.ts`, `packages/db/src/schema/*` — existing, unmodified DB scaffolding this plan builds on.
- `apps/api/src/env.ts`, `apps/api/src/app.ts`, `apps/api/src/anthropic.ts`, `apps/api/src/routes/health.ts` — existing API scaffolding and the fail-soft client pattern (`getAnthropic()`) this plan mirrors.
- `.github/workflows/ci.yml` — confirms the current Drizzle CI check (`drizzle-kit generate` diff) needs no `DATABASE_URL` and is unaffected by this plan.
- No external research was needed — this unit is entirely grounded in existing, already-designed local scaffolding (schema, client factory, migration pipeline) with no unsettled technology choice.
