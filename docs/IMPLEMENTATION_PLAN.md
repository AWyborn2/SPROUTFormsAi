# FormAI Enterprise — Implementation Plan (v1)

> Status: **Plan only.** Nothing in this document is built yet. It is the agreed
> blueprint to execute in follow-up sessions, phase by phase.

## Context

FormAI Enterprise is a multi-tenant B2B SaaS that digitises forms two ways:
**PDF-to-form conversion** (AI field extraction with audit-grade round-trip
fidelity — the proven differentiator) and a **from-scratch drag-and-drop
builder**. The repo is greenfield (only `README.md`). We have a high-fidelity
Claude Design prototype (`FormAI Prototype.dc.html`, ~20 screens) as the
visual/interaction source of truth, an idea brief + design prompt as the scope
and architecture source of truth, and a compiled Sprout & Spark design system
(tokens + 19 primitives) to inherit.

This plan recreates the prototype **pixel-faithfully in a real React/TS stack**
— matching visual and interaction output, not the prototype's `<x-dc>`
templating internals — and builds the production data model, auth, and PDF
pipeline to the validated shapes described in the brief.

### Confirmed decisions (from planning Q&A)

| Decision | Choice | Consequence |
|---|---|---|
| This session | **Plan only** | No commits; build in later phases. |
| Database | **Supabase Postgres + Drizzle** | Diverges from brief's Neon. WorkOS still owns identity; Supabase is DB + object storage only (see Auth below). |
| Template versioning | **Immutable published versions** | Publishing freezes a version; edits fork a new draft. Submissions pin the exact version filled. |
| Screen scope | **Everything in the prototype (~20 screens)** | Overrides the brief's must-have-only sequencing — see "Scope note" below. |

### Scope note — prototype vs. brief (surfaced, not silently resolved)

The brief marks several prototype screens as *out of scope for v1* (5-role RBAC
matrix, audit-log UI, competency gating, billing, native mobile). You chose to
build **everything in the prototype**. Two things to keep honest:

1. **"Mobile field app"** in the prototype is a device-framed view rendered by
   the *same web SPA*, not React Native. v1 builds it as a **responsive/PWA web
   route**, matching the prototype. True native (Expo) stays a later phase.
2. **Roles**: the prototype shows 5 roles (Owner/Admin/Builder/Reviewer/Viewer)
   with a full permission matrix; the brief's core model names 3
   (admin/builder/viewer). We adopt the **prototype's 5-role model** as the
   source of truth since we're building all its screens.

---

## Architecture overview

```
/apps
  /web        React + TypeScript + Vite SPA (Cloudflare Pages)
  /api        Node + Express (Render/Railway)
/packages
  /ui         from-scratch component layer (19 primitive wrappers + 6 new)
  /db         Drizzle schema + migrations (Supabase Postgres)
  /shared     shared TS types (FormField, Submission, extraction schema, …)
```

- **Frontend**: React 18 + TS + Vite SPA. Routing via React Router. Server state
  via TanStack Query. Design tokens compiled to CSS variables + a Tailwind
  preset that *references those variables* (no hardcoded hex).
- **Backend**: Express (TS). Owns **all** DB access and **all** Claude/Stripe
  secrets. No AI or DB keys ever reach the client.
- **DB**: Supabase Postgres, schema/migrations via Drizzle in `/packages/db`.
  Supabase Storage for PDF originals + org logo assets. **Not** Supabase Auth.
- **Auth**: WorkOS (multi-tenant orgs, SSO/SCIM-ready). WorkOS = identity;
  Supabase = data + files. See Auth section for the boundary.
- **AI**: Claude API (`claude-sonnet-5` for extraction) server-side only.
- **Payments**: Stripe (per-seat/per-org subscription).

---

## Design system layer (`/packages/ui`)

The prototype imports the compiled Sprout & Spark bundle but **overrides
typography** to Sora (headings) + Inter (body/UI) + JetBrains Mono (labels) in
its inline `<style>`. We inherit the *token system*, not the bundle's default
serif type.

