# FormAI Enterprise — Phase 2 Handoff Prompt

> Paste this into a fresh session to continue the build. It is self-contained,
> but attach the **`high-fidelity-app-prototype.zip`** handoff bundle if you
> have it — the prototype is the pixel/interaction source of truth. This
> document is the scope + architecture source of truth. If they ever disagree,
> surface it rather than silently picking one.

---

## Your task

Build **Phase 2 — the Core Product Loop**: the Must-have features that are the
product's spine and its proven differentiator. Work on branch
`claude/formai-enterprise-overview-deivll`, and because the previous PR is
**merged**, start fresh: `git fetch origin main && git checkout -B
claude/formai-enterprise-overview-deivll origin/main`, build there, open a **new
draft PR**, and keep CI green.

## What already exists on `main` (Phases 0–1, merged)

Read [`docs/IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) first — the full
blueprint, data model, and decisions. Then note what's already built so you
**reuse, not rebuild**:

```
/apps
  /web   Vite React 18 + TS SPA · React Router · TanStack Query · token-driven Tailwind
  /api   Express + TS skeleton (env, health, tenant middleware stub)
/packages
  /ui      design tokens → CSS vars (Sora/Inter override) · Tailwind preset · primitives
  /db      Drizzle schema (10 tables, immutable versions) + generated migration
  /shared  FormField + extraction schema · template versioning · submission · roles · branding · audit
```

**Confirmed decisions (do not relitigate):**
- DB: **Supabase Postgres + Drizzle**. WorkOS owns identity; Supabase is data + storage only (no Supabase Auth).
- Template versions are **immutable once published**; submissions pin the exact `templateVersionId` filled against.
- Scope: **all ~20 prototype screens** (overrides the brief's must-have-only sequencing).

**Conventions established (follow them):**
- pnpm workspaces. `@formai/*` package names. `pnpm -r typecheck`, `pnpm --filter @formai/web build`.
- Imports: `.js` extensions everywhere **except `packages/db`** (extensionless — drizzle-kit's bundler can't rewrite `.js`→`.ts`; the schema must stay self-contained, so inline default literals rather than value-importing from `@formai/shared`).
- Styling: **token-driven Tailwind** via `@formai/ui/tailwind-preset` — never hardcode hex; use the CSS-var-backed utilities. Contrast rule: Sprout Green only with **dark ink text on top** (use `contrastText()` from `@formai/shared`).
- Keyboard is **cross-cutting**: `KeyboardProvider` (Cmd/Ctrl+K palette + `?` overlay) is live in `apps/web/src/lib/keyboard/`. Every new interactive surface needs Tab order, visible focus, Enter/Esc/Space/arrows, and the Builder's power-user shortcuts (below). Build focus management into components as you go — don't retrofit.
- Screen registry: `apps/web/src/lib/screens.ts` maps every route. Real screens are wired in `apps/web/src/router.tsx` via `REAL_SCREENS`; unimplemented ones render `ScreenPlaceholder`. **Replace placeholders** for the screens below.
- Onboarding/session state lives in `apps/web/src/lib/onboarding.tsx` (`useOnboarding`). Phase 2 will likely want a proper data layer — introduce TanStack Query hooks against the API rather than growing that context.
- Primitives available: `Button, IconButton, Icon, Badge, Card, Divider, Input, Select, Avatar`. Reach for these; add missing ones to `@formai/ui`, not one-off per screen.

## Phase 2 scope — screens to build

Recreate faithfully from the prototype (`project/FormAI Prototype.dc.html`).
Line references are into that file; data shapes are in its
`<script data-dc-script>` block (~line 1600+).

1. **Dashboard — populated** (`/app`, prototype §603–653): 4 stat cards (form count, submissions this period, etc.), "Your forms" list, Compliance card with % ring, Recent activity. Currently the empty state; render populated when data exists.
2. **Form Builder** (`/app/forms/build`, §819–1067): field palette (text, number, date, checkbox, radio, dropdown, signature, file upload, section header), canvas, per-field config panel (validation, required, help text), live preview, container/layout settings.
   - **Power-user keyboard** (already speced in the shortcuts overlay; wire the behavior): Cmd/Ctrl+Z / Shift+Z undo/redo, Cmd/Ctrl+D duplicate, Cmd/Ctrl+C/V copy-paste field, Backspace/Del delete, Alt+↑/↓ reorder, ↑/↓ select prev/next, Cmd/Ctrl+Enter add field. Reference impl: the prototype's `bUndo/bRedo/bDuplicate/bMove/bCopy/bPaste/bAdd/bDelete` (§1867–1888) and its `onKey` builder branch (§1805–1819).
3. **PDF Import** — three steps:
   - **Step 1 upload** (`/app/import`, §690): FileDropzone (net-new component).
   - **Step 2 AI review** (`/app/import/review`, §712): per-field rows with a **confidence indicator**, low-confidence fields surfaced distinctly, inline type-correction, repeating-table confirmation. Reference data: `imp.fields` (§1682–1691) with `conf`/`status: ok|review|low` and the "detected as text — likely signature" case.
   - **Step 3 publish** (`/app/import/publish`, §791).
4. **Template library** (`/app/forms`, §1068–1118): list view with version history.
5. **External fill** (`/f/vendor-onboarding`, §304–351): lightest-chrome, org-branded (uses the `--org-*` CSS vars). Real validation (see `fillSubmit` §1898–1907).
6. **Submission confirmation** (`/f/vendor-onboarding/done`, §353–373).
7. **Submissions table** (`/app/submissions`, §1119–1161): filterable, exportable, row-select.
8. **Submission detail** (`/app/submissions/detail`, §1162–1264): single submission incl. the **PDF round-trip preview** (filled values overlaid on the original layout).

## Net-new components to build (styled like the existing 19)

- **DataGrid/Table** — submissions/template/version lists: sortable, filterable, row-select, keyboard arrow-nav, sticky header.
- **RepeatingGroup** — add/remove-row group for repeating sections (Item/Pass/Fail/Comments). This is the **default shape of real compliance paperwork** — first-class, not an afterthought.
- **SignaturePad** — canvas capture, pointer + keyboard-accessible.
- **FileDropzone** — drag-drop + keyboard activation + progress.
- **DateTimePicker** — accessible calendar/time popover, arrow-key grid.
- (CommandPalette + ShortcutsOverlay already exist.)

## The PDF pipeline (the differentiator — build to the validated shape)

This is server-side in `apps/api`. The types already exist in
`@formai/shared` (`ExtractionResult`, `ExtractedField`, `SourcePosition`,
`FormField`). Implement the extraction + round-trip services now.

- **Two paths, chosen by inspection.** AcroForm PDFs (fillable fields defined) → read directly with `pdf-lib`, deterministic, **no AI call**. Flat PDFs (scanned / Word-exported — the dominant case) → send the PDF as a `document` content block to Claude (`claude-sonnet-5`, server-side, key never client-side), forcing a tool call against an `extract_form_fields` schema.
- **Robust extraction (all confirmed in testing):** check for a `tool_use` block **first**; else strip a ```json fence from text content; only error if neither yields valid data. Forced `tool_choice` is not 100% reliable. Set **`max_tokens ≥ 16000`** — dense forms need 50+ field defs; undersizing makes the forced call fail outright.
- **Schema shape (proven):** `repeating_group` carries its own nested **`columns[]`** (extract columns once, never enumerate blank paper rows). `checkbox_group` needs `selectionType: single|multiple`. `boolean_yes_no` is distinct from `checkbox`. Add `description` for ambiguous labels (e.g. "BAC", "VOC"). Include a top-level **`designNotes[]`**. Every field carries a **`confidence`** score. All of this is already typed in `@formai/shared/src/extraction.ts` — match it.
- **Confidence review is a one-time step** at template creation (import step 2). Once confirmed, later fills use the frozen version — no re-extraction.
- **Coordinates:** store `SourcePosition` in **PDF point space** (origin bottom-left, 72 units/inch) + page dimensions, so it survives a re-render at any DPI. Review-UI overlays convert points→rendered pixels via the render scale.
- **Round-trip export:** overlay submitted values onto the **original PDF** at the stored points with `pdf-lib` — **never regenerate** the document. This preserves letterhead/fonts/layout and is the fidelity claim the product depends on.

## Data model touchpoints

- Publishing a builder/import template creates an **immutable published version**; editing a published version **forks a new draft**. Submissions join through `templateVersionId`, never the live template.
- Every mutating action writes an **`audit_log_entries`** row (see the prototype's `logAudit`).
- Wire the API routes the screens need (forms/versions, import upload+extract+publish, submissions list/detail/export, round-trip export) behind the tenant-context middleware (`apps/api/src/middleware/tenant.ts`), filtering all queries by `orgId`.

## End-to-end journeys that must work when Phase 2 is "done"

1. Upload a PDF → review extracted fields (**including ≥1 low-confidence field that needs a manual correction**) → publish.
2. Build a field from scratch → configure → see it in live preview → publish alongside imported fields on the same form.
3. Fill a published form as an external end user → submit → it lands in the submissions table → open the detail → **round-trip PDF preview**.
4. The **facility-inspection checklist** with its repeating Item/Pass/Fail/Comments table survives import → fill → submission intact (the known hard case).

## Working agreement / definition of done

- **Verify by driving, not just building.** Typecheck (`pnpm -r typecheck`) + build, then walk each journey above in headless Chromium (Chromium is preinstalled at `/opt/pw-browsers`; launch `playwright-core` with `executablePath`). Add PDF golden-file tests for the pipeline: (a) AcroForm extracts with zero AI calls; (b) a flat checklist extracts via the `tool_use` path **and** the ```json-fence fallback (mock a text-wrapped response); (c) round-trip export overlays values at stored points with letterhead untouched.
- **Keep CI green.** `.github/workflows/ci.yml` runs typecheck, web+api build, and Drizzle drift check on every push. If you change the schema, run `pnpm db:generate` and commit the migration.
- **Commit style:** conventional prefixes (`feat:`, `ci:`, …), imperative, with the repo's Co-Authored-By / Claude-Session trailers. Do **not** put model identifiers in commits/PRs.
- **Branch/PR:** merged PRs are finished — never restack on merged history. Start from `origin/main`, push to `claude/formai-enterprise-overview-deivll`, open a **new draft PR**, subscribe to its activity, and keep it green.
- Phase 2 is large — land it in reviewable slices (e.g. builder, then import pipeline, then fill+submissions) rather than one monster commit. Ask before assuming on anything genuinely ambiguous (e.g. exact bounding-box format edge cases, export column sets).

## Out of scope for Phase 2 (later phases)

Enterprise/org admin (team, roles matrix, audit UI, billing), competency gating,
and the mobile field app — all real and in overall scope, but sequenced after
the core loop. Don't build ahead into them.
