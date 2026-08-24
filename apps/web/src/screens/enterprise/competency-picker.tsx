/**
 * The searchable, family-grouped competency picker (U7 — R10, KTD10). One
 * component serves all four scope editors and both tiers, replacing the flat
 * chip wall that stopped scaling past a handful of register entries.
 *
 * Grouping is DERIVED from the org's own codes — the family is the code's
 * leading alpha token — never from a hardcoded list (R12): the engine cannot
 * know any customer's code taxonomy. When derivation says the codes carry no
 * families (most groups are singletons), the picker falls back to a flat
 * searchable list rather than rendering a wall of one-entry headers — grouping
 * is a function of customer code hygiene the engine cannot assume (KTD10).
 */
import { useState } from 'react';
import { Icon, Input } from '@formai/ui';
import type { Competency } from '../../lib/data/types.js';

export type RequirementTier = 'required' | 'recommended';

/** The editor's draft selection, one set per tier. */
export interface TierSelection {
  required: Set<string>;
  recommended: Set<string>;
}

/**
 * THE CLIENT-SIDE OVERLAP RULE (KTD1, shipped with the role editor and
 * re-pinned here): one row per (scope, competency) — the tier is a column, so
 * a competency cannot sit in both tiers. Selecting it in one tier MOVES it out
 * of the other, structurally, instead of letting the save find the 400
 * `tiers_overlap`. Pure and non-mutating so React state stays honest.
 */
export function toggleSelection(
  prev: TierSelection,
  tier: RequirementTier,
  competencyId: string,
): TierSelection {
  const next = { required: new Set(prev.required), recommended: new Set(prev.recommended) };
  const other: RequirementTier = tier === 'required' ? 'recommended' : 'required';
  if (next[tier].has(competencyId)) {
    next[tier].delete(competencyId);
  } else {
    next[tier].add(competencyId);
    next[other].delete(competencyId);
  }
  return next;
}

/**
 * The derived family key (KTD10): the code's leading alpha token — the regex
 * stops at the first `-` or digit boundary by construction — uppercased. A
 * codeless competency (or a code with no leading alpha) groups under its first
 * name word instead. Derived per org from its own data, never a list (R12).
 */
export function familyOf(c: Pick<Competency, 'code' | 'name'>): string {
  const alpha = c.code ? /^[A-Za-z]+/.exec(c.code)?.[0] : undefined;
  if (alpha) return alpha.toUpperCase();
  const word = /^\S+/.exec(c.name.trim())?.[0] ?? '';
  return word.toUpperCase() || 'OTHER';
}

/** What the surrounding scopes already say about one competency. */
export interface InheritedCoverage {
  tier: RequirementTier;
  /** The scope names that impose it — "Boddington Bauxite Mine", "org-wide". */
  sources: string[];
}

