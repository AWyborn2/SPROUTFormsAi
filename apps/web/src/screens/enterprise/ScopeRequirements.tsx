/**
 * ONE scope's requirements editor (U6 — R1, R5, R6, R9, KTD6–KTD9), extracted
 * from TaxonomyScreen.tsx (the deferred file-size split) and generalised from
 * the shipped RoleRequirements: the same component now mounts per role, per
 * department, per location, and once for the whole organisation.
 *
 * What is IDENTICAL at every scope: collapsed by default with a lazy fetch on
 * expand; REQUIRED edits travel preview → confirm (R6 — the blast radius in
 * competency terms before anything lands); RECOMMENDED-only edits save
 * directly (the prior round's R13 rule — the tier enforces nothing, so there
 * is no radius to confirm); every write echoes the GET's scope-local
 * fingerprint and a 409 `requirements_changed` reloads the editor with a
 * notice rather than silently overwriting (KTD7); a retired scope reads only.
 *
 * What is ROLE-ONLY: the R50 `configured` flag, the legacy `awaitingLink`
 * rows and their previewed remove (no other scope ever had legacy tool
 * derivation, KTD2/KTD6), and the location lens over the inherited display.
 *
 * THE INHERITED SECTION (R9) is locked, source-named CONTEXT — display only,
 * never part of the save, and computed CLIENT-SIDE from the same scope GETs
 * the editors already speak (the provenance read surface is U8's): a role
 * editor unions the org list, its own department's list, and — under the lens
 * — one location's list. That is exactly the defined population the copy
 * names: "for a member placed in <Department> at <Location>" — the premise
 * matters because department/location requirements follow PLACEMENT (R3), so
 * a real holder placed elsewhere inherits differently, and a locked chip must
 * never assert an obligation false for some holders without naming it.
 * Department and location editors inherit the org list only; the org editor
 * inherits nothing.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Icon, Input, Select, useToast } from '@formai/ui';
import type { RequiredAssessmentsChangeEffects } from '@formai/shared';
import {
  useAssessmentTools,
  useCompetencies,
  usePreviewScopeRequirements,
  useRemoveLegacyRequirement,
  useScopeRequirements,
  useSetScopeRequirements,
} from '../../lib/data/hooks.js';
import type {
  RequirementScope,
  RequirementScopeRef,
  ScopeRequirementsState,
  Taxonomy,
} from '../../lib/data/types.js';
import { ApiError } from '../../lib/data/api-client.js';
import { useInlineCompetencyCreate } from '../../lib/data/use-inline-competency-create.js';
import {
  CompetencyPicker,
  toggleSelection,
  type RequirementTier,
} from './competency-picker.js';

/** The scope one editor instance edits, plus what the copy needs to say about it. */
export interface ScopeTarget {
  scope: RequirementScope;
  /** Absent at org scope (KTD6). */
  scopeId?: string;
  /** Display name — aria labels, toasts, the collapse row. */
  name: string;
  /** A retired scope reads only (the R121 posture at every scope). Org never retires. */
  retired?: boolean;
  /** ROLE SCOPE ONLY: the owning department — the inherited-population premise (R3, R9). */
  departmentId?: string;
}

/** One inherited competency, deduped across the contributing scopes. */
interface InheritedEntry {
  competencyId: string;
  tier: RequirementTier;
  /** The scope names that impose it AT the winning tier. */
  sources: string[];
}

/**
 * Union the inherited context per R2's precedence: required beats recommended,
 * so a competency required by one scope and recommended by another renders
 * once, under required, sourced to the scope(s) that REQUIRE it — naming the
 * recommender there would misattribute the obligation.
 */
function inheritedEntries(
  parts: ReadonlyArray<{ label: string; state: ScopeRequirementsState | undefined }>,
): InheritedEntry[] {
  const required = new Map<string, string[]>();
  const recommended = new Map<string, string[]>();
  for (const part of parts) {
    if (!part.state) continue;
    for (const id of part.state.required) {
      required.set(id, [...(required.get(id) ?? []), part.label]);
    }
    for (const id of part.state.recommended) {
      recommended.set(id, [...(recommended.get(id) ?? []), part.label]);
    }
  }
  return [
    ...[...required].map(([competencyId, sources]) => ({
      competencyId,
      tier: 'required' as const,
      sources,
    })),
    ...[...recommended]
      .filter(([competencyId]) => !required.has(competencyId))
      .map(([competencyId, sources]) => ({
        competencyId,
        tier: 'recommended' as const,
        sources,
      })),
  ];
}

