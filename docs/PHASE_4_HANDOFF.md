# FormAI Enterprise — Phase 4 Handoff Prompt

> Paste this into a fresh session to continue the build. It is self-contained,
> but attach the **`High fidelity app prototype.zip`** bundle (gitignored at the
> repo root) if you have it — the prototype is the pixel/interaction source of
> truth. This document is the scope + architecture source of truth. If they ever
> disagree, surface it rather than silently picking one.

---

## Your task

Build **Phase 4 — Competency gating**: the rule builder that decides which
competency unlocks which form section, plus **gated rendering in the fill
view** so a section actually locks for fillers who don't hold the required
competency.

**Branch:** Phase 3 shipped as **PR #5** (merged to `main`). Start fresh:

```bash
git fetch origin main && git checkout -B claude/formai-phase-4-competency origin/main
```

Open a **new draft PR** and keep CI green.

## What already exists (Phases 0–3)

Read [`docs/IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) (the blueprint)
and the phase handoffs first. Phases 0–3 built the core loop **and** the
enterprise surface (team, roles, audit, billing, white-label) — **reuse it,
don't rebuild**:

```
/apps/web/src
  /lib/data        fixture store + TanStack Query hooks (the data seam)
  /lib/onboarding  app-wide branding + white-label context (external fill reads it)
  /screens         Dashboard, Templates, Submissions, builder/, import/, fill/, enterprise/
  /screens/fill    FillScreen (external) + ExternalShell
  router.tsx       REAL_SCREENS registry — replace the `competency` placeholder
/packages/db       Drizzle schema — competencies, competency_rules already exist
/packages/shared   Competency, CompetencyRule types already exist
```

**Components in `@formai/ui`** (reach for these — Phase 4 needs *no* net-new
components): `Button, IconButton, Icon, Badge, Card, Divider, Input, Textarea,
Select, Checkbox, Radio, Switch, Avatar, Dialog, Toast (useToast), DataGrid,
RepeatingGroup, SignaturePad, FileDropzone, DateTimePicker`.

**Confirmed decisions (do not relitigate):**
- **Data layer is an in-memory fixture store** behind TanStack Query hooks.
  Extend `apps/web/src/lib/data/` (fixtures + `store` + hooks) exactly as
  Phases 2–3 did; screens depend only on the hook surface.
- Store mutations write an `audit_log_entries` row so the Phase-3 audit screen
  reflects them live (the prototype's `logAudit`).
- **Imports use `.js` extensions** everywhere except `packages/db`.
- **Token-driven Tailwind** — never hardcode hex; Sprout Green only with dark
  ink text (`contrastText()` from `@formai/shared`).
- **Keyboard is cross-cutting** — Tab order, visible focus, Enter/Esc/Space/arrows.

## Phase 4 scope — screens to build

Recreate faithfully from the prototype (`FormAI Prototype.dc.html`). State lives
in the `data-dc-script` block: `competencies` §1713–1718, `competencyRules`
§1719–1723, `vmCompetency` §2196+. Mutation helpers: `addRule` §1785,
`toggleRule` §1786, `removeRule` §1787, `logAudit` §1778.

1. **Competency gating** (`/app/competency`, prototype §1440):
   - **Left rail** — a "Competencies" card (name, national code, holder count,
     colour dot; synced-from-LMS subtitle) + a "How fillers see it" preview card
     showing a **locked** section with "Unlocks with {competency}".
   - **Right** — a "New gating rule" builder (Form `Select` · Required
     competency `Select` · free-text "Section to gate" `Input` · Add rule) and
     an "Active rules · N" list: colour dot, section, `form → competency`,
     Active/Paused status, enable `Switch`, remove. Adding a rule requires a
     section name (else a warning toast) and **writes an audit entry**
     (`Added gating rule`, category `settings`).
   - Competencies seed (§1713–1718): `Working at Heights (RIIWHS204E, 34,
     warning)`, `Confined Space Entry (RIIWHS202E, 18, info)`, `First Aid
     (HLTAID011, 52, danger)`, `Forklift Licence (TLILIC0003, 12, accent)`.
   - Rules seed (§1719–1723): `Roof & height access items → Working at Heights`
     (f3, enabled), `Confined space entries → Confined Space Entry` (f3,
     enabled), `Plant operation sign-off → Forklift Licence` (f4, paused).

2. **Gated rendering in the fill view** (`/f/vendor-onboarding`):
   > **Prototype vs. plan (surfaced):** the prototype renders gating only as the
   > "How fillers see it" *preview* on the competency screen; its live external
   > fill route (vendor onboarding / f1) has no gated sections, and the seeded
   > rules target the inspection forms f3/f4 which have no fill route. The
   > **plan** ([IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) Phase 4) calls
   > for real gated rendering in the fill view.

   Make the fill flow genuinely gating-aware: a fill section whose name matches
   an **enabled** rule for that form renders **locked** (blurred/disabled inputs
   + a "Unlocks with {competency}" banner) until the filler verifies they hold
   the competency (a mock "I hold this — verify" affordance, since external
   fillers' competencies aren't modelled here). Toggling the rule off (or
   Pausing it on the competency screen) un-gates the section live.

## Data model touchpoints

The Drizzle tables already exist (`competencies`, `competency_rules`). Do not
change the schema unless genuinely needed (CI enforces drift).

Extend the fixture layer as Phases 2–3 did:
- Add `SEED_COMPETENCIES`, `SEED_COMPETENCY_RULES` to `fixtures.ts`.
- Store: `listCompetencies`, `listCompetencyRules`, `addRule` (writes audit),
  `toggleRule`, `removeRule`. Expose via hooks `useCompetencies`,
  `useCompetencyRules`, `useAddRule`, `useToggleRule`, `useRemoveRule`.
- The fill view reads enabled rules for its form via the same hook surface.

## End-to-end journeys that must work when Phase 4 is "done"

1. Add a gating rule (section named; a blank section is rejected) → it appears in
   "Active rules" → the **audit log records it**.
2. Toggle a rule Active⇄Paused; remove a rule — both persist.
3. A fill section gated by an **enabled** rule for that form renders locked with
   "Unlocks with {competency}"; verifying the competency unlocks it; Pausing the
   rule un-gates it.

## Working agreement / definition of done

- **Verify by driving, not just building.** `pnpm -r typecheck` + web/api build,
  then walk each journey in headless Chromium (`preview_start` the `web` launch
  config). Drive journeys via in-app navigation within one session (hard
  navigations reset the in-memory store).
- **Keep CI green.** `.github/workflows/ci.yml` runs typecheck, web+api build,
  api golden tests, and Drizzle drift.
- **Commit style:** conventional prefixes, imperative, with the repo's
  `Co-Authored-By: Claude Opus 4.8` trailer.
- **Land it in reviewable slices** (data layer + competency screen, then fill
  gating). Ask before assuming on anything genuinely ambiguous.

## Out of scope for Phase 4 (later phases)

- **Phase 5 — Mobile field app** (responsive web): the device-framed inspection
  flow (`vmMobile` §2414+, mobile state §1726–1737). Later.
