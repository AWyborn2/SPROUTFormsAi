---
name: Custom email/password auth (Clerk removed)
description: Clerk was fully replaced by custom bcrypt email/password auth in July 2026.
---

Clerk has been completely removed. The app now uses self-managed email+password auth.

**Why:** User requested full Clerk removal in favour of custom auth with no third-party dependency.

**What replaced it:**
- `bcryptjs` (cost 12) for password hashing
- `POST /auth/signup` + `POST /auth/login` in `apps/api/src/routes/auth.ts`
- `GET /auth/me` now just unseals the `fai_session` cookie — no Clerk calls
- `UserProfile { name, email, orgName? }` replaces `ClerkUser` in `replit-auth.ts`
- `provisionTenant` now looks users up by `email` (unique), not `clerkUserId`
- Frontend: plain `fetch('/api/auth/login|signup')` in `LoginScreen.tsx`, no Clerk SDK
- `<ClerkProvider>` removed from `main.tsx`

**DB changes (migration 0005_custom_auth.sql):**
- `clerk_user_id` made nullable (column kept for now)
- `password_hash text` column added to `users`
- `email` column made `UNIQUE`

**Packages removed:** `@clerk/express`, `@clerk/clerk-react`, `http-proxy-middleware`

**Backend API workflow:** Must be configured WITHOUT `waitForPort` via `configureWorkflow` — Replit's port detector times out on port 8000 when `waitForPort` is set, even though the server starts fine. Use `outputType: "console"` with no `waitForPort`.

**How to apply:** Do not re-add Clerk. For password resets, implement a token-based email flow using the existing `resend` package already in `apps/api`.
