---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: pr-21-conflict-review
title: "feat: land PR #21 on top of main's Replit Auth migration"
date: 2026-07-16
depth: deep
origin: docs/plans/2026-07-16-001-feat-wire-prototype-ui-to-api-plan.md
---

# feat: land PR #21 on top of main's Replit Auth migration

**Status:** landed 2026-07-16 in merge commit `acd90bd` on `feat/wire-prototype-ui-to-api`. D1 decided — **token-bound invites**; M3/M5 refined mid-flight (see the refinement note under D1). M1–M8 complete; PR #21 reports no conflicts against main and CI is green.

Two items from M2 and M6 could not be settled from the repo and are carried to PR #21's merge checklist: whether main's unjournaled `0001_replit_auth` was actually applied to the deployed database (the repaired journal now asserts it was), and which Supabase bucket production really uses after main's drive-by default change.

**Product Contract preservation:** [PR #21](https://github.com/AWyborn2/SPROUTFormsAi/pull/21) implements all 15 units of [the wiring plan](2026-07-16-001-feat-wire-prototype-ui-to-api-plan.md) and is green on its own merge-base (`ec1322d`). While it was in flight, main replaced WorkOS with Replit Auth (`effdca7`, a Replit Agent full checkpoint). This plan covers what it takes to land PR #21 on current main — nothing here revisits PR #21's own scope.

---

## Problem Frame

`git merge-tree origin/main HEAD` reports **8 conflicting files**. The file count is misleading in both directions.

Three of the eight are trivial: main's auth commit rewrote the string "WorkOS" to "Replit Auth" inside comments and one fixture row, in code PR #21 had already deleted or rewritten (`apps/web/src/lib/data/fixtures.ts`, `apps/web/src/lib/data/store.ts`, `apps/api/src/routes/team.ts`). These resolve to "take ours" with no thought.

The other five are not textual conflicts at all — they are one architectural conflict wearing five filenames. **U10's entire design premise no longer exists on main.** Two further problems don't show up as conflicts and would land silently.

### The identity premise is gone

KTD6 of the origin plan built persistent invites on a verified email assertion from the identity provider: attach an invite to a placeholder `users` row, then let the first *verified* login claim it by email match. The plan was explicit that this is an authorization decision, not a display concern — "Email is an authorization input here, not display data, so the precondition is mechanical, not assumed."

Main's `apps/api/src/auth/replit-auth.ts` reads the `X-Replit-User-*` proxy headers and says:

> Replit Auth does not expose email; use a deterministic placeholder so downstream code that expects an email field always gets a valid string.

```ts
const email = `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}@replit.user`;
```

So on current main:

1. **There is no email to match on.** `users.email` is now derived from the Replit *username*, not asserted by anyone. An invite to `dana@meridian.co` can never be claimed, because no Replit login will ever present that address. The invite persists, the Resend email (U15) tells the invitee to "sign in with this address," and nothing links them. That is precisely the "app confirms an action it did not perform" failure the origin plan exists to eliminate — reintroduced at a new layer.
2. **There is no `emailVerified` to gate on.** The claim step's security precondition has no source. Porting the branch's `emailVerified` check means inventing a value, which is worse than not checking.
3. **A naive port is a privilege-escalation vector.** The synthesized address is a pure function of an attacker-choosable Replit username. If any invite is ever issued to a `…@replit.user` address, registering that username claims the invited membership — role and all. Narrow today, but it's a live footgun that grows teeth the moment someone tests the invite flow with a `@replit.user` address.

**U10 and U15 cannot be conflict-resolved. They need a redesign (D1).**

### Two silent landmines

