import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, THEME_TOKEN_KEYS } from '@formai/shared';
import {
  CONTROL_GUIDANCE,
  EDITOR_SECTIONS,
  formatColor,
  guidanceFor,
  hexToRgb,
  parseColorInput,
  rgbToHex,
} from './theme-editor.js';

describe('CONTROL_GUIDANCE', () => {
  /**
   * The original complaint this feature answers is "no true guidance of what branding
   * selections get applied to what areas". A themeable control with no
   * guidance entry is that gap reappearing, so assert full coverage.
   */
  it('covers every theme token key', () => {
    for (const key of THEME_TOKEN_KEYS) {
      expect(CONTROL_GUIDANCE[key], key).toBeDefined();
    }
  });

  it('covers the brand kit controls too', () => {
    for (const key of ['primaryColor', 'secondaryColor', 'accentColor', 'formFont', 'logoAssetUrl']) {
      expect(CONTROL_GUIDANCE[key], key).toBeDefined();
    }
  });

  it('gives every entry non-empty guidance and a region', () => {
    for (const [key, g] of Object.entries(CONTROL_GUIDANCE)) {
      expect(g.appliesTo, key).toBeTruthy();
      expect(g.region, key).toBeTruthy();
    }
  });

  it('returns undefined for an unknown control', () => {
    expect(guidanceFor('nonsense')).toBeUndefined();
  });
});

describe('EDITOR_SECTIONS', () => {
  it('assigns every theme token to exactly one section', () => {
    const seen = EDITOR_SECTIONS.flatMap((s) => s.keys);
    expect(new Set(seen).size).toBe(seen.length); // no key in two sections
    for (const key of THEME_TOKEN_KEYS) {
      expect(seen, key).toContain(key);
    }
  });

  it('has a default for every key it exposes', () => {
    for (const section of EDITOR_SECTIONS) {
      for (const key of section.keys) {
        expect(DEFAULT_THEME[key], `${section.id}.${key}`).toBeDefined();
      }
    }
  });
});

describe('colour conversion', () => {
  it('round-trips hex through rgb', () => {
    expect(hexToRgb('#112233')).toEqual({ r: 17, g: 34, b: 51 });
    expect(rgbToHex(17, 34, 51)).toBe('#112233');
  });

  it('formats for display without changing what is stored', () => {
    expect(formatColor('#112233', 'hex')).toBe('#112233');
    expect(formatColor('#112233', 'rgb')).toBe('rgb(17, 34, 51)');
  });

  it('leaves an unparseable value alone when formatting', () => {
    expect(formatColor('nope', 'rgb')).toBe('nope');
  });

  it('clamps out-of-range channels rather than emitting invalid hex', () => {
    expect(rgbToHex(300, -20, 128)).toBe('#ff0080');
  });

  it('parses the shapes people actually paste from a brand guide', () => {
    expect(parseColorInput('#AABBCC')).toBe('#aabbcc');
    expect(parseColorInput('aabbcc')).toBe('#aabbcc');
    expect(parseColorInput('#abc')).toBe('#aabbcc');
    expect(parseColorInput('rgb(17, 34, 51)')).toBe('#112233');
    expect(parseColorInput('17, 34, 51')).toBe('#112233');
    expect(parseColorInput('17 34 51')).toBe('#112233');
    expect(parseColorInput('  #112233  ')).toBe('#112233');
  });

  /**
   * Returning null mid-typing is deliberate: the caller keeps the previous
   * colour rather than writing a broken one on every keystroke.
   */
  it('returns null for text that is not a colour yet', () => {
    expect(parseColorInput('')).toBeNull();
    expect(parseColorInput('#12')).toBeNull();
    expect(parseColorInput('#1122')).toBeNull();
    expect(parseColorInput('rgb(300, 0, 0)')).toBeNull();
    expect(parseColorInput('red')).toBeNull();
    expect(parseColorInput('#gggggg')).toBeNull();
  });
});
