#!/bin/bash
set -e

pnpm install --frozen-lockfile

# MIGRATES WHATEVER `DATABASE_URL` POINTS AT — WHICH IS NOT PRODUCTION.
#
# FormAI runs two databases. In the Replit workspace the ambient `DATABASE_URL`
# points at DEV (`heliumdb`). The published app runs against PRODUCTION
# (`neondb`), whose connection string is NOT this variable. So this line has
# migrated dev on every merge for months, and has never once touched production.
#
# Production is migrated by the DEPLOY (see `[deployment].build` in .replit,
# which runs `pnpm db:migrate` against the deployment's own DATABASE_URL). Until
# 2026-08-13 it was migrated by nothing at all. Its schema nevertheless kept pace,
# because Replit's own agent tooling pushes schema directly, outside this repo —
# and that is the trap: a schema push writes no ledger rows and runs no DML, so
# production's `drizzle.__drizzle_migrations` fell 30 migrations behind a schema
# that was current, and `0042_seed_profiles_category.sql` (data-only) never ran
# at all. Nothing surfaced an error; a permission category was just silently
# denied.
#
# Before assuming any database is current, ask it:
#
#   pnpm db:status --url-env PRODUCTION_DATABASE_URL
#
# See packages/db/src/migration-ledger.ts for the whole story. Nothing about
# this script's behaviour has changed — it is only now documented.
pnpm db:migrate

npm install --prefix artifacts/mockup-sandbox
