import { describe, expect, it } from 'vitest';
import { sourcesLine, sourcesPhrase } from './competency-sources.js';
import type { CompetencySourceRef } from './data/types.js';

const loc = (name: string): CompetencySourceRef => ({ scope: 'location', name });
const dept = (name: string): CompetencySourceRef => ({ scope: 'department', name });
const role = (name: string): CompetencySourceRef => ({ scope: 'role', name });
const org: CompetencySourceRef = { scope: 'org', name: 'Org One' };

describe('sourcesPhrase / sourcesLine — the one caption spelling (U8, R5)', () => {
  it('pins the AE1 comma-join: commas, then "and" before the last', () => {
    expect(sourcesLine('required', [loc('Boddington'), dept('Operations'), role('Dozer Operator')])).toBe(
      'Required — from Boddington, Operations and Dozer Operator',
    );
  });

  it('renders a single source without punctuation gymnastics (AE5)', () => {
    expect(sourcesLine('recommended', [loc('Boddington')])).toBe('Recommended — from Boddington');
  });

  it('renders the org scope as "org-wide", never the organisation’s name (AE1)', () => {
    // Alone, it drops the "from" — org-wide is a fact, not a place…
    expect(sourcesLine('required', [org])).toBe('Required — org-wide');
    // …and in a mixed list it joins as a member.
    expect(sourcesPhrase([org, role('Dozer Operator')])).toBe('from org-wide and Dozer Operator');
  });

  it('joins exactly two with "and" and no comma', () => {
    expect(sourcesPhrase([loc('Boddington'), role('Dozer Operator')])).toBe(
      'from Boddington and Dozer Operator',
    );
  });

  it('says nothing where there is nothing honest to say', () => {
    // Absent (a gated read) and empty (an optional entry) both render NO line
    // — the difference is the API's to express, not this caption's.
    expect(sourcesLine('required', undefined)).toBeNull();
    expect(sourcesLine('required', [])).toBeNull();
    // Optional standing names nothing even when handed sources by mistake.
    expect(sourcesLine('optional', [loc('Boddington')])).toBeNull();
  });
});
