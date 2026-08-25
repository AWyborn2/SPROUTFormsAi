---
title: My Record Gamified Profile Redesign - Plan
type: feat
date: 2026-08-24
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# My Record Gamified Profile Redesign - Plan

---

## Goal Capsule

- **Objective:** Rebuild `ProfileScreen.tsx` into a gamified candidate profile page matching the approved mockup artifact — hero card with XP ring, badge wall, competency register, evidence gallery, next-badge card, training actions, activity timeline, and role-scoped button sets — wired to the existing data layer.
- **Authority:** The mockup HTML artifact (`scratchpad/my-record-profile.html`) is the design source of truth. The existing data hooks (`useProfile`, `useHeldCompetencies`, `useSession`, `useAssessmentCases`, `useMemberPlacement`, `useTaxonomy`) are the data source of truth. Where the mockup shows data the API does not yet serve (XP, leaderboard rank, badges, timeline events), render static placeholder values with a clear `TODO` marker in the data layer — those features ship in a later gamification-backend round.
- **Stop conditions:** The profile page renders all mockup sections, every button triggers a meaningful action or a toast stub, the existing test suite passes, the page is responsive at 860px and 600px breakpoints, and role-switching renders the correct button set and viewer note for each of the four roles.
- **Execution profile:** Standard front-end feature — no migrations, no new API endpoints. All work is in `apps/web`.
- **Tail ownership:** The gamification backend (XP engine, leaderboard, badge award triggers) is a separate future plan. This plan owns only the UI shell and its wiring to existing data.

---

## Product Contract

### Summary

Replace the current functional-list profile screen with a rich, gamified "My Record" page. The page is role-aware: candidates see their own record with self-service buttons, supervisors see a read-only crew view, assessors can start assessment cases, and admins get full edit access. The visual language follows the Sprout & Spark design system (Sora/Inter/JetBrains Mono, green accent ramp, 14px card radius, 10px button radius).

### Problem Frame

The current `ProfileScreen` is a vertical stack of plain `Card` components — avatar, name, competencies list, fields grid, placement badges, documents stub. It serves its data purpose but offers no engagement: no progress visualisation, no at-a-glance status, no gamification hooks, and no role-specific action surface. The mockup artifact presents a complete redesign that turns the record into a destination candidates want to check.

### Requirements

**Hero card**

R1. The hero card shows a teal-dark banner with a radial green glow and an alert pill (e.g. "1 expiring — Dozer Operator") sourced from the held-competencies data.

R2. The avatar sits in a conic-gradient XP ring (green fill proportional to level progress) with a level badge overlay at bottom-right. Photo upload is a placeholder drop zone, not a working uploader (avatar upload ships with the backend round).

R3. Name, meta line (role title, crew, employee number, induction date), XP progress bar, and streak/rank/renewal chips render below the avatar.

R4. Role-scoped action buttons render in the hero's action area: candidate gets "Download training record" (outline) + "Upload training document" (primary); supervisor gets "View crew matrix" (outline) + "Download training record" (outline) + "Nudge renewal" (primary); assessor gets "Download training record" (outline) + "Start assessment case" (primary); admin gets "Edit record" (outline) + "Download training record" (outline) + "Assign assessment" (primary).

R5. A four-cell stats row sits at the bottom of the hero card: Competencies held, XP earned, Zero-lapse streak, Site leaderboard rank. Values come from held-competencies count (real) and placeholder constants (XP, streak, rank).

**Badge wall**

R6. A 6-column grid of badge items, each a circular ring with a short code, name, and subtitle. Five visual states: earned (green gradient ring), expiring (amber conic ring), progress (conic ring at percentage), achievement (green gradient ring + teal-dark inner background + gold-coloured code), locked (dashed border + muted colours).

R7. A header shows "Badge wall" with an "X OF Y EARNED" mono-font counter.

R8. Badge data derives from held competencies where possible (earned = held status, expiring = expiring status, progress = in-progress). Achievement and locked badges are placeholder data until the gamification backend.

**Competency register**