/**
 * The collapsed row's one-line summary. Empty until the editor has fetched;
 * role scope keeps "not set up" apart from "requires nothing" because
 * `configured` is the stored fact, never a row count (R50) — the other scopes
 * have no legacy ambiguity and no flag. An own-empty list stops lying by
 * omission once the inherited sets are known (KTD9): "requires nothing of its
 * own · N inherited". `inheritedRequired` is null while those sets are
 * UNFETCHED (the editor never expanded) — the own-list summary stands until
 * then, the plan's pragmatic lazy choice, rather than eagerly fetching three
 * scopes for every collapsed row.
 */
export function requirementSummary(
  scope: RequirementScope,
  current: ScopeRequirementsState | undefined,
  inheritedRequired: number | null,
): string {
  if (!current) return '';
  const inheritedSuffix =
    inheritedRequired !== null && inheritedRequired > 0 ? ` · ${inheritedRequired} inherited` : '';
  /*
    NEVER-SET-UP IS STILL NOT THE WHOLE STORY (KTD9). "not set up" is the honest
    fact about the Role's OWN list (R50 — the stored flag, never a row count),
    but a role nobody has configured is precisely where the inherited stack is
    doing all the work: an admin reading "not set up" alone concludes the holder
    owes nothing, when the org and their site may owe them eight competencies.
    So the inherited count rides along here too, the exact case KTD9 was written
    for — the "not set up" half is unchanged, so a reader (and every matcher on
    it) still sees the flag it always saw.
  */
  if (scope === 'role' && !current.configured) return `not set up${inheritedSuffix}`;
  if (current.required.length === 0) {
    if (inheritedSuffix) return `requires nothing of its own${inheritedSuffix}`;
    return 'requires nothing';
  }
  const recommended =
    current.recommended.length > 0 ? ` · ${current.recommended.length} recommended` : '';
  return `${current.required.length} required${recommended}`;
}

