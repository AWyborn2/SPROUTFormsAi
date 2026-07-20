import { describe, expect, it } from 'vitest';
import type { BrandingKit } from '@formai/shared';
import { DEFAULT_BRANDING } from '@formai/shared';
import { FONT_STACK, orgBrandVars } from './branding.js';

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

describe('orgBrandVars', () => {
  it('maps a brand kit onto the --org-* variables', () => {
    const v = vars(KIT);
    expect(v['--org-primary']).toBe('#112233');
    expect(v['--org-accent']).toBe('#6ec792');
    expect(v['--org-font']).toBe(FONT_STACK.Sora);
  });

  it('picks readable accent text: dark ink on light accents, white on dark', () => {
    expect(vars(KIT)['--org-accent-text']).toBe('#12321f'); // light green accent
    expect(vars({ ...KIT, accentColor: '#253439' })['--org-accent-text']).toBe('#ffffff');
  });

  it('falls back to the FormAI defaults for null/undefined branding', () => {
    for (const branding of [null, undefined]) {
      const v = vars(branding);
      expect(v['--org-primary']).toBe(DEFAULT_BRANDING.primaryColor);
      expect(v['--org-accent']).toBe(DEFAULT_BRANDING.accentColor);
      expect(v['--org-font']).toBe(FONT_STACK[DEFAULT_BRANDING.formFont]);
    }
  });

  it('falls back to Inter for an unrecognised font from the network', () => {
    const kit = { ...KIT, formFont: 'Comic Sans' as BrandingKit['formFont'] };
    expect(vars(kit)['--org-font']).toBe(FONT_STACK.Inter);
  });
});