R9. A four-column grid (Competency, Status, Evidence, Record) replaces the current competency list. Status shows a coloured dot + label + optional expiry warning. Evidence shows the evidence reference. Record shows a green pill "PDF" download button for competencies that have an export.

R10. Competency data comes from `useHeldCompetencies`.

**Evidence gallery**

R11. A three-column grid of dashed-border photo slots. Each shows a label, file name, and upload date. Role-gated subtitle: candidates and supervisors see "View only"; assessors and admins see "Drag photos to attach evidence".

R12. Evidence slots are placeholder UI — no file upload wiring this round.

**Next badge card (sidebar)**

R13. A green-bordered card showing the nearest incomplete competency badge with a conic progress ring, name, description, and XP reward. Candidate sees a "Request this training" button that toggles to "Requested — in the training queue" on click. Assessor/admin sees "Assign the awarding assessment". Supervisor sees no next-badge card.

**Training actions (sidebar)**

R14. A list of urgency-coloured action cards: expired items in red, expiring in amber, new-required in green. Each card shows a countdown mark, name, subtitle, and a role-aware action button (candidate: "Upload driver's licence"/"Book renewal"; other: "Request upload"/"Assign renewal").

R15. Action data is derived from held competencies (expired and expiring rows) plus placeholder "new required" items.

**Training activity timeline (sidebar)**

R16. A dot-and-line vertical timeline of recent training events with XP annotations. Placeholder data until the gamification backend event log exists.

**Layout and responsive**

R17. Below the hero and badge wall, content splits into a 1.5fr/1fr two-column grid: left column holds the competency register and evidence gallery; right column holds the next-badge card, training actions, and training activity timeline.

R18. At 860px the grid collapses to single-column, badge grid goes to 4 columns, stats row goes to 2×2. At 600px badge grid goes to 3 columns, gallery to 2 columns.

**Role awareness**

R19. The viewer's role is read from `useSession().data?.role`. The `access.isSubject` flag determines own-record view. Button sets, viewer notes, gallery subtitles, and next-badge button labels switch per role as specified in R4, R11, R13, R14.

R20. A footer line shows a role-specific viewer note (e.g. "your own record — supervisors and assessors see the same badges").

**Existing functionality preservation**

R21. The existing edit-record flow (Admin inline form via `ProfileForm`) remains accessible through the "Edit record" button in the admin hero action set. The seeded-create flow (`?seedFrom=`) continues to work.

R22. Error states (403/404), loading states, and the `WithheldCard` pattern for sections the viewer cannot access are preserved from the current implementation.

