# FormAI Enterprise — Phase 3 Handoff Prompt

> Paste this into a fresh session to continue the build. It is self-contained,
> but attach the **`High fidelity app prototype.zip`** bundle (gitignored at the
> repo root) if you have it — the prototype is the pixel/interaction source of
> truth. This document is the scope + architecture source of truth. If they ever
> disagree, surface it rather than silently picking one.

---

## Your task

Build **Phase 3 — Enterprise & Org**: the admin surface that turns the core
product loop into a multi-tenant, team-operated product — team management,
the 5-role permission matrix, the audit-log viewer, billing, and white-label
settings.

**Branch:** Phase 2 shipped as draft **PR #3** on
`claude/formai-enterprise-overview-deivll`. **Once PR #3 is merged**, start
fresh from `origin/main`:

```bash
git fetch origin main && git checkout -B claude/formai-phase-3-enterprise origin/main
```

If PR #3 is *not* yet merged, branch from its head instead
(`git checkout -B claude/formai-phase-3-enterprise origin/claude/formai-enterprise-overview-deivll`)
and rebase onto `main` after it merges. Open a **new draft PR** and keep CI
green.

## What already exists (Phases 0–2)

Read [`docs/IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) (the blueprint)
and [`docs/PHASE_2_HANDOFF.md`](./PHASE_2_HANDOFF.md) first. Phase 2 built the
whole core loop — **reuse it, don't rebuild**:

```
/apps/web/src
  /lib/data        fixture store + TanStack Query hooks (the data seam)
  /lib/keyboard    KeyboardProvider (Cmd/Ctrl+K palette, "?" overlay), platform helpers
  /screens         Dashboard, Templates, Submissions, SubmissionDetail, builder/, import/, fill/
  /screens/fields  FieldRenderer (shared field → input)
  router.tsx       REAL_SCREENS registry — replace placeholders for the screens below
/apps/api/src/pdf  extraction + round-trip services (golden-tested)
/packages/ui       primitives + net-new components (see below)
/packages/db       Drizzle schema — memberships, role_permissions, audit_log_entries already exist
/packages/shared   Role, roles, audit, org, competency types already exist
```

**Components already available in `@formai/ui`** (reach for these — most of
Phase 3 needs *no* net-new components):
`Button, IconButton, Icon, Badge, Card, Divider, Input, Textarea, Select,
Checkbox, Radio, Switch, Avatar, Dialog (focus-trapped), Toast (useToast),
DataGrid (sortable/row-select/arrow-nav/sticky), RepeatingGroup, SignaturePad,
FileDropzone, DateTimePicker`.

**Confirmed decisions (do not relitigate):**
- **5-role model** is the source of truth: `Owner | Admin | Builder | Reviewer | Viewer`.
- **Data layer is an in-memory fixture store** behind TanStack Query hooks — no
  live Supabase/WorkOS in this environment. Extend
  `apps/web/src/lib/data/` (fixtures + `store` + hooks) exactly as Phase 2 did;
  screens depend only on the hook surface so real API wiring later is a drop-in.
- WorkOS owns identity, Supabase is data/storage only. Stripe owns billing.
  None of these are live here — build the UI to the validated shapes and stub
  the side effects with toasts (as the prototype does).

**Conventions (follow them):**
- pnpm workspaces, `@formai/*` names. `pnpm -r typecheck`,
  `pnpm --filter @formai/web build`, `pnpm --filter @formai/api test`.
- Imports use `.js` extensions everywhere **except `packages/db`** (extensionless).
- **Token-driven Tailwind** via `@formai/ui/tailwind-preset` — never hardcode
  hex; use the CSS-var-backed utilities. Sprout Green only with dark ink text
  on top (`contrastText()` from `@formai/shared`).
- **Keyboard is cross-cutting.** Every new interactive surface needs Tab order,
  visible focus, Enter/Esc/Space/arrows. Use `Dialog` for modals (it traps +
  restores focus) and `DataGrid` for tables (it does arrow-key roving focus).
- Register real screens in `apps/web/src/router.tsx` `REAL_SCREENS`; the routes
  and nav entries already exist in `apps/web/src/lib/screens.ts`
  (`team, roles, audit, billing, whitelabel`).

## Phase 3 scope — screens to build

Recreate faithfully from the prototype (`FormAI Prototype.dc.html`). Line
references are into that file; the mock state lives in its `data-dc-script`
block (state ~§1636–1737; view-models `vmTeam/vmRoles/vmAudit/vmBilling/
vmWhitelabel` at §2153–2195). Mutation helpers: `sendInvite` §1780,
`setMemberRole` §1781, `removeMember` §1782, `togglePerm` §1783, `logAudit`
§1778.

1. **Team management** (`/app/team`, prototype §1265): member list (Avatar,
   name/email, role `Select`, active/invited status badge, remove), seat count
   header ("N active · M invited · seats used X of 15"), and an **invite
   `Dialog`** (email + role, real email validation → adds an `invited` member +
   writes an audit entry). Members seed (§1639–1645):
   `Ash Whitfield (Owner, active)`, `Dana Okafor (Admin)`, `Priya Nair
   (Builder)`, `Marcus Lindqvist (Reviewer)`, `Tom Reyes (Viewer, invited)`.

2. **Roles & permissions** (`/app/roles`, §1302): left rail of the 5 roles
   (name, member count, description); right a **permission matrix** —
   categories × actions with `Switch` toggles. **Owner is locked** (all on,
   non-editable). Toggling writes through to the `perms` object. Matrix shape
   and seed values are the `perms` object at §1706–1712:
   - `forms`: view/create/edit/delete · `submissions`: view/export/delete ·
     `team`: view/invite/manage · `billing`: view/manage · `audit`: view.
   Descriptions per role at `vmRoles` §2161–2170.

3. **Audit log** (`/app/audit`, §1338): filterable, searchable, exportable list
   of `audit_log_entries` (actor · action · target · category · time, with a
   per-category icon/color). Category filter pills (`all/forms/submissions/team/
   security`) + free-text search (`vmAudit` §2171–2178). Seed entries at
   §1693–1702; **new entries must appear here** when Phase 3 actions fire
   (invite, role change, white-label save) — wire `logAudit` through the store.

4. **Billing** (`/app/billing`, §1362): three plan cards
   (Starter/Business=current/Enterprise), usage meters (forms 4/25,
   submissions 527/2,000, seats 5/15), payment method (`Visa ending 4242`),
   next charge (`$490.00 on 1 Aug 2026`), and an invoice table
   (`INV-2026-07/06/05`, all Paid, downloadable). Stripe is **not live** — plan
   changes / card updates / downloads are toasts (`vmBilling` §2179–2184).

5. **White-label settings** (`/app/settings/branding`, §1408): the org branding
   editor (primary/accent swatch rows + custom colour, form font) with a **live
   external-form preview** (reuse the `--org-*` CSS-var approach from the
   onboarding `BrandingScreen` and the Phase-2 `ExternalShell`), plus custom
   sending domain (`forms.meridian.co`), sender email
   (`noreply@meridian.co`), and a "remove FormAI badge" `Switch`. Save writes an
   audit entry (`vmWhitelabel` §2185–2195). This should drive the *same* brand
   state the external fill screen reads, so changes are reflected end-to-end.

## Data model touchpoints

The Drizzle tables already exist (`packages/db/src/schema/`): `memberships`
(role + status), `role_permissions`, `audit_log_entries`, `organizations`
(embedded branding kit). **Do not change the schema unless genuinely needed** —
if you do, run `pnpm db:generate` and commit the migration (CI enforces drift).

For the web, extend the fixture layer the same way Phase 2 did:
- Add `SEED_MEMBERS`, `SEED_PERMS`, `SEED_AUDIT_LOG` (full entries, not just the
  dashboard's 4), `BILLING`, and reuse/extend the branding state to
  `apps/web/src/lib/data/fixtures.ts`.
- Add store mutations: `inviteMember`, `setMemberRole`, `removeMember`,
  `togglePermission`, `updateWhiteLabel` — each pushing an `audit_log_entries`
  row so the audit screen reflects it live.
- Expose them through TanStack Query hooks (`useMembers`, `useRoles`,
  `useAuditLog`, `useBilling`, mutations), mirroring `hooks.ts`.
- Branding is org-wide state — consider promoting it out of `onboarding.tsx`
  into the data layer so white-label settings and the external fill share one
  source (surface this trade-off if it gets invasive).

## Net-new components

Likely **none** — the Phase-2 library covers it (`Dialog` for the invite modal,
`Switch` for the permission matrix + toggles, `DataGrid` for members/audit/
invoices, `Avatar`, `Badge`). If a genuinely reusable primitive emerges (e.g. a
`Meter`/usage-bar or a `SwatchPicker` extracted from the branding screens), add
it to `@formai/ui` rather than a one-off — but don't invent components the
screens don't need.

## End-to-end journeys that must work when Phase 3 is "done"

1. Invite a teammate (invalid email is rejected; valid email adds an `invited`
   member) → the **audit log records it** → the seat count updates.
2. Change a member's role → audit records `old → new`.
3. Toggle a permission for a non-Owner role in the matrix → it persists; the
   Owner row stays locked.
4. Edit white-label colours/font/domain → **the external fill page
   (`/f/vendor-onboarding`) reflects the new brand** → Save writes an audit entry.
5. Billing renders plans/usage/invoices; plan-change and invoice-download
   affordances fire (toasts), nothing crashes.

## Working agreement / definition of done

- **Verify by driving, not just building.** `pnpm -r typecheck` + web/api build,
  then walk each journey above in headless Chromium (the Browser preview tools;
  `preview_start` the `web` launch config). Note: hard browser navigations reset
  the in-memory store — drive journeys via in-app navigation within one session,
  or accept that fresh loads show seed state.
- **Keep CI green.** `.github/workflows/ci.yml` runs typecheck, web+api build,
  api golden tests, and Drizzle drift on every push.
- **Commit style:** conventional prefixes (`feat:`, `chore:`, …), imperative,
  with the repo's existing `Co-Authored-By: Claude Opus 4.8` trailer (kept for
  consistency with history — the "no model identifiers" line in earlier handoffs
  conflicts with the trailers already in the repo; follow the repo).
- **Land it in reviewable slices** (e.g. team+roles, then audit, then
  billing+white-label) rather than one monster commit. Ask before assuming on
  anything genuinely ambiguous.

## Out of scope for Phase 3 (later phases)

- **Phase 4 — Competency gating**: the rule builder (which competency unlocks
  which form section) + gated rendering in the fill view. State already seeded
  (`competencies` §1713–1718, `competencyRules` §1719–1723, `vmCompetency`
  §2196+); the `/app/competency` route + `competency_rules`/`competencies`
  tables exist. Build after the enterprise surface.
- **Phase 5 — Mobile field app** (responsive web): the device-framed inspection
  flow (`vmMobile` §2414+, mobile state §1726–1737). Later.

Don't build ahead into Phase 4/5.
