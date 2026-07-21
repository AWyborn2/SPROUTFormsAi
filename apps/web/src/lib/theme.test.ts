/**
 * Tests for the shared theme model. They live in `apps/web` rather than
 * `packages/shared` because shared ships with zero dependencies by design and
 * has no test runner; web already depends on it and runs vitest.
 */
import { describe, expect, it } from 'vitest';
import type { ThemeTokens } from '@formai/shared';
import { DEFAULT_THEME, resolveTheme, THEME_TOKEN_KEYS } from '@formai/shared';

describe('resolveTheme', () => {
  it('returns the defaults when neither layer sets anything', () => {
    expect(resolveTheme()).toEqual(DEFAULT_THEME);
    expect(resolveTheme(null, null)).toEqual(DEFAULT_THEME);
    expect(resolveTheme({}, {})).toEqual(DEFAULT_THEME);
  });

  /** Covers AE3 — a pre-feature org carries no theme and must be unchanged. */
  it('resolves to defaults for an org that predates theming', () => {
    const resolved = resolveTheme(undefined);
    expect(resolved).toEqual(DEFAULT_THEME);
    expect(resolved.radius).toBe(DEFAULT_THEME.radius);
    expect(resolved.layout).toBe('card');
  });

  it('lets the org theme override the defaults', () => {
    const resolved = resolveTheme({ radius: 4, layout: 'hero' });
    expect(resolved.radius).toBe(4);
    expect(resolved.layout).toBe('hero');
    // Untouched keys still come from the defaults.
    expect(resolved.density).toBe(DEFAULT_THEME.density);
  });

  it('lets a form override win over the org theme', () => {
    const resolved = resolveTheme({ radius: 4, layout: 'hero' }, { layout: 'split' });
    expect(resolved.layout).toBe('split');
  });

  /**
   * Covers AE4. The failure this guards is a form override behaving as a
   * complete document: keys it does not mention must fall through to the org's
   * value, not back to the product default.
   */
  it('inherits the org value for keys the form override omits', () => {
    const org: ThemeTokens = { radius: 4, density: 'compact', headingSize: 30 };
    const resolved = resolveTheme(org, { headingSize: 40 });
    expect(resolved.headingSize).toBe(40);
    expect(resolved.radius).toBe(4);
    expect(resolved.density).toBe('compact');
  });

  /**
   * A sparse patch is built by spreading edited fields, which readily produces
   * explicit `undefined`. That must read as "not set", never as "clear it".
   */
  it('treats an explicit undefined as unset rather than a reset', () => {
    const resolved = resolveTheme({ radius: 4 }, { radius: undefined, layout: undefined });
    expect(resolved.radius).toBe(4);
    expect(resolved.layout).toBe(DEFAULT_THEME.layout);
  });

  it('ignores unknown keys rather than passing them through', () => {
    const rogue = { radius: 4, injected: 'x; background: url(evil)' } as unknown as ThemeTokens;
    const resolved = resolveTheme(rogue) as Record<string, unknown>;
    expect(resolved.radius).toBe(4);
    expect(resolved.injected).toBeUndefined();
  });

  it('tolerates a non-object payload from the network', () => {
    expect(resolveTheme('nope' as unknown as ThemeTokens)).toEqual(DEFAULT_THEME);
    expect(resolveTheme(undefined, 42 as unknown as ThemeTokens)).toEqual(DEFAULT_THEME);
  });

  it('never mutates the layers it merges', () => {
    const org: ThemeTokens = { radius: 4 };
    const form: ThemeTokens = { radius: 9 };
    resolveTheme(org, form);
    expect(org).toEqual({ radius: 4 });
    expect(form).toEqual({ radius: 9 });
  });

  it('covers every declared token key in the defaults', () => {
    // DEFAULT_THEME is Required<ThemeTokens>, so a new optional field added
    // without a default is a compile error — this asserts the runtime view too.
    for (const key of THEME_TOKEN_KEYS) {
      expect(DEFAULT_THEME[key], key).toBeDefined();
    }
    expect(THEME_TOKEN_KEYS.length).toBeGreaterThan(15);
  });
});
