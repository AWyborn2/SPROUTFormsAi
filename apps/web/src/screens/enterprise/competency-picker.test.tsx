// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Competency } from '../../lib/data/types.js';
import {
  CompetencyPicker,
  familyOf,
  toggleSelection,
  type TierSelection,
} from './competency-picker.js';

/** A register entry. Codes are deliberately NON-CHC inventions (R12): the
 *  families below must fall out of the fixture's own codes, never a list. */
function comp(id: string, name: string, code: string | null = null): Competency {
  return { id, name, code, holders: 0, validForMonths: null, gracePeriodDays: null, color: 'var(--accent)' };
}

/** Two families of two plus one codeless singleton — grouped mode (1 of 3 singletons, not over half). */
const GROUPED = [
  comp('z1', 'Widget Handling', 'ZAP-101'),
  comp('z2', 'Widget Rigging', 'ZAP-205'),
  comp('l1', 'Crane Ops', 'LIFT300'),
  comp('l2', 'Crane Advanced', 'LIFT400'),
  comp('f1', 'First Response'),
];

/** Prefix-free codes: every family is a singleton — the degenerate flat fallback (KTD10). */
const DEGENERATE = [
  comp('a', 'Alpha Thing', 'AA-1'),
  comp('b', 'Beta Thing', 'BB-1'),
  comp('c', 'Gamma Thing', 'CC-1'),
];

/** Stateful harness: the picker is controlled, and the overlap rule lives in
 *  `toggleSelection` (KTD1 — selecting in one tier moves it out of the other),
 *  so the harness wires exactly what ScopeRequirements wires. */
function Harness({
  competencies,
  initial,
}: {
  competencies: Competency[];
  initial?: TierSelection;
}) {
  const [selection, setSelection] = useState<TierSelection>(
    initial ?? { required: new Set(), recommended: new Set() },
  );
  return (
    <CompetencyPicker
      competencies={competencies}
      selection={selection}
      onToggle={(tier, id) => setSelection((prev) => toggleSelection(prev, tier, id))}
      scopeName="Dozer Operator"
    />
  );
}

const requireBox = (name: string) =>
  screen.getByLabelText(`Require ${name} for Dozer Operator`) as HTMLInputElement;
const recommendBox = (name: string) =>
  screen.getByLabelText(`Recommend ${name} for Dozer Operator`) as HTMLInputElement;
const search = () => screen.getByLabelText('Search competencies for Dozer Operator');

describe('familyOf (KTD10)', () => {
  it('derives the family from the code’s leading alpha token, split on - or digit', () => {
    expect(familyOf({ code: 'ZAP-101', name: 'x' })).toBe('ZAP');
    expect(familyOf({ code: 'LIFT300', name: 'x' })).toBe('LIFT');
    expect(familyOf({ code: 'q34666893', name: 'x' })).toBe('Q');
  });

  it('groups a codeless competency under its first name word (KTD10)', () => {
    expect(familyOf({ code: null, name: 'First Response' })).toBe('FIRST');
    // A code with no leading alpha has no token to offer — the name steps in.
    expect(familyOf({ code: '34X', name: 'Odd Code' })).toBe('ODD');
  });
});

