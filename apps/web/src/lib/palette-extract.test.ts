import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING } from '@formai/shared';
import {
  mergeExtractedPalette,
  selectPalette,
  type ExtractedPalette,
  type PaletteFields,
} from './palette-extract.js';

/** Builds an RGBA pixel buffer by repeating each `[r,g,b,a]` `times` over. */
function pixels(...runs: Array<{ rgba: [number, number, number, number]; times: number }>) {
  const out: number[] = [];
  for (const { rgba, times } of runs) {
    for (let i = 0; i < times; i += 1) out.push(...rgba);
  }
  return new Uint8ClampedArray(out);
}

const OPAQUE = 255;

describe('selectPalette', () => {
  it('yields three distinct hexes for a multi-colour image (AE5)', () => {
    const data = pixels(
      { rgba: [220, 30, 40, OPAQUE], times: 100 }, // red — dominant
      { rgba: [30, 80, 220, OPAQUE], times: 60 }, // blue
      { rgba: [240, 190, 20, OPAQUE], times: 30 }, // yellow
    );

    const result = selectPalette(data);
    expect(result).not.toBeNull();
    const { primary, secondary, accent } = result!;
    for (const hex of [primary, secondary, accent]) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(new Set([primary, secondary, accent]).size).toBe(3);

    // The dominant colour leads, and each pick tracks a different source hue.
    const channelOrder = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return [r! > b!, b! > r!, g! > b!].join(',');
    };
    expect(channelOrder(primary)).toBe(channelOrder('#dc1e28'));
  });

  it('returns null when there are no usable pixels', () => {
    expect(selectPalette(new Uint8ClampedArray(0))).toBeNull();
    // Fully transparent pixels carry no brand colour.
    expect(selectPalette(pixels({ rgba: [200, 10, 10, 0], times: 50 }))).toBeNull();
    // Barely-there alpha is noise from anti-aliased edges, not colour.
    expect(selectPalette(pixels({ rgba: [200, 10, 10, 3], times: 50 }))).toBeNull();
  });

  it('does not crash or return three identical colours for a monochrome image', () => {
    const mono = selectPalette(pixels({ rgba: [20, 20, 20, OPAQUE], times: 200 }));
    expect(mono).not.toBeNull();
    expect(new Set([mono!.primary, mono!.secondary, mono!.accent]).size).toBe(3);

    // Pure white is the other monochrome edge — deriving by lightening would
    // have nowhere to go, so the derived shades must move the other way.
    const white = selectPalette(pixels({ rgba: [255, 255, 255, OPAQUE], times: 200 }));
    expect(white).not.toBeNull();
    expect(new Set([white!.primary, white!.secondary, white!.accent]).size).toBe(3);
    for (const hex of [white!.primary, white!.secondary, white!.accent]) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('mergeExtractedPalette', () => {
  const defaults: PaletteFields = {
    primaryColor: DEFAULT_BRANDING.primaryColor,
    secondaryColor: DEFAULT_BRANDING.secondaryColor,
    accentColor: DEFAULT_BRANDING.accentColor,
  };
  const extracted: ExtractedPalette = {
    primary: '#dc1e28',
    secondary: '#1e50dc',
    accent: '#f0be14',
  };

  it('pre-fills every field still at its default', () => {
    expect(mergeExtractedPalette(defaults, extracted, defaults)).toEqual({
      primaryColor: '#dc1e28',
      secondaryColor: '#1e50dc',
      accentColor: '#f0be14',
    });
  });

  it('leaves the palette untouched when extraction failed', () => {
    expect(mergeExtractedPalette(defaults, null, defaults)).toEqual({});
    expect(mergeExtractedPalette(defaults, undefined, defaults)).toEqual({});
  });

  it('never clobbers a manually edited colour on re-upload', () => {
    const current: PaletteFields = {
      primaryColor: '#123456', // hand-picked
      secondaryColor: DEFAULT_BRANDING.secondaryColor,
      accentColor: '#abcdef', // hand-picked
    };
    expect(mergeExtractedPalette(current, extracted, defaults)).toEqual({
      secondaryColor: '#1e50dc',
    });
  });

  it('treats a default written in different case as still default', () => {
    const current: PaletteFields = {
      ...defaults,
      primaryColor: DEFAULT_BRANDING.primaryColor.toUpperCase(),
    };
    expect(mergeExtractedPalette(current, extracted, defaults).primaryColor).toBe('#dc1e28');
  });
});