R23. The `MyAssessmentsCard` (candidate's "Assessments due" list) moves into the sidebar column above the training actions card, replacing nothing — it is additive.

---

## Planning Contract

### Key Technical Decisions

KTD1. **Rebuild in place, not alongside.** `ProfileScreen.tsx` is rewritten as a single file with extracted sub-components (HeroCard, BadgeWall, CompetencyRegister, EvidenceGallery, NextBadgeCard, TrainingActions, TrainingTimeline). No new route or screen key — the existing `profile` and `my-profile` routes continue to resolve here. Rationale: a parallel screen would need its own route, permission wiring, and eventual teardown; the current screen has no downstream consumers beyond the two route entries.

KTD2. **Tailwind classes, not a separate CSS file.** The mockup uses vanilla CSS classes (`.fai-card`, `.hero-banner`, etc.). The rebuild uses Tailwind utility classes consistent with the rest of `apps/web`. The design-system tokens (`--green-primary`, `--teal-dark`, etc.) are already mapped to Tailwind via the preset in `packages/ui`. Where a token is not mapped (e.g. conic-gradient rings), use inline `style` props with CSS custom property references. Rationale: every other screen in the app uses Tailwind; a CSS module would be the only one in the codebase.

KTD3. **Placeholder data object for gamification fields.** XP, level, streak, leaderboard rank, badge achievement data, and timeline events do not exist in the API. A `buildProfileViewModel(profile, access, heldCompetencies, session)` function in `ProfileScreen.tsx` computes the view model, filling gamification slots with static placeholder values. This function is the single point that a future gamification-backend round replaces. Rationale: isolating the placeholder boundary makes the backend round a data-layer swap rather than a UI surgery.

KTD4. **Badge state derivation from `HeldCompetencyRow`.** Map `status: 'held'` → earned, `status: 'expiring'` → expiring, `status: 'expired'` → expired (shown as needing renewal in training actions, not in badge wall), `standing: 'recommended' && !current` → progress. Achievement and locked badges are placeholder constants. Rationale: the held-competencies query already resolves standing and currency; duplicating that logic would drift.

KTD5. **Button actions use existing navigation and toast stubs.** "Download training record" calls the existing `GET /profiles/:id/export` endpoint (Admin-only — other roles get a toast stub "Export not available for your role"). "Edit record" sets the existing `editing` state. "Start assessment case" navigates to `/app/assessments/new?memberId=<userId>`. "Upload training document", "View crew matrix", "Nudge renewal", "Assign assessment" show a toast "Coming soon". Rationale: wiring real actions for features that don't exist yet would be dead code; toast stubs are honest and removable.

KTD6. **No new API endpoints or migrations.** The gamification backend is out of scope. The profile export endpoint already exists. Everything else is client-side composition of existing query results.

### Assumptions

- The Tailwind preset already maps the design-system CSS custom properties used in the mockup (`green-primary`, `teal-dark`, etc.) — verified in the prior research pass.
- The `useSession` hook returns `role` on the session object, which is the viewer's own role, not the viewed member's role.
- `HeldCompetencyRow.code` is non-null for competencies that have a short code (used as badge label); null codes fall back to a two-letter abbreviation of the name.

### Sequencing

Units are ordered for incremental buildability:

1. U1 (view model + hero card) — establishes the data shape everything else consumes.
2. U2 (badge wall) — depends on the badge-state derivation from U1's view model.
3. U3 (competency register + evidence gallery) — the main-column content.
4. U4 (sidebar: next badge + training actions + timeline) — the side-column content.
5. U5 (responsive layout + final wiring) — wraps the columns and applies breakpoints.
6. U6 (preserve existing flows + tests) — ensures edit, seed, error, and WithheldCard still work.

---

## Implementation Units

### U1. View model and hero card

- **Goal:** Build the `buildProfileViewModel` function and the `HeroCard` sub-component that renders the teal banner, avatar XP ring, name/meta, XP bar, chips, role-scoped buttons, and stats row.
- **Requirements:** R1, R2, R3, R4, R5, R19, R20
- **Files:**
  - `apps/web/src/screens/enterprise/ProfileScreen.tsx` — add `buildProfileViewModel`, `HeroCard`, placeholder data constants
- **Approach:** Define a `ProfileViewModel` type with all display fields (name, meta, xp, stats, badges, register, gallery, actions, timeline, roleActions, viewerNotes). `buildProfileViewModel` takes `(profile: MemberProfile, access: ProfileAccess, held: HeldCompetencyRow[], session)` and returns the view model, computing real values where data exists and filling placeholders otherwise. `HeroCard` renders the mockup's hero card structure using Tailwind classes. The conic-gradient avatar ring and XP bar use inline `style` with CSS variable references. Role-scoped buttons read from `roleActions[role]`. Button click handlers: "Download training record" triggers the export fetch, "Edit record" calls `onEdit()` prop, others show a toast.
- **Test scenarios:**
  - `buildProfileViewModel` returns correct `heroAlert` text when one competency is expiring.
  - `buildProfileViewModel` returns correct role-action button sets for each of the four roles.
  - `HeroCard` renders the member name, XP bar, level badge, and stats row.
  - `HeroCard` renders different button sets when the role changes.
  - "Edit record" button calls the `onEdit` callback.

### U2. Badge wall

- **Goal:** Render the badge-wall grid with five visual states derived from held competencies.
- **Requirements:** R6, R7, R8
- **Files:**
  - `apps/web/src/screens/enterprise/ProfileScreen.tsx` — add `BadgeWall` sub-component, `badgeStyle` helper, badge-state derivation in `buildProfileViewModel`
- **Approach:** `buildProfileViewModel` maps `HeldCompetencyRow[]` into badge items: `status === 'held'` → `kind: 'earned'`, `status === 'expiring'` → `kind: 'expiring'`, `status !== 'held' && standing === 'recommended'` → `kind: 'progress'`. Append placeholder achievement and locked badges. `BadgeWall` renders a 6-column CSS grid; each badge item's ring uses `background` with a conic-gradient or linear-gradient depending on `kind`. The counter shows `earned.length OF total.length EARNED` in mono font.
- **Dependencies:** U1 (view model shape)
- **Test scenarios:**
  - Badge wall renders correct count of earned badges from held competencies.
  - A `kind: 'expiring'` badge renders with amber conic-gradient styling.
  - A `kind: 'locked'` badge renders with dashed border and muted colours.
  - The "X OF Y EARNED" counter matches the actual earned count.

### U3. Competency register and evidence gallery

- **Goal:** Render the four-column competency register grid and the evidence gallery photo slots.
- **Requirements:** R9, R10, R11, R12
- **Files:**
  - `apps/web/src/screens/enterprise/ProfileScreen.tsx` — add `CompetencyRegister`, `EvidenceGallery` sub-components
- **Approach:** `CompetencyRegister` replaces the current `CompetenciesCard`. It renders a CSS grid with four columns (Competency, Status, Evidence, Record). Status dot colour maps: `held` → green, `expiring`/`grace` → amber, `expired` → red, else → blue. The PDF button triggers `GET /profiles/:membershipId/export` (existing endpoint). `EvidenceGallery` renders a 3-column grid of dashed-border placeholder slots. The subtitle text switches on role: `gallerySub[role]`.
- **Dependencies:** U1 (view model provides sorted competencies and gallery slots)
- **Test scenarios:**
  - Register renders one row per held competency with name, standing tag, status dot, and evidence ref.
  - An expiring competency row shows amber status dot and expiry date in bold.
  - The PDF button renders only for competencies where `hasPdf` is true (derived from `evidenceRef` presence or held status).
  - Gallery subtitle shows "View only" for candidate role and "Drag photos to attach evidence" for assessor role.

### U4. Sidebar: next badge, training actions, timeline

- **Goal:** Render the right-column sidebar with the next-badge card, training actions list, and activity timeline.
- **Requirements:** R13, R14, R15, R16, R23
- **Files:**
  - `apps/web/src/screens/enterprise/ProfileScreen.tsx` — add `NextBadgeCard`, `TrainingActions`, `TrainingTimeline`, refactor `MyAssessmentsCard` placement
- **Approach:** `NextBadgeCard` finds the first `kind: 'progress'` badge from the view model and renders it in a green-bordered card with the conic progress ring. The button label switches on role (R13); candidate's button toggles local `requested` state. `TrainingActions` renders urgency-sorted action cards from held competencies: expired items first (red), then expiring (amber), then placeholder "new required" items (green). Button labels switch on `isCandidate`. `TrainingTimeline` renders placeholder timeline events with dot-and-line layout and XP annotations. `MyAssessmentsCard` moves from the main column to the sidebar, above `TrainingActions`, for candidates only.
- **Dependencies:** U1 (view model provides badges, actions, timeline data), U2 (badge derivation)
- **Test scenarios:**
  - Next-badge card renders the first in-progress competency with correct name and progress percentage.
  - Candidate's "Request this training" button toggles to "Requested — in the training queue" on click.
  - Assessor sees "Assign the awarding assessment" on the next-badge button.
  - Supervisor does not see the next-badge card.
  - Training actions render expired items before expiring items.
  - Action button labels differ between candidate and non-candidate roles.
  - Timeline renders placeholder events with XP annotations.

### U5. Two-column layout and responsive breakpoints

- **Goal:** Assemble the full page layout with the two-column content grid and apply responsive breakpoints.
- **Requirements:** R17, R18
- **Files:**
  - `apps/web/src/screens/enterprise/ProfileScreen.tsx` — restructure the `ProfileScreen` return to use the two-column layout, add responsive Tailwind classes
- **Approach:** The page container is `max-w-[1180px] mx-auto` with `p-6`. Below the hero and badge wall, a `grid grid-cols-[1.5fr_1fr] gap-4` holds the main and side columns. At `max-width: 860px` (`@media` or Tailwind `md:` breakpoint adjusted), collapse to `grid-cols-1`. Badge grid uses `grid-cols-6` → `grid-cols-4` at 860px → `grid-cols-3` at 600px. Stats row uses `grid-cols-4` → `grid-cols-2` at 860px. Gallery uses `grid-cols-3` → `grid-cols-2` at 600px. The register grid gets `overflow-x-auto` for horizontal scroll on narrow screens.
- **Dependencies:** U1–U4 (all sub-components exist)
- **Test scenarios:**
  - The page renders hero card, badge wall, then a two-column grid.
  - At narrow viewport, the layout collapses to single column (verified by className assertion or snapshot).

### U6. Preserve existing flows, error states, and tests

- **Goal:** Ensure the edit-record form, seeded-create flow, error/loading states, WithheldCard, and existing tests all still work after the redesign.
- **Requirements:** R21, R22
- **Files:**
  - `apps/web/src/screens/enterprise/ProfileScreen.tsx` — keep `ProfileForm`, `SeedBanner`, `WithheldCard`, `Frame` (updated), error/loading branches
  - `apps/web/src/screens/enterprise/ProfileScreen.test.tsx` — update selectors to match new DOM structure, add gamified-UI assertions
- **Approach:** The `ProfileForm` component is preserved unchanged — the admin "Edit record" button sets `editing` state and the form renders in place of the fields card, same as today. `SeedBanner` renders above the hero when `seedFrom` is present. Error states (403, 404) and the loading spinner remain in the early-return branches before the gamified layout. `WithheldCard` renders in place of `CompetencyRegister` or `EvidenceGallery` when `access.canViewCompetencies`/`access.canViewDocuments` is false. Existing tests are updated to find content by accessible names rather than structural selectors that changed.
- **Dependencies:** U1–U5 (full page assembled)
- **Test scenarios:**
  - Existing test: record renders member name and competencies.
  - Existing test: candidate own-record view shows assessments-due card.
  - Existing test: admin can enter edit mode and save.
  - Existing test: seeded-create shows the seed banner.
  - Existing test: 403 error shows "You do not have access" message.
  - New test: badge wall renders for a profile with held competencies.
  - New test: training actions card renders expired competencies in red.
  - New test: role-switching changes the hero action buttons.

---

## Verification Contract

| Gate | Command | Applies to |
|---|---|---|
| TypeScript compilation | `pnpm --filter @formai/web exec tsc --noEmit` | All units |
| Web test suite | `pnpm --filter @formai/web test` | All units, especially U6 |
| Shared test suite | `pnpm --filter @formai/shared test` | Regression — no shared changes expected |
| API test suite | `pnpm --filter @formai/api test` | Regression — no API changes expected |
| Visual verification | Dev server + browser at `/app/profile` | U1–U5, responsive breakpoints |
| Role switching | Toggle `useSession` mock role and verify button sets | U1, U4 |

---

## Definition of Done

- All six units implemented: hero card, badge wall, competency register + gallery, sidebar, layout, existing-flow preservation.
- `pnpm --filter @formai/web test` passes with no regressions.
- `pnpm --filter @formai/web exec tsc --noEmit` clean.
- The profile page matches the mockup artifact visually at desktop (1180px), tablet (860px), and mobile (600px) widths.
- All four role button sets render correctly.
- The "Edit record" button opens the existing `ProfileForm`.
- The "Download training record" button triggers the export endpoint (or toast stub for non-admin roles).
- Placeholder data is isolated in `buildProfileViewModel` behind a clear boundary for future backend replacement.
- No new API endpoints, no new migrations, no changes to `packages/shared` or `apps/api`.
- Existing `ProfileScreen.test.tsx` assertions pass (with selector updates as needed).
