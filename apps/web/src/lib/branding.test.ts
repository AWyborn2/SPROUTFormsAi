import { describe, expect, it } from 'vitest';
import type { BrandingKit, ThemeTokens } from '@formai/shared';
import { DEFAULT_BRANDING } from '@formai/shared';
import { fontStack, orgBrandVars } from './branding.js';

const KIT: BrandingKit = {
  logoAssetUrl: null,
  primaryColor: '#112233',
  secondaryColor: '#445566',
  accentColor: '#6ec792',
  formFont: 'Sora',
};

function vars(branding?: BrandingKit | null): Record<string, string> {
  return orgBrandVars(branding) as Record<string, string>;
}

describe('fontStack', () => {
  it('quotes the family and appends the generic fallback for its category', () => {
    expect(fontStack('Lora')).toMatch(/^"Lora", /);
    expect(fontStack('Lora')).toMatch(/serif$/);
    expect(fontStack('Inter')).toMatch(/sans-serif$/);
    expect(fontStack('JetBrains Mono')).toMatch(/monospace$/);
    expect(fontStack('Spectral')).toMatch(/^"Spectral", /);
  });

  it('falls back to the Inter stack for an unrecognised family', () => {
    expect(fontStack('Comic Sans')).toBe(fontStack('Inter'));
  });
});

describe('orgBrandVars', () => {
  it('maps a brand kit onto the --org-* variables', () => {
    const v = vars(KIT);
    expect(v['--org-primary']).toBe('#112233');
    expect(v['--org-accent']).toBe('#6ec792');
    expect(v['--org-font']).toBe(fontStack('Sora'));
  });

  it('builds a stack for any catalog family, not just the four presets', () => {
    expect(vars({ ...KIT, formFont: 'Lora' })['--org-font']).toBe(fontStack('Lora'));
    expect(vars({ ...KIT, formFont: 'Playfair Display' })['--org-font']).toBe(
      fontStack('Playfair Display'),
    );
  });

  it('picks readable accent text: dark ink on light accents, white on dark', () => {
    expect(vars(KIT)['--org-accent-text']).toBe('#12321f'); // light green accent
    expect(vars({ ...KIT, accentColor: '#253439' })['--org-accent-text']).toBe('#ffffff');
  });

  /**
   * Covers AE6. The primary colour carries text too — the fill mastheads and
   * the chrome sit white-on-primary — so it needs the same contrast
   * resolution the accent already had, or a light brand primary renders its
   * masthead text invisible.
   */
  it('picks readable primary text: dark ink on light primaries, white on dark', () => {
    expect(vars(KIT)['--org-primary-text']).toBe('#ffffff'); // dark navy primary
    expect(vars({ ...KIT, primaryColor: '#e8f5ec' })['--org-primary-text']).toBe('#12321f');
    expect(vars({ ...KIT, primaryColor: '#ffffff' })['--org-primary-text']).toBe('#12321f');
  });

  it('resolves accent and primary text independently of each other', () => {
    const v = vars({ ...KIT, primaryColor: '#f4f6f5', accentColor: '#102015' });
    expect(v['--org-primary-text']).toBe('#12321f');
    expect(v['--org-accent-text']).toBe('#ffffff');
  });

  it('falls back to the FormAI defaults for null/undefined branding', () => {
    for (const branding of [null, undefined]) {
      const v = vars(branding);
      expect(v['--org-primary']).toBe(DEFAULT_BRANDING.primaryColor);
      expect(v['--org-accent']).toBe(DEFAULT_BRANDING.accentColor);
      expect(v['--org-font']).toBe(fontStack(DEFAULT_BRANDING.formFont));
      expect(v['--org-primary-text']).toBe('#ffffff'); // default primary is dark
      expect(v['--org-accent-text']).toBe('#12321f'); // default accent is light
    }
  });

  /**
   * The shell applies these at its root for every org, branded or not — a
   * missing or `undefined` entry would emit a broken inline style rather than
   * degrade to the product default.
   */
  it('emits every --org-* variable with a usable value for null branding', () => {
    const v = vars(null);
    for (const key of [
      '--org-primary',
      '--org-primary-text',
      '--org-accent',
      '--org-accent-text',
      '--org-font',
    ]) {
      expect(v[key], key).toBeTypeOf('string');
      expect(v[key], key).not.toBe('');
      expect(v[key], key).not.toMatch(/undefined|null|NaN/);
    }
  });

  it('falls back to Inter for an unrecognised font from the network', () => {
    const kit = { ...KIT, formFont: 'Comic Sans' };
    expect(vars(kit)['--org-font']).toBe(fontStack('Inter'));
  });
});

