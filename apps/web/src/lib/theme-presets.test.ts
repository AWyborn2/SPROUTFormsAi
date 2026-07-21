import { describe, expect, it } from 'vitest';
import type { ThemeTokens } from '@formai/shared';
import { applyPreset, findThemePreset, resolveTheme, THEME_PRESETS } from '@formai/shared';

/** A theme with every colour role set, so any leak is visible. */
const PALETTE: ThemeTokens = {
  pageBackground: '#111111',
  formBackground: '#222222',
  headingColor: '#333333',
  bodyColor: '#444444',
  labelColor: '#555555',
  borderColor: '#666666',
};

describe('THEME_PRESETS', () => {
  it('ships several presets with unique ids', () => {
    expect(THEME_PRESETS.length).toBeGreaterThanOrEqual(4);
    const ids = THEME_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * Covers AE2, at the data level. R7 holds because presets structurally
   * cannot carry colour, so assert the shipped data really is colour-free
   * rather than trusting the type alone (these are the values a preset would
   * silently overwrite a customer's palette with).
   */
  it('carries no colour role or layout on any preset', () => {
    const forbidden = [
      'pageBackground',
      'formBackground',
      'headingColor',
      'bodyColor',
      'labelColor',
      'borderColor',
      'layout',
    ];
    for (const preset of THEME_PRESETS) {
      for (const key of forbidden) {
        expect(Object.keys(preset.tokens), `${preset.id}.${key}`).not.toContain(key);
      }
    }
  });

  it('resolves cleanly against the defaults', () => {
    for (const preset of THEME_PRESETS) {
      const resolved = resolveTheme(preset.tokens as ThemeTokens);
      expect(resolved.radius, preset.id).toBeTypeOf('number');
      expect(resolved.density, preset.id).toBeTruthy();
    }
  });
});

describe('applyPreset', () => {
  /** Covers AE2. The palette must survive byte-identically. */
  it('leaves every colour role untouched', () => {
    for (const preset of THEME_PRESETS) {
      const next = applyPreset(PALETTE, preset);
      expect(next.pageBackground, preset.id).toBe('#111111');
      expect(next.formBackground, preset.id).toBe('#222222');
      expect(next.headingColor, preset.id).toBe('#333333');
      expect(next.bodyColor, preset.id).toBe('#444444');
      expect(next.labelColor, preset.id).toBe('#555555');
      expect(next.borderColor, preset.id).toBe('#666666');
    }
  });

  it('changes shape, typography and spacing', () => {
    const sharp = findThemePreset('sharp')!;
    const next = applyPreset({ ...PALETTE, radius: 18, density: 'spacious' }, sharp);
    expect(next.radius).toBe(0);
    expect(next.buttonShape).toBe('square');
    expect(next.density).toBe('compact');
  });

  /**
   * Layout is structural, not stylistic — swapping style presets must not move
   * a form off the layout its author picked.
   */
  it('preserves the chosen layout', () => {
    const next = applyPreset({ layout: 'split' }, findThemePreset('bold')!);
    expect(next.layout).toBe('split');
  });

  it('is not cumulative across successive presets', () => {
    const soft = findThemePreset('soft')!;
    const sharp = findThemePreset('sharp')!;
    const viaSoft = applyPreset(applyPreset(PALETTE, soft), sharp);
    const direct = applyPreset(PALETTE, sharp);
    expect(viaSoft).toEqual(direct);
  });

  it('does not mutate its inputs', () => {
    const current: ThemeTokens = { radius: 18 };
    const preset = findThemePreset('sharp')!;
    const before = JSON.stringify(preset.tokens);
    applyPreset(current, preset);
    expect(current).toEqual({ radius: 18 });
    expect(JSON.stringify(preset.tokens)).toBe(before);
  });

  it('returns undefined for an unknown preset id', () => {
    expect(findThemePreset('nope')).toBeUndefined();
  });
});
