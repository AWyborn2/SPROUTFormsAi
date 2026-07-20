---
name: Replit Auth migration
description: How WorkOS was replaced by Replit Auth — design decisions and compat shims.
---

## Rule
WorkOS is gone. Auth is handled entirely by Replit Auth (X-Replit-User-Id / X-Replit-User-Name headers injected by Replit's CDN proxy).

## How it works
- `GET /api/auth/login` → redirects to `https://replit.com/auth_with_repl_site?domain=${host}` using x-forwarded-host.
- After auth, Replit redirects back. Frontend loads, `useSession` calls `GET /api/auth/me`.
- `/auth/me` tries the sealed cookie first; if absent but Replit headers present → auto-provisions user/org and sets cookie.
- Session seal/unseal (AES-256-GCM) lives in `apps/api/src/auth/replit-auth.ts`.
- DB column renamed: `workos_user_id` → `replit_user_id` (migration: `packages/db/drizzle/0001_replit_auth.sql`).
- `workos_org_id` column dropped from organizations table.

## Compat shim
`apps/api/src/auth/workos.ts` is now a thin re-export shim (`export { sealSession, unsealSession } from './replit-auth.js'`).
Existing test files that import `sealSession` from `workos.js` continue to work without changes.

**Why:** Avoids a mass-rename of every test file that only needed sealSession, while keeping the real implementation in one canonical place.

## Dev vs production note
In the dev workspace, the Replit proxy does NOT inject X-Replit-User-* headers into the iframe preview. So `/auth/me` returns 401 in dev until you sign in via the Replit-hosted flow. This is expected behavior.