**Step 1 — tokens → CSS variables.** Port the token CSS
(`colors.css`, `typography.css`, `spacing.css`, `radii.css`, `shadows.css`,
`motion.css`, `base.css`) into `/packages/ui/tokens/*.css` verbatim, then apply
the prototype's font override (Sora/Inter/JetBrains Mono) and the FormAI-local
additions found in the prototype's inline block:
- focus ring `2.5px solid var(--brand-green)` offset 2px (keyboard-critical)
- `.kbd` / `.kbd-dark` badge styles, `.fai-*` animations
  (`faiFade/faiRise/faiPop/faiToast/faiScan/faiCaret/faiSpin/faiBar`),
  scrollbar styling.
- Dark theme ships via `[data-theme="dark"]` (already in `colors.css`).

**Contrast rule (enforce in `Button`/`Badge`):** Sprout Green only passes
contrast with *dark Ink text on top* — never green text on white, never white
text on green. The prototype's `contrastText()` helper (luminance > 0.62 →
`#12321f`, else `#fff`) is the reference for org-accent buttons.

**Step 2 — Tailwind preset.** A Tailwind config whose colors/spacing/radii/
shadow/font scales map to `var(--…)`, so utilities and tokens can't drift.

**Step 3 — 19 primitives as real React components.** Rebuild (don't inline the
bundle): Button, IconButton, Icon (Lucide via `iconify-icon`), Badge, Tag,
Avatar, Card, Divider, Input, Textarea, Select, Checkbox, Radio, Switch, Alert,
Toast, Tooltip, Tabs, Dialog. Match the bundle's prop APIs (variants, sizes,
states) so screens read cleanly. **Build keyboard/focus management into each
from the start** — retrofitting is the expensive path.

**Step 4 — 6 net-new components** (styled consistently with the 19):
- **DataGrid/Table** — submissions, team, audit, roles matrix. Sortable,
  filterable, row-select, keyboard arrow nav, sticky header.
- **RepeatingGroup** — add/remove-row group for repeating sections
  (Item/Pass/Fail/Comments). The known hard case — first-class, not bolted on.
- **SignaturePad** — canvas signature capture (pointer + keyboard-accessible
  fallback), outputs PNG/SVG data.
- **FileDropzone** — drag-drop upload with keyboard activation + progress.
- **DateTimePicker** — accessible calendar/time popover, arrow-key grid.
- **CommandPalette** (Cmd/Ctrl+K) + **ShortcutsOverlay** ("?") — real
  components. The prototype's `.kbd` hints are the *visual spec*; behavior is
  built here (see Keyboard layer).

---

## Data model (`/packages/db` — Drizzle)

Derived from the prototype's mock state + the brief's core entities. All IDs
UUID; all tables `org_id`-scoped for tenant isolation.

- **organizations** — `id, name, plan, created_at`; embedded **branding kit**:
  `logo_asset_url, brand_primary, brand_secondary, brand_accent, form_font`.
  (Branding is onboarding-first, editable later in white-label settings.)
- **users** — `id, workos_user_id, name, email`.
- **memberships** — `user_id, org_id, role` (enum:
  `owner|admin|builder|reviewer|viewer`), `status` (`active|invited`). Composite
  tenant + role.
- **form_templates** — `id, org_id, name, dept, source_type`
  (`pdf_import|built_from_scratch`), `current_version_id`, `status`
  (`draft|published|archived`), timestamps.
- **form_template_versions** — **immutable once published.** `id, template_id,
  version_label (v1, v2…), state (draft|published), fields (JSONB), container
  (JSONB layout), source_pdf_asset_id, published_at, published_by`. Editing a
  published version forks a new `draft` row; publishing freezes it.
- **form_fields** — persisted inside the version's `fields` JSONB (they're
  version-scoped and never edited in place). Shape per **FormField** in
  `/packages/shared` (below). PDF-imported fields carry
  `source_position` (see PDF coordinates).