export function ScopeRequirements({
  target,
  taxonomy,
  onError,
}: {
  target: ScopeTarget;
  /** For the lens options (active locations) and the role's department name. */
  taxonomy: Taxonomy;
  onError: (e: unknown) => void;
}) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const { data: competencies } = useCompetencies();
  // Tool NAMES for the role-only awaitingLink rows — a legacy row is a tool
  // id, and the editor must not print raw ids. Cached org-wide, so mounting
  // this at every scope costs one fetch, not one per editor.
  const { data: tools } = useAssessmentTools();

  const ownRef: RequirementScopeRef =
    target.scope === 'org' ? { scope: 'org' } : { scope: target.scope, scopeId: target.scopeId };
  /*
    Lazy on expand (the shipped pattern), but with a STABLE key gated by
    `enabled` rather than a key swap: once fetched, the data outlives a
    collapse, so the summary keeps reading after the editor closes — the
    KTD9 collapsed-summary behaviour falls out of the cache for free.
  */
  const requirements = useScopeRequirements(ownRef, { enabled: open });
  const current = requirements.data;
  const preview = usePreviewScopeRequirements(ownRef);
  const save = useSetScopeRequirements(ownRef);
  // Role-only machinery; the hook is unconditional (rules of hooks) and inert
  // at the other scopes — nothing ever calls it there.
  const removeLegacy = useRemoveLegacyRequirement(
    target.scope === 'role' ? (target.scopeId ?? '') : '',
  );
  /**
   * Inline create with the created competencies kept locally pickable BEFORE
   * the register cache refetches — the shared hook, same posture the backfill
   * row takes.
   */
  const inlineCreate = useInlineCompetencyCreate(competencies ?? []);

  /* ── The inherited context (R9) — three scope GETs, display only ────────── */

  const department =
    target.scope === 'role'
      ? taxonomy.departments.find((d) => d.id === target.departmentId)
      : undefined;
  // The location lens (R9): all ACTIVE locations — it must work for a role
  // with no holders yet — defaulting to unselected, so org + department
  // context shows without it. DISPLAY ONLY, never part of any save.
  const [lensLocationId, setLensLocationId] = useState('');
  const activeLocations = taxonomy.locations.filter((l) => l.status === 'active');
  const lensLocation =
    target.scope === 'role'
      ? taxonomy.locations.find((l) => l.id === lensLocationId)
      : undefined;

  const inheritsOrg = target.scope !== 'org';
  const orgInherited = useScopeRequirements({ scope: 'org' }, { enabled: open && inheritsOrg });
  const deptInherited = useScopeRequirements(
    department ? { scope: 'department', scopeId: department.id } : undefined,
    { enabled: open },
  );
  const lensInherited = useScopeRequirements(
    lensLocation ? { scope: 'location', scopeId: lensLocation.id } : undefined,
    { enabled: open },
  );

  const inheritedParts: Array<{ label: string; state: ScopeRequirementsState | undefined }> = [
    // Org renders as "org-wide" (the U8 wording, shared here) — it has no
    // taxonomy row to name.
    ...(inheritsOrg ? [{ label: 'org-wide', state: orgInherited.data }] : []),
    ...(department ? [{ label: department.name, state: deptInherited.data }] : []),
    ...(lensLocation ? [{ label: lensLocation.name, state: lensInherited.data }] : []),
  ];
  const inheritedLoaded = inheritedParts.every((p) => p.state !== undefined);
  const inherited = inheritedEntries(inheritedParts);

  /*
    The summary's inherited count deliberately EXCLUDES the lens: the lens is
    a per-open viewing aid, and a collapsed row's copy must not depend on
    which location an admin last peeked at. Org + own-department is the stable
    inherited floor every holder of this scope shares (KTD9).
  */
  const baseInheritedRequired = new Set<string>();
  if (inheritsOrg) for (const id of orgInherited.data?.required ?? []) baseInheritedRequired.add(id);
  if (department) for (const id of deptInherited.data?.required ?? []) baseInheritedRequired.add(id);
  const baseInheritedKnown =
    !inheritsOrg ||
    (orgInherited.data !== undefined && (!department || deptInherited.data !== undefined));
  const summary = requirementSummary(
    target.scope,
    current,
    baseInheritedKnown ? baseInheritedRequired.size : null,
  );

  /* ── Draft + write flow (identical at every scope) ──────────────────────── */

  const [draft, setDraft] = useState<{ required: Set<string>; recommended: Set<string> } | null>(
    null,
  );
  // The blast radius of the pending REQUIRED change, once previewed — the
  // confirmation gate (R6). Null means nothing awaits confirmation.
  const [pending, setPending] = useState<RequiredAssessmentsChangeEffects | null>(null);
  // An awaitingLink removal awaiting its confirm — previewed through the same
  // door (role scope only).
  const [pendingRemove, setPendingRemove] = useState<{
    toolId: string;
    effects: RequiredAssessmentsChangeEffects;
  } | null>(null);
  // Set when a write 409'd `requirements_changed`: the editor reloaded and the
  // admin re-decides against the fresh state rather than over someone else's
  // change (KTD7).
  const [stale, setStale] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCode, setNewCode] = useState('');

  const selected = draft ?? {
    required: new Set(current?.required ?? []),
    recommended: new Set(current?.recommended ?? []),
  };
  const dirty = draft !== null;
  const retired = target.retired === true;
  const sameSet = (a: ReadonlySet<string>, b: readonly string[]) =>
    a.size === b.length && b.every((id) => a.has(id));
  // Only a REQUIRED-tier change carries a blast radius; a recommended-only
  // edit saves without a preview (the prior round's R13 rule, at every scope).
  const requiredChanged =
    dirty && current !== undefined && !sameSet(selected.required, current.required);

  const options = inlineCreate.options;
  const awaitingLink = target.scope === 'role' ? (current?.awaitingLink ?? []) : [];

  function resetFlow() {
    setPending(null);
    setPendingRemove(null);
  }

  function toggle(tier: RequirementTier, competencyId: string) {
    // Changing the selection abandons any preview shown for the old selection.
    resetFlow();
    setDraft((prev) =>
      toggleSelection(
        prev ?? {
          required: new Set(current?.required ?? []),
          recommended: new Set(current?.recommended ?? []),
        },
        tier,
        competencyId,
      ),
    );
  }

  /** A write refused because the requirements moved underneath us (KTD7). */
  function isStaleWrite(err: unknown): boolean {
    return (
      err instanceof ApiError &&
      err.status === 409 &&
      (err.body as { error?: string } | undefined)?.error === 'requirements_changed'
    );
  }

  function onWriteError(err: unknown) {
    if (isStaleWrite(err)) {
      // Reload the editor: the fresh GET carries the other change and a new
      // fingerprint, and the notice explains why the draft was dropped.
      setStale(true);
      setDraft(null);
      resetFlow();
      void requirements.refetch();
      return;
    }
    onError(err);
  }

  function onReview() {
    // The blast radius before committing (R6) — at org scope this counts
    // every active membership (AE3); nothing is written until confirmed.
    resetFlow();
    preview.mutate(
      { required: [...selected.required], recommended: [...selected.recommended] },
      { onSuccess: (r) => setPending(r.effects), onError },
    );
  }

  function doSave() {
    if (!current) return;
    save.mutate(
      {
        required: [...selected.required],
        recommended: [...selected.recommended],
        fingerprint: current.fingerprint,
      },
      {
        onSuccess: () => {
          setDraft(null);
          resetFlow();
          setStale(false);
          toast({ variant: 'success', message: 'Requirements updated.' });
        },
        onError: onWriteError,
      },
    );
  }

  function onRemoveLegacy(toolId: string) {
    if (!current) return;
    // The awaitingLink exit previews through the SAME preview POST: current
    // tiers unchanged, this one legacy row removed (role scope only, KTD6).
    resetFlow();
    preview.mutate(
      {
        required: current.required,
        recommended: current.recommended,
        removeLegacyToolIds: [toolId],
      },
      { onSuccess: (r) => setPendingRemove({ toolId, effects: r.effects }), onError },
    );
  }

  function onConfirmRemove() {
    if (!current || !pendingRemove) return;
    removeLegacy.mutate(
      { toolId: pendingRemove.toolId, fingerprint: current.fingerprint },
      {
        onSuccess: () => {
          resetFlow();
          setStale(false);
          toast({ variant: 'success', message: 'Legacy requirement removed.' });
        },
        onError: onWriteError,
      },
    );
  }

  function onCreate(tier: RequirementTier) {
    const trimmedName = newName.trim();
    if (!trimmedName) {
      toast({ variant: 'warning', message: 'A competency needs a name.' });
      return;
    }
    // No validity asked here (the shared hook creates perpetual) — this flow's
    // job is naming the requirement without leaving it.
    inlineCreate.create(
      trimmedName,
      newCode.trim() || null,
      (added) => {
        toggle(tier, added.id);
        setCreating(false);
        setNewName('');
        setNewCode('');
        toast({ variant: 'success', message: `${added.name} added to the register.` });
      },
      () => toast({ variant: 'warning', message: 'Could not add the competency.' }),
    );
  }

  const competencyName = (id: string) => options.find((c) => c.id === id)?.name ?? '…';
  const sortedInherited = [...inherited].sort((a, b) =>
    competencyName(a.competencyId).localeCompare(competencyName(b.competencyId)),
  );

  /*
    The footer is ONE flow in four mutually-exclusive states, in precedence
    order: a legacy removal awaiting its confirm, a previewed REQUIRED change
    awaiting its confirm, a required change still needing its preview (R6),
    else the plain save — which a recommended-only edit reaches directly (the
    prior round's R13 rule, at every scope). Derived as a union here so the
    panel render below is a flat switch rather than a nested ternary.
  */
  type FooterState =
    | { kind: 'confirm-remove'; effects: RequiredAssessmentsChangeEffects }
    | { kind: 'confirm-change'; effects: RequiredAssessmentsChangeEffects }
    | { kind: 'review' }
    | { kind: 'save' };
  const footerState: FooterState = pendingRemove
    ? { kind: 'confirm-remove', effects: pendingRemove.effects }
    : pending
      ? { kind: 'confirm-change', effects: pending }
      : requiredChanged
        ? { kind: 'review' }
        : { kind: 'save' };

  function footerPanel(state: FooterState) {
    switch (state.kind) {
      case 'confirm-remove':
        return (
          <div className="rounded-md border border-border-accent bg-surface-accent-soft p-[9px_11px] text-[11.5px] text-text-secondary">
            <EffectsSummary effects={state.effects} />
            <div className="mt-2 flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={resetFlow}
                disabled={removeLegacy.isPending}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={onConfirmRemove} disabled={removeLegacy.isPending}>
                Confirm removal
              </Button>
            </div>
          </div>
        );
      case 'confirm-change':
        return (
          <div className="rounded-md border border-border-accent bg-surface-accent-soft p-[9px_11px] text-[11.5px] text-text-secondary">
            <EffectsSummary effects={state.effects} />
            <div className="mt-2 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={resetFlow} disabled={save.isPending}>
                Cancel
              </Button>
              <Button size="sm" onClick={doSave} disabled={save.isPending}>
                Confirm change
              </Button>
            </div>
          </div>
        );
      case 'review':
        return (
          <div className="flex justify-end">
            <Button size="sm" onClick={onReview} disabled={preview.isPending}>
              Review change
            </Button>
          </div>
        );
      case 'save':
        return (
          <div className="flex justify-end">
            {/* A recommended-only edit enforces nothing, so it saves
                without the preview gate (R13 of the prior round). */}
            <Button size="sm" onClick={doSave} disabled={!dirty || save.isPending}>
              {dirty ? 'Save' : 'Saved'}
            </Button>
          </div>
        );
    }
  }

  return (
    <div className="pl-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Requirements for ${target.name}`}
        className="flex items-center gap-1.5 py-0.5 text-[11.5px] text-text-tertiary hover:text-text-secondary"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
        Required competencies{summary ? ` · ${summary}` : ''}
      </button>

      {open && (
        <div className="mb-1 mt-1 rounded-md border border-border bg-surface-sunken p-2.5">
          {retired && (
            <p className="mb-1.5 text-[11px] text-text-tertiary">
              A retired value takes on no new requirements.
            </p>
          )}
          {stale && (
            <p className="mb-1.5 rounded-sm border border-warning bg-warning-soft p-[6px_8px] text-[11px] text-warning-text">
              Requirements changed elsewhere — this editor reloaded with the latest state. Re-apply
              your change if it still applies.
            </p>
          )}

          {/* The inherited context FIRST: what already applies at this scope,
              before choosing what it adds of its own (R9). Locked display —
              nothing here is a control, and staleness cannot corrupt anything
              because none of it is writable (KTD7). */}
          <div className="mb-2 rounded-sm border border-border-subtle bg-surface-card p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10.5px] font-semibold uppercase tracking-wide text-text-tertiary">
                Inherited — edited at its own scope
              </span>
              {target.scope === 'role' && (
                <div className="w-52">
                  <Select
                    aria-label={`Location lens for ${target.name}`}
                    value={lensLocationId}
                    onChange={(e) => setLensLocationId(e.target.value)}
                    options={[
                      { label: 'No location lens', value: '' },
                      ...activeLocations.map((l) => ({ label: l.name, value: l.id })),
                    ]}
                  />
                </div>
              )}
            </div>
            {target.scope === 'role' && department && (
              // THE POPULATION PREMISE (R3, R9): location and department
              // requirements follow placement, so this stack is true for a
              // member placed exactly here — and the copy says so.
              <p className="mt-1 text-[10.5px] text-text-tertiary">
                for a member placed in {department.name}
                {lensLocation ? ` at ${lensLocation.name}` : ''}
              </p>
            )}
            {!inheritedLoaded ? (
              <p className="mt-1 text-[10.5px] text-text-tertiary">Loading inherited context…</p>
            ) : sortedInherited.length === 0 ? (
              // ONE spelling across all four editor types (U6): the org
              // editor always lands here — it inherits from nothing.
              <p className="mt-1 text-[11px] text-text-tertiary">Nothing inherited</p>
            ) : (
              <div
                aria-label={`Inherited requirements for ${target.name}`}
                className="mt-1.5 flex flex-wrap gap-1.5"
              >
                {sortedInherited.map((entry) => (
                  <span
                    key={entry.competencyId}
                    className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-surface-sunken px-2 py-1 text-[11px] text-text-secondary"
                  >
                    <Icon name="lock" size={10} className="text-text-tertiary" />
                    <span className="font-medium">{competencyName(entry.competencyId)}</span>
                    {entry.tier === 'recommended' && (
                      <span className="text-[9px] uppercase tracking-wide text-text-tertiary">
                        recommended
                      </span>
                    )}
                    <span className="text-[10px] text-text-tertiary">
                      from {entry.sources.join(', ')}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {options.length === 0 ? (
            <p className="text-[11.5px] text-text-tertiary">
              No competencies on the register yet — create one below.
            </p>
          ) : (
            <CompetencyPicker
              competencies={options}
              selection={selected}
              onToggle={toggle}
              disabled={retired}
              scopeName={target.name}
            />
          )}

          {!retired && (
            <div className="mt-2">
              {creating ? (
                <div className="flex flex-wrap items-end gap-2 border-t border-border-subtle pt-2">
                  <div className="min-w-[180px] flex-1">
                    <Input
                      label="Competency name"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                    />
                  </div>
                  <div className="w-[130px]">
                    <Input
                      label="Code (optional)"
                      placeholder="Q34666893"
                      value={newCode}
                      onChange={(e) => setNewCode(e.target.value)}
                    />
                  </div>
                  <Button
                    size="sm"
                    onClick={() => onCreate('required')}
                    disabled={inlineCreate.isPending}
                  >
                    Create &amp; require
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onCreate('recommended')}
                    disabled={inlineCreate.isPending}
                  >
                    Create &amp; recommend
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <button
                  onClick={() => setCreating(true)}
                  aria-label={`Create a competency for ${target.name}`}
                  className="fai-chip-btn inline-flex items-center gap-1 rounded-sm py-1 text-[11px] font-medium text-text-accent hover:underline"
                >
                  <Icon name="plus" size={12} />
                  Create competency
                </button>
              )}
            </div>
          )}

          {/* Legacy rows still deriving the old way — ROLE SCOPE ONLY (KTD6):
              each exits via the backfill (link the award on the register) or
              the explicit, previewed remove below. */}
          {awaitingLink.length > 0 && (
            <div className="mt-2 border-t border-border-subtle pt-2">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-warning-text">
                <Icon name="shield-alert" size={12} />
                Awaiting link — still counted the old way
              </div>
              <p className="mt-0.5 text-[10.5px] text-text-tertiary">
                These assessments award nothing yet, so this Role still requires them as tools.
                Link each one to its competency on the register, or remove the requirement.
              </p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {awaitingLink.map((toolId) => {
                  const name = (tools ?? []).find((t) => t.id === toolId)?.name ?? 'Unknown assessment';
                  return (
                    <li key={toolId} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-[11.5px] font-medium">{name}</span>
                      <span className="flex flex-none items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Link the award for ${name}`}
                          onClick={() => navigate('/app/competency')}
                        >
                          Link the award
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Remove legacy requirement ${name}`}
                          disabled={dirty || preview.isPending}
                          onClick={() => onRemoveLegacy(toolId)}
                        >
                          Remove
                        </Button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {!retired && (
            <div className="mt-2 flex flex-col gap-2">{footerPanel(footerState)}</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The blast radius of a pending requirement change, in COMPETENCY terms. An
 * addition says who it affects and how many cases the awarding assessments
 * create — an evidence-only competency contributes "0 cases", which is a real
 * answer. A removal says who it affects, how many cases already in progress
 * run to completion, and how many standings become optional — never a
 * creation count. A save that both adds and removes shows both, and an
 * awaitingLink removal of an UNLINKED tool (no competency moves at all) still
 * names its continuing cases. (Shipped wording, unchanged by the scope
 * generalisation — R11.)
 */
function EffectsSummary({ effects }: { effects: RequiredAssessmentsChangeEffects }) {
  const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
  const cases = (n: number) => `${n} ${n === 1 ? 'case' : 'cases'}`;
  const competencies = (n: number) => `${n} ${n === 1 ? 'competency' : 'competencies'}`;
  const lines: string[] = [];
  if (effects.addedCompetencyIds.length > 0) {
    lines.push(
      `Adds ${competencies(effects.addedCompetencyIds.length)}: affects ${people(effects.affected)}, creating ${cases(effects.created)}.`,
    );
  }
  if (effects.removedCompetencyIds.length > 0) {
    const demoting = effects.competenciesDemoting;
    lines.push(
      `Removes ${competencies(effects.removedCompetencyIds.length)}: affects ${people(effects.affected)}. ` +
        `${cases(effects.inFlightContinuing)} already in progress will run to completion, and ` +
        `${demoting} competency standing${demoting === 1 ? '' : 's'} become optional.`,
    );
  }
  if (lines.length === 0 && effects.inFlightContinuing > 0) {
    // The unlinked-legacy removal: the tool awarded nothing, so no competency
    // leaves required standing — but its cases keep running.
    lines.push(
      `${cases(effects.inFlightContinuing)} already in progress will run to completion; nothing new is created.`,
    );
  }
  if (lines.length === 0) lines.push('This changes nothing.');
  return (
    <div className="flex flex-col gap-1">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}