describe('orgBrandVars — secondary colour', () => {
  /**
   * Covers AE8. `secondaryColor` has been stored and editable since the kit
   * shipped but was never emitted, so the control changed nothing anywhere.
   */
  it('emits the secondary colour and a readable ink for it', () => {
    const v = vars(KIT);
    expect(v['--org-secondary']).toBe('#445566');
    expect(v['--org-secondary-text']).toBe('#ffffff'); // dark slate
    expect(vars({ ...KIT, secondaryColor: '#eef2f0' })['--org-secondary-text']).toBe('#12321f');
  });
});

describe('orgBrandVars — theme tokens', () => {
  function themed(theme: ThemeTokens): Record<string, string> {
    return orgBrandVars(KIT, theme) as Record<string, string>;
  }

  it('emits typography, surface, button and spacing tokens from the defaults', () => {
    const v = vars(KIT);
    expect(v['--org-heading-size']).toBe('21px');
    expect(v['--org-heading-weight']).toBe('700');
    expect(v['--org-button-size']).toBe('15px');
    expect(v['--org-radius']).toBe('14px');
    expect(v['--org-border-width']).toBe('1px');
    expect(v['--org-gap']).toBe('24px');
    expect(v['--org-pad']).toBe('26px');
    expect(v['--org-button-radius']).toBe('6px');
    expect(v['--org-logo-size']).toBe('40px');
  });

  it('scales spacing with density', () => {
    expect(themed({ density: 'compact' })['--org-gap']).toBe('14px');
    expect(themed({ density: 'spacious' })['--org-gap']).toBe('34px');
  });

  it('maps button shape onto a radius', () => {
    expect(themed({ buttonShape: 'pill' })['--org-button-radius']).toBe('999px');
    expect(themed({ buttonShape: 'square' })['--org-button-radius']).toBe('0px');
  });

  it('maps shadow onto the product shadow tokens', () => {
    expect(themed({ shadow: 'none' })['--org-shadow']).toBe('none');
    expect(themed({ shadow: 'sm' })['--org-shadow']).toBe('var(--shadow-sm)');
  });

  /**
   * The roles below are served by the product's own tokens when the theme does
   * not set them. Emitting an empty custom property would blank them out, so
   * they must be absent rather than empty — this is what keeps an untouched
   * org rendering byte-identically (AE3).
   */
  it('omits unset colour roles instead of emitting them empty', () => {
    const v = vars(KIT);
    for (const key of [
      '--org-page-bg',
      '--org-heading-color',
      '--org-body-color',
      '--org-label-color',
      '--org-border-color',
    ]) {
      expect(v[key], key).toBeUndefined();
    }
  });

  it('emits a colour role once the theme sets it', () => {
    const v = themed({ pageBackground: '#101010', headingColor: '#abcdef' });
    expect(v['--org-page-bg']).toBe('#101010');
    expect(v['--org-heading-color']).toBe('#abcdef');
  });

  it('never emits an empty, undefined or NaN value', () => {
    for (const theme of [undefined, {}, { density: 'spacious' } as ThemeTokens]) {
      const v = orgBrandVars(null, theme) as Record<string, string>;
      for (const [key, value] of Object.entries(v)) {
        expect(value, key).toBeTypeOf('string');
        expect(value, key).not.toBe('');
        expect(value, key).not.toMatch(/undefined|null|NaN/);
      }
    }
  });

  it('falls back to sane values for an out-of-range theme from the network', () => {
    const rogue = { density: 'huge', shadow: 'glow', buttonShape: 'blob' } as unknown as ThemeTokens;
    const v = themed(rogue);
    expect(v['--org-gap']).toBe('24px');
    expect(v['--org-shadow']).toBe('var(--shadow-lg)');
    expect(v['--org-button-radius']).toBe('6px');
  });
});
