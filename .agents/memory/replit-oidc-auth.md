---
name: Replit OIDC auth
description: How proper Replit OIDC auth (openid-client v6 PKCE) is wired into the monorepo — replaces auth_with_repl_site.
---

## Rule
Auth uses `openid-client` v6 PKCE flow against `https://replit.com/oidc`. OIDC state is sealed into a short-lived `_oidc` cookie (AES-256-GCM, 10 min TTL) using the existing `sealSession` utility — no express-session or sessions table needed. After the callback, a `fai_session` cookie is issued as before and all downstream middleware (`requireTenant`) is unchanged.

**Why:** `auth_with_repl_site` redirects worked in the workspace but broke in production because the WorkOS integration proxy tried to verify Replit-signed JWTs it didn't understand. Proper OIDC removes the dependency on HTTP headers injected by Replit's proxy.

**How to apply:**
- Login: `GET /auth/login` → `loginHandler` in `apps/api/src/auth/oidc.ts`
- Callback: `GET /auth/callback` → `callbackHandler` in the same file
- The Vite proxy strips `/api/` from all frontend requests, so the browser navigates to `/api/auth/login` → Express sees `/auth/login`
- `SESSION_COOKIE_OPTIONS` is defined once in `auth/oidc.ts` and re-exported from `routes/auth.ts` for backward compat with `account.ts` and `invites.ts`
- `REPL_ID` env var is the OIDC client ID — already present in both dev and production

## Key files
- `apps/api/src/auth/oidc.ts` — OIDC config, loginHandler, callbackHandler
- `apps/api/src/routes/auth.ts` — mounts the handlers, re-exports SESSION_COOKIE_OPTIONS
- `apps/api/src/auth/replit-auth.ts` — sealSession / unsealSession (unchanged)