- **submissions** — `id, org_id, template_id, template_version_id` (pins the
  exact version), `submitter_name, submitter_email, values (JSONB), status`
  (`draft|submitted|reviewed` + prototype's `complete|approved|review|
  rejected|pending`), `flag`, `created_at`.
- **competency_rules** *(Should-tier, in scope per your choice)* — `id, org_id,
  template_id, section_ref, competency_id, enabled`.
- **competencies** — `id, org_id, name, code, holders`.
- **audit_log_entries** — `id, org_id, actor_id, action, target, category, icon,
  created_at`. Written by API on every mutating action (mirrors the prototype's
  `logAudit`).
- **role_permissions** — per-role capability matrix
  (`forms/submissions/team/billing/audit` × `view/create/edit/delete/export/
  invite/manage`). Seeded from the prototype's `perms` object.

**Shared types (`/packages/shared`)** — single source for `FormFieldType`
(`text|number|date|checkbox|radio|dropdown|signature|file_upload|
section_header` + `repeating_group|checkbox_group|boolean_yes_no`), `FormField`,
`ExtractionResult`, `Submission`, `Role`, `BrandingKit`. Imported by both apps.

---

## Auth — WorkOS + Supabase boundary

- **WorkOS owns identity**: AuthKit hosted login, org creation, memberships,
  and the SSO/SCIM upgrade path (no rewrite when an enterprise buyer needs it).
  The login screen's "Continue with SSO — WorkOS" affordance becomes real.
- **Supabase owns data/files only** — Postgres via Drizzle + Storage buckets.
  **Supabase Auth is not used**; disable it to avoid two identity systems.
- **Session flow**: WorkOS callback → Express verifies + issues an app session
  (httpOnly cookie) → middleware resolves `{ userId, orgId, role }` on every
  request → all DB queries filtered by `org_id`. RLS optional as
  defence-in-depth, but the Express layer is the enforced tenant boundary.
- **Roles** map WorkOS org membership → our `memberships.role`.

---

## PDF pipeline (server-side, the differentiator)

Build to the **validated shape**, not first principles.

**Two paths, chosen by inspection:**
1. **AcroForm PDFs** (fillable fields already defined) → read directly with
   `pdf-lib`. Deterministic, **no AI call**.
2. **Flat PDFs** (scanned / Word-exported — the dominant compliance case) →
   send the PDF as a `document` content block to Claude, forcing a tool call
   against an `extract_form_fields` schema.

**Extraction robustness (all confirmed in testing):**
- **`tool_use` first, then fallback.** Forced `tool_choice` is not 100%
  reliable — Claude sometimes returns correct JSON as ```json-fenced text.
  Parser: check for a `tool_use` block → else strip a ```json fence from text →
  else error. Never assume the tool block exists.
- **`max_tokens ≥ 16000`** — dense multi-page forms hit 50+ field defs once
  repeating sections + checkbox groups are counted; undersizing makes the forced
  call fail outright, not degrade.
- **Schema shape (proven):**
  - `repeating_group` type carries its own nested **`columns[]`** — extract
    column defs once, never enumerate blank paper rows (digital adds rows
    dynamically).
  - `checkbox_group` needs `selectionType: single|multiple`.
  - `boolean_yes_no` is distinct from `checkbox`.
  - `description` per field for ambiguous labels (e.g. "BAC", "VOC").
  - top-level **`designNotes[]`** — free-text reviewer observations (mergeable
    duplicate sections, fields needing special validation).
  - every field carries a **`confidence`** score.
- **Confidence review is a one-time step** at template creation. The review UI
  (import step 2) surfaces low-confidence fields distinctly (the prototype's
  `status: ok|review|low` + the "detected as text — likely signature" case).
  Once confirmed, later fills use the frozen template — no re-extraction.

**Coordinate space (round-trip fidelity):** store each imported field's
`source_position` in **PDF point space** (origin bottom-left, 72 units/inch):
`{ page, x, y, width, height, pageWidth, pageHeight }`. Points are
resolution-independent, so they survive a re-render at any DPI. Review-UI
overlays convert points → rendered-image pixels via the render scale; export
overlays values back at the exact points with `pdf-lib`. **Round-trip export
overlays onto the original PDF — never regenerates** — preserving
letterhead/fonts/layout. This is the fidelity claim the product depends on.

---

## Screens & build phases

All screens listed in the prototype's `screens[]` array. Build in dependency
order; establish shell/card/table/field patterns early and reuse.

**Phase 0 — Foundation**: monorepo + workspaces, `/packages/shared` types,
`/packages/db` Drizzle schema + first migration, `/packages/ui` tokens +
Tailwind preset + the 19 primitives + 6 new components, app shells (`web` SPA
router + `api` Express skeleton), keyboard layer scaffolding.

**Phase 1 — Onboarding & account**: Login/signup (WorkOS + SSO affordance) ·
Org setup wizard (name, team size, invite teammates) · **Branding kit** (logo
upload, primary/secondary/accent colors, form font, **live sample-form
preview**) · first-run empty-state dashboard.

**Phase 2 — Core loop (Must-haves)**: Dashboard (populated: form count,
submissions this period, compliance card) · **Form Builder** (canvas + field
palette + config panel + undo/redo + duplicate/delete/reorder + live preview) ·
**PDF import** steps 1–3 (upload → AI review w/ per-field confidence → confirm &
publish) · Template library (list + version history) · **Form fill** (external,
lightest chrome, branded) · Submission confirmation · Submissions table
(filter/export) · Submission detail (**PDF round-trip preview**).

**Phase 3 — Enterprise/org**: Team management (member list + invite) ·
Role/permission editor (5-role matrix) · Audit log viewer · Billing (Stripe) ·
White-label/branding settings.

**Phase 4 — Competency gating**: rule builder (which competency unlocks which
form section) + gated rendering in fill view.

**Phase 5 — Mobile field app (responsive web)**: the device-framed inspection
flow (checklist w/ repeating rows, offline-save affordance) as a responsive/PWA
route. Native Expo remains a later phase.

### End-to-end journeys to keep working (from the design prompt)
1. Sign up → create org → invite teammate → branding kit (live preview) →
   empty dashboard.
2. Upload PDF → review extracted fields (incl. ≥1 low-confidence correction) →
   publish.
3. Build a field from scratch → configure → live preview → publish alongside
   imported fields.
4. Fill published form as external user → submit → lands in submissions →
   open detail → round-trip PDF preview.
5. Admin: invite teammate → assign "builder" role → audit log records it.

---

## Keyboard operability (cross-cutting, built in from the start)

Implement as a shared layer, not per-screen. Mirrors the prototype's `onKey`:
- Global: **Cmd/Ctrl+K** command palette, **"?"** shortcuts overlay, **Esc**
  close/cancel, **Enter** confirm/submit, **Tab/Shift+Tab** logical order,
  **arrows** through lists/tables/menus, **Space** toggle focused checkbox/radio.
- **Form Builder power-user**: Cmd/Ctrl+Z / Shift+Z undo/redo, Cmd/Ctrl+D
  duplicate, Cmd/Ctrl+C/V copy/paste field, Backspace/Delete remove,
  Alt+↑/↓ reorder, ↑/↓ select prev/next, Cmd/Ctrl+Enter add field.
- **Visible focus everywhere** — the accent-on-Ink ring, functionally required.
- Respect `prefers-reduced-motion` (tokens already do).

---

## Verification (per phase)

- **Types**: `tsc --noEmit` across all packages; `/packages/shared` types
  consumed by both apps with no `any` at boundaries.
- **DB**: run Drizzle migration against a Supabase branch; assert immutable-
  version invariant (publishing freezes; edit forks a draft) with a unit test.
- **PDF pipeline**: golden-file tests — (a) an AcroForm PDF extracts via
  `pdf-lib` with zero AI calls; (b) a flat facility-inspection checklist (the
  repeating Item/Pass/Fail/Comments table) extracts via Claude, exercising both
  the `tool_use` path and the ```json-fence fallback (mock a text-wrapped
  response); (c) round-trip export overlays values at stored points and a diff
  vs. the original shows letterhead/layout untouched.
- **Screens**: drive each end-to-end journey (above) in the browser; verify
  keyboard-only completion of each and visible focus at every step.
- **Visual fidelity**: spot-check against the prototype's exact values
  (dimensions/colors/spacing are all readable from its source — no screenshots
  needed).
- **Auth/tenant**: a member of Org A cannot read Org B data via any API route.

---

## Key risks / watch-items

- **Supabase↔WorkOS split** must stay clean — one identity system (WorkOS), one
  data store (Supabase). Don't let Supabase Auth creep in.
- **Immutable versions** ripple into every submission read — always join through
  `template_version_id`, never the live template.
- **Repeating groups** are the default shape of real compliance paperwork —
  validate the `RepeatingGroup` component + `repeating_group.columns[]` schema
  early, on the facility-inspection checklist, before it's an afterthought.
- **Full-prototype scope** is large; treat Phases 3–5 as genuinely later
  milestones even though they're in scope — Phase 0–2 is the product's spine.
