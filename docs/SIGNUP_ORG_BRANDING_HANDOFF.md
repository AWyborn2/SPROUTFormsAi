# Signup, Organisation Setup & Branding Kit — Handoff

**Shipped:** 2026-07-20 · **Merged as:** `2869c25` (squash of [PR #2](https://github.com/AWyborn2/SPROUTFormsAi/pull/2))
**Plan of record:** `docs/plans/2026-07-20-001-feat-signup-org-branding-plan.md`

---

## 1. What shipped, and why it was needed

Three problems were solved together because they were the same problem wearing different hats: the product's core pitch — *forms carry your brand* — was undeliverable through the actual signup path.

| Problem | State before | State now |
|---|---|---|
| Signup wizard | `/setup` and `/setup/branding` existed as fully-built React screens that **nothing ever routed into**. Signup provisioned the org server-side and dropped users straight into `/app`. | Team signups route into the wizard, which is guarded, resumable, and stamps completion. |
| Branding kit | Persisted in the DB, but logo upload was a stub, fonts were four hardcoded presets (one of which never loaded), and branding rendered only on the public fill page. | Real logo upload with public serving, any Google Font, palette pre-filled from the logo, branding applied to the dashboard chrome, the authed fill surface, and the public fill page. |
| Demo identity | "Meridian Operations" and `forms.meridian.co` leaked through the app as placeholder values. | Removed from all app code. Test fixtures deliberately retain the name — API tests assert on it. |

**Not in scope, deliberately:** PDF/export branding (exports overlay the customer's own PDF, so there is nothing meaningful to brand until a from-scratch export pipeline exists); full workspace retheme; font file upload; trial/billing mechanics. The first three are specced as follow-on phases FP1–FP3 in the plan.

---

## 2. How this was produced

The work ran through the full compound-engineering pipeline rather than straight to implementation:

```
ce-brainstorm  ->  ce-plan  ->  ce-doc-review  ->  ce-work (U1-U9)
                                                      |
                              ce-simplify-code  <-----+
                                      |
                              ce-code-review (13 reviewers)
                                      |
                                   merge
```

Two gates earned their keep and are worth noting for future work:

- **`ce-doc-review` on the plan** caught, *before any code was written*, that freeing the `branding` feature flag would have silently freed white-label too (they shared one flag), and that new invitees would be captured into a wizard for the wrong organisation. Both became requirements instead of bugs.
- **`ce-code-review` after implementation** caught a P0 that would have taken production down on deploy (§5).

---

## 3. Implementation units

Nine units, each landed as its own commit before the squash.

| Unit | What it did |
|---|---|
| **U1** | `team_size` + `onboarding_completed_at` columns (migration `0007`, backfilled so pre-existing orgs never see the wizard); `branding: true` for every plan tier; new `whiteLabel` feature flag. |
| **U2** | `SessionInfo` gained `accountKind`, `branding`, `teamSize`, `onboardingCompletedAt`; `PATCH /org` widened to accept `teamSize` and `onboardingComplete`; the branding plan-gate removed. |
| **U3** | Logo upload end to end — `POST /org/logo` (owner/admin, magic-byte validated) plus a public unauthenticated streaming route; superseded logos cleaned up on replace. |
| **U4** | Google Fonts picker over a bundled catalog snapshot with per-family weights; `ensureFontLoaded` injects stylesheets idempotently. |
| **U5** | Wizard wiring — pending-invite check, team→`/setup` routing, route guard, session hydration, Step 1 persistence, best-effort invite sending, completion stamp, Meridian cleanup. |
| **U6** | Finish-branding nudge in the authed shell for owners who abandoned the wizard. |
| **U7** | Accent-level dashboard chrome and the authed fill surface, via the shared brand-token pipe; added `--org-primary-text`. |
| **U8** | Palette extraction from the uploaded logo, pre-filling only fields still at their defaults. |
| **U9** | Settings surface split — branding block free at every tier (with logo editing), white-label block gated on the new flag. |

---

## 4. Key technical decisions

- **Orgs stay auto-provisioned at signup; the wizard edits rather than creates.** Deferring creation to the wizard would have left users in an org-less limbo state every screen had to handle.
- **A distinct `whiteLabel` plan flag was required.** `PLAN_CONFIG` had only `features.branding`, and white-label had no flag of its own — so freeing branding without adding one would have silently freed custom domains and sender email too.
- **Logo keys are flat (`orgId/logo-<uuid>.ext`, not `orgId/logo/<uuid>.ext`).** The Supabase adapter's `deletePrefix` does a single-level list, so a nested folder would have been silently orphaned at org deletion.
- **The public logo route is namespace-scoped.** It rejects any key not matching `^[^/]+/logo-[^/]+\.(png|jpe?g|webp)$` *before* touching storage. Without that guard, removing auth from `/pdf/asset/*`-style mechanics would let a leaked PDF asset key be replayed unauthenticated.
- **Magic bytes are validated, not the declared MIME**, which is attacker-controlled. SVG is rasterised client-side from its `viewBox` rather than stored, avoiding a stored-XSS vector without a server-side sanitiser dependency.
- **The font catalog stores per-family weights.** A bare-family `css2` request serves only weight 400 while branded surfaces render 500–700, and requesting a weight a static family lacks fails the entire request.
- **Pending invites are checked before the signup routing branch.** The signup form defaults to `team`, so without this a new invitee lands in the wizard for their own throwaway org.
- **Decision logic lives in pure modules.** `apps/web` vitest runs in a node environment with no jsdom, so component rendering is genuinely untestable here. Routing, guard, gating, palette-merge, and font-URL logic were extracted into `onboarding-routing.ts`, `plan-gating.ts`, `palette-extract.ts`, and `font-loader.ts` precisely so they could be tested. This is deliberate, not incidental.

---

## 5. The P0: a migration that would have silently done nothing

**This is the most important thing in this document.**

Migration `0007`'s journal entry was written with `"when": 1753142400000` — **2025**-07-22 — copied forward from `0006`'s stale value. Entries `0000`–`0005` carry **2026** timestamps.

Drizzle's migrator reads the most recent applied `created_at` from `__drizzle_migrations` and applies an entry only when its `folderMillis` exceeds it. On any database already at `0005`, `0007` would therefore have been **silently skipped — exit code 0, no error, no columns created** — while the code shipping alongside it reads `team_size` and `onboarding_completed_at` unconditionally. Every login, `/auth/me`, and `PATCH /org` would have returned 500 with *column does not exist*.

Fixed in `0576cea` by setting a correctly-ordered timestamp (`1784559366081`).

Three things make this worth remembering:

1. **`.agents/memory/drizzle-migration-journal-order.md` already documented a closely-related incident** in this repo. The institutional memory existed; the trap was reproduced anyway.
2. **A clean CI run would not have caught it.** CI runs against an empty database, where the migrator applies everything in order regardless of timestamps. The failure only appears on a database with history — i.e. every real environment.
3. **`0006_plan_tiers` still carries the same defect** (`1753056000000`, 2025-07-21). It was left untouched on purpose: changing an already-applied migration's timestamp can make Drizzle re-run it. See §8.

**Rule for future migrations:** always set `when` to a real current epoch-ms value. Never increment the previous entry's timestamp — if that entry is stale, the new one inherits the bug.

---

## 6. The pre-existing CI failures (diagnosed here, fixed elsewhere)

This branch inherited 15 failing API tests that failed identically on a clean checkout of `main` and on PR #1. They were **stale test fixtures, not product bugs**. Diagnosis:

| Cluster | Count | Root cause |
|---|---|---|
| `competencies` + `audit` | 11 | Each test file hand-rolls a `fakeDb()` for `vi.mock('../db.js')`, and both omit `query.organizations`. Every route in them is wrapped in `requirePlanFeature`, which calls `db.query.organizations.findFirst` — so requests 500 in middleware before the route body runs. `org.test.ts` passed only because its fake happened to include that stub. |
| `team` | 2 | The fake has no `select`, but `team.ts` grew a seat-limit check using `db.select(...)`. Only the two tests setting a truthy org fixture reach it; an `if (org)` guard skips it otherwise. The `insert_failed` in the logs was a red herring — the insert is never reached. |
| `auth` | 2 | Asserted a Replit hosted-login flow that no longer exists (`GET /auth/login`, `x-replit-user-*` auto-provisioning). Already stale at the snapshot commit. |

Another engineer fixed these in PR #3. Merging `main` back into this branch left one conflict: PR #3's new login-characterization test asserted the pre-widening `SessionInfo` shape, while U2 had added four fields. Resolved by updating the expectation — the widening is the intended change.

**Result: the API suite went from 213 passing / 15 failing to 242 passing / 0 failing.** CI is green for the first time in this repository, and the `Verify Drizzle migrations are up to date` step executed for the first time ever (it had always been unreachable behind the failing test step).

---

## 7. Code review

13 reviewers (correctness, testing, maintainability, project-standards, agent-native, learnings, security, api-contract, data-migration, reliability, performance, adversarial, deployment-verification), with every surviving finding independently validated. No cross-model pass — no peer CLI available on the machine.

**Applied before merge:** the P0 above, plus six P2s —

- `onboardingComplete` was a read-then-write TOCTOU; two concurrent PATCHes could both stamp. Now enforced by the UPDATE itself via `isNull` + `.returning()`.
- Every non-rename `PATCH /org` was audited as `'Branding kit'`, so a team-size-only change was logged as a branding edit. Target now derived honestly; no audit row on a no-op.
- `logoAssetUrl` accepted **any string**, letting an admin point their org at another org's logo key and bypass the upload path. Now validated against the minted URL shape plus a same-tenant prefix check.
- Superseded-logo deletion was awaited before responding, putting storage latency on the response path for a result never used.
- The public fill masthead hardcoded `text-white` over `var(--org-primary)`, ignoring the contrast token — unreadable on a light brand primary.
- **The uploaded logo never rendered on the public fill page** — the very surface the public logo route exists to serve.

Seven tests were added alongside these fixes.

A prior `ce-simplify-code` pass had already applied four cleanups: a shared `channelLuminance` helper, `MAX_LOGO_BYTES` moved to `packages/shared`, a misplaced JSDoc block, and removal of a redundant 2 MB buffer copy per upload.

---

## 8. Open items

### Needs a decision (P1)

**Invitee signup mints an orphan organisation.** A new invitee has no account, so they sign up first — the form defaults to `team`, provisioning a throwaway org before they accept the invite. The pending-invite check stops them being *routed* into the wizard, but the orphan org persists, and `provisionTenant`'s membership lookup has no `ORDER BY`, so a multi-membership user's next login resolves non-deterministically. Fix needs a design call: pass the invite token to `POST /auth/signup` so the invitee is provisioned into the inviting org, and make tenant resolution deterministic.

**Deploy-order window on the backfill.** `0007` stamps every org with a NULL `onboarding_completed_at` as onboarded. If the API deploys *before* the migration runs, team orgs created in that window are permanently locked out of the wizard. Mitigation: scope the backfill with an age predicate or release cutoff, and gate the migration to run strictly before the API. Recovery is `UPDATE organizations SET onboarding_completed_at = NULL WHERE id = $1`. **This fires exactly once, at rollout.**

### Verify before relying on plan tiers

`0006_plan_tiers` retains its out-of-order timestamp, so on any database already at `0005` it was silently skipped — meaning `plan_tier` / `seat_limit` / `account_kind` may not exist, and the branding tier logic reads `planTier`.

```sql
\d organizations   -- confirm plan_tier, seat_limit, account_kind exist
SELECT count(*) FROM organizations WHERE onboarding_completed_at IS NULL;  -- expect 0 after 0007
```

If columns are missing, `.agents/memory/drizzle-migration-journal-order.md` prescribes the idempotent remedy: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`.

### Deferred (P2/P3, not blocking)

- Stale wizard snapshot can revert branding and delete the live logo object — the hydration latch is all-or-nothing across fields. Narrow race; no reliable trigger was constructed.
- White-label fields are gated and upsold in the UI but never persisted; `customDomain` / `senderEmail` live only in React context. **The client-side gate needs a server-side counterpart the moment they gain persistence.**
- The pending-invite token is consumed during render in `RootRedirect`; React StrictMode's double-render can drop it. Pre-existing.
- `logo-image.ts` ships with no test coverage despite pure, DOM-free validation branches.
- The branded preview panel is duplicated between `BrandingScreen` and `WhiteLabelScreen`.
- `AppShell` hardcodes "Business plan" under every org name regardless of tier. Pre-existing.

### Systemic residual risks

- Role is trusted from a 7-day sealed cookie and never re-checked against `memberships`, so a demoted admin retains write access for up to a week. Pre-existing and app-wide; this work adds two more consumers of that stale claim.
- Public logo assets are served `Cache-Control: immutable, max-age=1y`, so removing a logo is not a reliable takedown.
- No rate limiting on `POST /org/logo`.
- No timeouts anywhere in the storage adapters or the web fetch wrapper.
- **No web test job in CI** — only API tests run. Client logic is guarded solely by locally-run vitest.

---

## 9. Verification at merge

| Gate | Result |
|---|---|
| `pnpm typecheck` | Clean, all five workspace projects |
| `pnpm build` | Clean |
| API tests | 242 / 242 passing |
| Web tests | 104 / 104 passing |
| Drizzle drift check | Passing (first execution ever) |
| Meridian sweep | `rg -l Meridian apps/ --glob '!*.test.*'` returns nothing |

One pre-existing web suite, `ImportReviewScreen.test.ts`, fails to load on `DOMMatrix is not defined` from `pdfjs-dist`. It contributes zero tests and fails identically on a clean tree.

**Note for Windows contributors:** `pnpm build` fails under PowerShell because `packages/shared`'s build script uses POSIX `rm -rf`. Run it from Git Bash. This is unchanged from before this work.

---

## 10. Note for the next migration

PR #1 (`fix/import-fill-builder-integrity`) needs its migration renumbered to `0008` now that `0007` has landed. **Give it a real 2026 epoch-ms timestamp — do not increment `0007`'s**, or it reproduces §5 exactly.