export function CompetencyPicker({
  competencies,
  selection,
  onToggle,
  disabled,
  scopeName,
  inherited,
}: {
  /** The register plus anything inline-created that the cache has not caught up with. */
  competencies: Competency[];
  selection: TierSelection;
  onToggle: (tier: RequirementTier, competencyId: string) => void;
  /** A retired scope reads only — every checkbox disabled, nothing else changes. */
  disabled?: boolean;
  /** The scope's display name, for the per-option aria labels. */
  scopeName: string;
  /**
   * The inherited context, by competency id. A competency already REQUIRED
   * by a surrounding scope leaves the options list — it applies regardless,
   * and nothing stronger can be added here (unless this scope's own selection
   * duplicates it, which must stay visible to be unticked). One inherited as
   * RECOMMENDED stays listed — requiring it here is a real upgrade — with the
   * source named on the row.
   */
  inherited?: ReadonlyMap<string, InheritedCoverage>;
}) {
  const [search, setSearch] = useState('');
  // Groups the admin opened by hand. Search does NOT write here: typing
  // auto-expands matching groups and clearing the box re-collapses back to
  // exactly this set (the U7 interaction spec).
  const [manualOpen, setManualOpen] = useState<ReadonlySet<string>>(new Set());

  const q = search.trim().toLowerCase();
  const matches = (c: Competency) =>
    q === '' || c.name.toLowerCase().includes(q) || (c.code ?? '').toLowerCase().includes(q);

  const allSorted = [...competencies].sort((a, b) => a.name.localeCompare(b.name));
  const coveredByInheritance = (c: Competency) =>
    inherited?.get(c.id)?.tier === 'required' &&
    !selection.required.has(c.id) &&
    !selection.recommended.has(c.id);
  const sorted = allSorted.filter((c) => !coveredByInheritance(c));
  const hiddenCount = allSorted.length - sorted.length;
  const groups = new Map<string, Competency[]>();
  for (const c of sorted) {
    const key = familyOf(c);
    const bucket = groups.get(key);
    if (bucket) bucket.push(c);
    else groups.set(key, [c]);
  }
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  // The degenerate-data fallback (KTD10): when OVER HALF the derived groups
  // hold a single competency, the codes carry no family signal and headers
  // would only add clicks — render flat instead.
  const singletons = sortedGroups.filter(([, cs]) => cs.length === 1).length;
  const flat = sortedGroups.length === 0 || singletons > sortedGroups.length / 2;

  const picked: Array<{ competency: Competency; tier: RequirementTier }> = sorted.flatMap(
    (c): Array<{ competency: Competency; tier: RequirementTier }> =>
      selection.required.has(c.id)
        ? [{ competency: c, tier: 'required' }]
        : selection.recommended.has(c.id)
          ? [{ competency: c, tier: 'recommended' }]
          : [],
  );

  const visible = sorted.filter(matches);

  const optionRow = (c: Competency) => (
    <div key={c.id} className="flex items-center justify-between gap-2 py-0.5">
      <span className="min-w-0 truncate text-[11.5px] font-medium">
        {c.name}
        {c.code && (
          <span className="ml-1.5 font-mono text-[9.5px] uppercase text-text-tertiary">
            {c.code}
          </span>
        )}
        {inherited?.get(c.id)?.tier === 'recommended' && (
          // Requiring it here is a real upgrade; re-recommending would only
          // restate what the named scope already says.
          <span className="ml-1.5 text-[9.5px] text-text-tertiary">
            already recommended from {inherited.get(c.id)!.sources.join(', ')}
          </span>
        )}
      </span>
      <span className="flex flex-none items-center gap-3">
        {(['required', 'recommended'] as const).map((tier) => (
          <label
            key={tier}
            className="flex cursor-pointer items-center gap-1 text-[10.5px] text-text-tertiary"
          >
            <input
              type="checkbox"
              aria-label={`${tier === 'required' ? 'Require' : 'Recommend'} ${c.name} for ${scopeName}`}
              checked={selection[tier].has(c.id)}
              disabled={disabled}
              onChange={() => onToggle(tier, c.id)}
            />
            {tier === 'required' ? 'Require' : 'Recommend'}
          </label>
        ))}
      </span>
    </div>
  );

  return (
    <div className="flex flex-col gap-2">
      {/* The Selected strip: pinned above the groups, both tiers, always
          showing the current picks — a pick must never vanish behind a
          collapsed group or a narrowing search (the U7 spec). */}
      <div
        aria-label={`Selected competencies for ${scopeName}`}
        className="flex flex-wrap items-center gap-1.5 rounded-sm border border-border-subtle bg-surface-card p-1.5"
      >
        {picked.length === 0 ? (
          <span className="text-[10.5px] text-text-tertiary">Nothing selected yet.</span>
        ) : (
          picked.map(({ competency, tier }) => (
            <span
              key={competency.id}
              className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10.5px] font-medium ${
                tier === 'required'
                  ? 'border-success bg-success-soft text-success-text'
                  : 'border-border bg-surface-sunken text-text-secondary'
              }`}
            >
              {competency.name}
              <span className="text-[9px] uppercase tracking-wide opacity-70">{tier}</span>
            </span>
          ))
        )}
      </div>

      <Input
        aria-label={`Search competencies for ${scopeName}`}
        placeholder="Search by name or code"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {/* Say what the list is NOT showing, or a search for an inherited
          requirement reads as the register missing it. */}
      {hiddenCount > 0 && (
        <p className="text-[10.5px] text-text-tertiary">
          {hiddenCount} already required by inheritance {hiddenCount === 1 ? 'is' : 'are'} not
          listed — {hiddenCount === 1 ? 'it applies' : 'they apply'} here regardless.
        </p>
      )}

      {visible.length === 0 ? (
        <p className="text-[11.5px] text-text-tertiary">
          {q !== '' && allSorted.some((c) => matches(c) && coveredByInheritance(c))
            ? 'Every match is already required by inheritance — nothing to add here.'
            : `No competencies match “${search.trim()}”.`}
        </p>
      ) : flat ? (
        // Degenerate data: a flat list with no headers (KTD10) — search alone
        // does the narrowing.
        <div className="flex flex-col">{visible.map(optionRow)}</div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {sortedGroups.map(([family, members]) => {
            const matching = q ? members.filter(matches) : members;
            // Searching filters ACROSS groups: a family with no match leaves
            // the view entirely rather than lingering as an empty header.
            if (q && matching.length === 0) return null;
            const expanded = q !== '' || manualOpen.has(family);
            return (
              <div key={family}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() =>
                    setManualOpen((prev) => {
                      const next = new Set(prev);
                      if (next.has(family)) next.delete(family);
                      else next.add(family);
                      return next;
                    })
                  }
                  className="flex items-center gap-1.5 py-0.5 text-[11px] font-semibold text-text-secondary hover:text-text-primary"
                >
                  <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={11} />
                  {family} ({members.length})
                </button>
                {expanded && <div className="flex flex-col pl-4">{matching.map(optionRow)}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