**The migration journal.** Main added `packages/db/drizzle/0001_replit_auth.sql` but **never added it to `meta/_journal.json`** — main's journal still lists only `0000_neat_hellion`. PR #21's journal lists `0001_flowery_chat` and `0002_magical_jack_murdock`. Git merges the journal cleanly (main didn't touch it), so the merge result silently ends with:

- two files claiming the `0001` slot,
- main's Replit Auth migration orphaned — never applied by `drizzle migrate`,
- and `0001_flowery_chat.sql` running `ALTER TABLE "users" ALTER COLUMN "workos_user_id" DROP NOT NULL` against a database where main's migration already renamed that column to `replit_user_id`. It fails, or worse, silently no-ops depending on how the deployed DB was actually brought up.

Nothing about this conflicts. It merges green and breaks at deploy.

**`apps/api/src/env.ts` auto-merges into a lie.** Main deleted the `WORKOS_*` vars; PR #21 added `RESEND_*`. Git takes both edits without complaint, which is correct line-wise. But main also changed `SUPABASE_STORAGE_BUCKET_PDFS`'s default from `form-pdfs` to `pdfs` — which U11's new `deletePrefix` cleanup targets. Worth an explicit look rather than a shrug.

### What is *not* affected

Phases 1–3 and 5 of PR #21 — the PDF import wizard (U1–U4), round-trip export (U5), approve/reject (U6), dashboard (U7), builder (U8), org settings (U9), deletion hardening (U11), and fill links / mobile (U12–U14) — touch none of this. PR #21 does not modify `routes/auth.ts`, `LoginScreen.tsx`, or `middleware/tenant.ts`, so main's rewrites of those apply cleanly. **The priority-1 acceptance path is untouched by this collision.**

---

## Decisions Required

### D1 — How do invites work without an email-asserting identity provider? — **DECIDED: token-bound invites** (2026-07-16)

**Decision: token-bound invites.** Email leaves the authorization path entirely and becomes a delivery channel. M7 below is the implementing unit; M3/M4/M5 resolve against this choice. Rationale as originally argued:

**Refinement during M3 (2026-07-16) — no placeholder `users` rows; a dedicated `invites` table.** This plan originally said token-bound invites would "still need a placeholder row but key the claim on the token," carrying U10's placeholder-`users` structure across. Working it through, that structure reintroduces the exact vulnerability class D1 exists to remove, in two ways:

1. **Attach-by-email on an existing user.** U10 looked up `users` by the invited email and attached the `invited` membership directly. Under Replit Auth, a claimed invitee's row carries the *real* email from their original invite — so a second org inviting that address attaches a membership to a row whose email ownership was never verified by anyone.
2. **Pre-attached memberships bind before authorization.** If the membership row exists before the token is presented, it already points at a `userId`. Should that row have been guessed wrong, the *real* invitee clicking the correct link activates *someone else's* membership.

Both dissolve if no membership exists until acceptance. `invites` therefore holds `(orgId, email, role, token, expiresAt)` and nothing else; the membership is created at accept time, bound to the authenticated session that presented the token. Email is then structurally incapable of authorizing anything — it is a column on an invite, not a join key to an identity.

Consequences: M3 takes main's `users` table verbatim (that conflict disappears), `replitUserId` stays `notNull`, the `users_email_placeholder_uq` index is dropped, PR #21's `0001_flowery_chat` migration is deleted rather than rewritten, M5 shrinks to removing U11's placeholder cleanup (org deletion cascades `invites` via FK), and `GET /team/members` must union active memberships with pending invites to keep U10's "invited member visible after reload" behavior.

**Recommended: token-bound invites.** Invite creation mints an unguessable token (exactly the machinery U12 already built for fill links) and stores the *real* destination email on the invite row as a delivery address only. U15's Resend email carries the link. The invitee clicks it, signs in with Replit, and the callback binds their `replitUserId` to the invited membership by **token possession**, not by email match.

Why this over the alternatives:
- It removes email from the authorization path entirely — which was already the subtle, load-bearing part of KTD6, and is now the broken part.
- It is provider-agnostic. If Replit Auth is later swapped again (this is the second provider in one week), a token-bound invite survives; an email-bound one does not.
- It keeps U15 honest: the email becomes a delivery channel, which is a promise Resend can actually keep, rather than an identity claim.
- It reuses U12's token generation, expiry, and revoke patterns, so the new surface is small.

Alternatives, for the record:
- **Invite by Replit username.** Matches what the provider actually asserts, but usernames are mutable and the inviter rarely knows them. Rejected.
- **Defer invites entirely.** Ship U1–U9 and U11–U14, drop U10/U15 from PR #21. Cheapest path to the acceptance test; costs the team-management story. Viable if the priority is proving phase 1 in production this week.

Note either way: `users.email` on main is synthetic (`username@replit.user`). Any screen showing a member's email now shows a fake address. That's a pre-existing main problem, not PR #21's, but the Team screen will make it visible — flag it, don't silently absorb it.

---

## Implementation Units

### Phase 0 — Mechanical merge (no design decisions)

### M1. Take-ours on the three trivial conflicts
**Goal:** Resolve `fixtures.ts`, `store.ts`, `team.ts` conflicts. Main's edits are comment/string renames inside regions PR #21 deleted (`SEED_AUDIT_LOG`) or rewrote (the "invite is not wired" header comments — no longer true).
**Dependencies:** none
**Approach:** Take PR #21's side. Confirm no surviving comment still describes invites as unimplemented.

### M2. Migration renumber and journal repair
**Goal:** One coherent migration ordering that applies cleanly to both a fresh DB and the deployed one.
**Dependencies:** none (do before M3 — M3's schema decisions follow from this)
**Approach:** Establish first, by inspecting the deployed database, **whether main's `0001_replit_auth.sql` was ever applied** or whether Replit's agent used `drizzle push` and left the journal behind. That fact determines everything downstream. Then: journal main's `0001_replit_auth`, renumber PR #21's migrations to `0002`/`0003`, and rewrite the ex-`0001_flowery_chat` against `replit_user_id` (or delete it outright — see M3; if D1 lands token-bound, the nullable-user-id migration may not be needed at all).
**Test scenarios:**
- `drizzle migrate` from empty applies 0000 → replit auth → PR #21's two, clean.
- The deployed DB's actual `users` columns match the journal's claim.
**Verification:** Migrate against a scratch database before touching the deployed one.

### Phase 1 — Identity rebase

### M3. Schema conflict: `packages/db/src/schema/organizations.ts`
**Goal:** One `users` table definition. Main renamed `workosUserId` → `replitUserId` (still `notNull`) and dropped `organizations.workosOrgId`; PR #21 made `workosUserId` nullable and added the `users_email_placeholder_uq` partial index.
**Dependencies:** D1, M2
**Approach:** Take main's column naming unconditionally. Whether the nullable-id + placeholder index survives is **entirely D1's call**: token-bound invites (recommended) still need a placeholder row but key the claim on the token, so the email partial index goes away and the nullability question is reopened on its own merits, not inherited.

### M4. Auth module conflicts: `workos.ts`, `tenant-provisioning.ts` (+ both tests)
**Goal:** Resolve four files whose PR #21 side is written against a provider that no longer exists.
**Dependencies:** D1, M3
**Approach:** `workos.ts` is now a 5-line deprecated shim re-exporting `sealSession`/`unsealSession` — take main's, and drop PR #21's `emailVerified` propagation (it has no source). `tenant-provisioning.ts`: take main's `ReplitUser`-based version as the base, then re-apply the claim step **rewritten per D1** — token-bound, not email-matched. PR #21's characterization tests for provisioning are the valuable part of its side; port them onto main's shape rather than discarding them.
**Execution note:** The origin plan's warning stands and is now sharper — this is the auth-critical path, it is the only place orgs get created, and it has now been rewritten twice by two different authors in one week. Land this unit alone, tests first.

### M5. Rebase U11's placeholder cleanup: `apps/api/src/routes/account.ts`
**Goal:** U11 deletes unclaimed placeholders via `isNull(schema.users.workosUserId)`. That column is gone. **This file does not conflict** — it merges green and fails typecheck, which is the good outcome; the bad one is if D1 removes placeholders and this logic silently deletes nothing.
**Dependencies:** D1, M3
**Approach:** Re-point at whatever D1 makes the placeholder marker. Keep the test asserting a placeholder invited to a second org survives — it's the one that catches an over-broad delete.

### M6. Environment sweep: `apps/api/src/env.ts`
**Goal:** Confirm the auto-merged result is what we mean.
**Dependencies:** none
**Approach:** Verify `WORKOS_*` are gone (main removed them; PR #21 never touched those lines, so the merge drops them — confirm rather than assume), `RESEND_*` survive, and consciously accept or revert main's `SUPABASE_STORAGE_BUCKET_PDFS` default change from `form-pdfs` to `pdfs`, which U11's `deletePrefix` targets.

### Phase 2 — Invite redesign (scope set by D1)

### M7. Token-bound invites, replacing U10/U15's email-claim design
**Goal:** Per D1's recommendation: invite row carries a token + destination email; Resend delivers the link; the Replit callback binds `replitUserId` to the invited membership on token presentation.
**Dependencies:** D1, M3, M4
**Approach:** Lift U12's token generation, unique index, expiry, and revoke patterns. Invite acceptance is authenticated (Replit session) + token possession — strictly stronger than the fill-link model, which is possession alone.
**Test scenarios:**
- Invite → token link → sign-in as a never-seen Replit user → membership `active`, role preserved, no new org auto-provisioned.
- Token replay after acceptance → rejected.
- Expired/revoked token → 404, membership untouched.
- **The `@replit.user` escalation case:** an invite to a synthesized-looking address grants nothing to a user who merely registers that username without the token.
- Resend unconfigured → invite persists, `emailSent: false`, UI degrades (U15's fail-soft contract, preserved).
**Verification:** Integration tests; one real invite end-to-end in the deployed app.

### Phase 3 — Revalidation

### M8. Re-run every gate PR #21 passed on the old base
**Goal:** PR #21's green (203 API tests, 52 web tests, typecheck, build) was earned against `ec1322d`. It means nothing on the new base until re-run.
**Dependencies:** all of the above
**Approach:** Full suite, then the origin plan's acceptance journey — which **still has never been run** and remains the only thing that validates phase 1. Main's auth swap changes how you log in to run it, so budget for that friction.

---

## Sequencing

M1, M2, and M6 are independent and can land immediately — they need no decision. M3/M4/M5 all wait on D1. M7 is the only unit with real design work in it.

**If D1 chooses "defer invites,"** M7 vanishes, M3–M5 shrink to deleting PR #21's placeholder machinery, and the merge is roughly a day of mechanical work. That is worth weighing seriously against the fact that the acceptance test — the reason PR #21 exists — is still unrun.

---

## Risks

- **The deployed database's true state is unknown** and M2 depends on it. Main's migration is unjournaled, which means the Replit agent likely pushed the schema directly. Verify before running any migration against it.
- **Auth has now been rewritten twice in one week by two authors.** The provisioning path is the only code that creates orgs. A bug locks users out or silently duplicates tenants.
- **Main is Replit-Agent-authored and unreviewed.** `getReplitUser` trusts `X-Replit-User-*` headers, whose security rests entirely on the Replit proxy stripping client-supplied copies. That claim is asserted in a code comment on main, not tested. Outside Replit's proxy — local dev, any future non-Replit host — those headers are forgeable by any client. Not PR #21's problem to fix, but it is now the whole authentication model, and PR #21's public fill routes are the first unauthenticated surface landing next to it.
- **PR #21 remains unmerged and now conflicts with a moving main.** Every further Replit-agent checkpoint on main widens this. Landing M1/M2/M6 early and deciding D1 quickly is the cheapest way to stop the bleed.

---

## Open Questions

- **D1 (above)** — blocks Phase 1 and 2.
- **Should `users.email` stay synthetic?** Main fabricates `username@replit.user`. The Team screen will display it. Collecting a real email at invite/onboarding time would fix the display and give U15 a genuine destination — but that's a product decision beyond this merge.
- **The origin plan's competency-gating question for external fill-link submitters** is still open and still unanswered; U12 shipped without it.