describe('CompetencyPicker — grouped mode (R10, KTD10)', () => {
  it('derives collapsed, count-labelled groups from the org’s own codes — never a hardcoded list (R12)', () => {
    render(<Harness competencies={GROUPED} />);
    // The families are the fixture's inventions, proving derivation (R12).
    const zap = screen.getByRole('button', { name: /ZAP \(2\)/ });
    expect(screen.getByRole('button', { name: /LIFT \(2\)/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /FIRST \(1\)/ })).toBeDefined();
    // Collapsed by default: options hidden, expanded state announced (aria).
    expect(zap.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Require Widget Handling for Dozer Operator')).toBeNull();
    // Expanding a group reveals its labelled checkboxes.
    fireEvent.click(zap);
    expect(zap.getAttribute('aria-expanded')).toBe('true');
    expect(requireBox('Widget Handling').checked).toBe(false);
    expect(recommendBox('Widget Handling').checked).toBe(false);
  });

  it('search filters across all groups and auto-expands the matching ones; clearing re-collapses', () => {
    render(<Harness competencies={GROUPED} />);
    fireEvent.change(search(), { target: { value: 'rigging' } });
    // The match surfaced without any header click…
    expect(requireBox('Widget Rigging').checked).toBe(false);
    // …its siblings without a match stay out of the way…
    expect(screen.queryByLabelText('Require Widget Handling for Dozer Operator')).toBeNull();
    // …and groups with no match disappear entirely.
    expect(screen.queryByRole('button', { name: /LIFT \(2\)/ })).toBeNull();
    // Clearing the search re-collapses.
    fireEvent.change(search(), { target: { value: '' } });
    expect(screen.queryByLabelText('Require Widget Rigging for Dozer Operator')).toBeNull();
    expect(screen.getByRole('button', { name: /ZAP \(2\)/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('search matches codes as well as names', () => {
    render(<Harness competencies={GROUPED} />);
    fireEvent.change(search(), { target: { value: 'lift4' } });
    expect(requireBox('Crane Advanced')).toBeDefined();
    expect(screen.queryByLabelText('Require Crane Ops for Dozer Operator')).toBeNull();
  });

  it('keeps the Selected strip pinned through collapse and search', () => {
    render(<Harness competencies={GROUPED} />);
    const strip = () => screen.getByLabelText('Selected competencies for Dozer Operator');
    expect(within(strip()).getByText(/Nothing selected yet/)).toBeDefined();

    const zap = screen.getByRole('button', { name: /ZAP \(2\)/ });
    fireEvent.click(zap);
    fireEvent.click(requireBox('Widget Handling'));
    expect(within(strip()).getByText('Widget Handling')).toBeDefined();

    // Collapse the group: the pick stays on the strip.
    fireEvent.click(zap);
    expect(screen.queryByLabelText('Require Widget Handling for Dozer Operator')).toBeNull();
    expect(within(strip()).getByText('Widget Handling')).toBeDefined();

    // Search away from it: still on the strip, tier named.
    fireEvent.change(search(), { target: { value: 'crane' } });
    expect(within(strip()).getByText('Widget Handling')).toBeDefined();
    expect(within(strip()).getByText('required')).toBeDefined();
  });

  it('moves a pick between tiers rather than doubling it (KTD1 overlap rule)', () => {
    render(<Harness competencies={GROUPED} />);
    fireEvent.click(screen.getByRole('button', { name: /ZAP \(2\)/ }));
    fireEvent.click(requireBox('Widget Handling'));
    expect(requireBox('Widget Handling').checked).toBe(true);
    fireEvent.click(recommendBox('Widget Handling'));
    expect(recommendBox('Widget Handling').checked).toBe(true);
    expect(requireBox('Widget Handling').checked).toBe(false);
  });

  it('says so when a search matches nothing', () => {
    render(<Harness competencies={GROUPED} />);
    fireEvent.change(search(), { target: { value: 'zzz-no-such' } });
    expect(screen.getByText(/No competencies match/)).toBeDefined();
  });
});

describe('CompetencyPicker — degenerate flat fallback (KTD10, R12)', () => {
  it('renders a flat searchable list when most families are singletons', () => {
    render(<Harness competencies={DEGENERATE} />);
    // No group headers at all…
    expect(screen.queryByRole('button', { name: /\(\d+\)/ })).toBeNull();
    // …every option directly visible…
    expect(requireBox('Alpha Thing')).toBeDefined();
    expect(requireBox('Gamma Thing')).toBeDefined();
    // …and the search still narrows.
    fireEvent.change(search(), { target: { value: 'beta' } });
    expect(requireBox('Beta Thing')).toBeDefined();
    expect(screen.queryByLabelText('Require Alpha Thing for Dozer Operator')).toBeNull();
  });
});

describe('toggleSelection (KTD1)', () => {
  it('adds, removes, and moves across tiers without mutating the previous selection', () => {
    const start: TierSelection = { required: new Set(['a']), recommended: new Set() };
    const moved = toggleSelection(start, 'recommended', 'a');
    expect([...moved.recommended]).toEqual(['a']);
    expect(moved.required.size).toBe(0);
    // The previous selection is untouched — React state discipline.
    expect([...start.required]).toEqual(['a']);
    const removed = toggleSelection(moved, 'recommended', 'a');
    expect(removed.recommended.size).toBe(0);
  });
});
