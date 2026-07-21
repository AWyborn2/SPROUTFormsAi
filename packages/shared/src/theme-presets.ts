/**
 * Named style presets — the "presets first" half of the theme editor.
 *
 * A preset is a `ThemeTokens` patch that **omits every colour-role key**. That
 * omission is the whole design: applying a preset cannot touch the org's
 * palette because the preset does not contain one. R7 ("presets inherit the
 * org's brand colours") is therefore true by construction rather than by a
 * filter someone could forget to apply.
 *
 * Presets are data, so adding one is an entry in this array with no code
 * change anywhere.
 */
import type { ThemeTokens } from './theme.js';

/**
 * The subset of a theme a preset is allowed to set: shape, typography,
 * spacing, shading. Colour roles are excluded at the type level, so a preset
 * that tried to carry `headingColor` would not compile.
 */
export type PresetTokens = Omit<
  ThemeTokens,
  | 'pageBackground'
  | 'formBackground'
  | 'headingColor'
  | 'bodyColor'
  | 'labelColor'
  | 'borderColor'
  | 'layout'
>;

export interface ThemePreset {
  id: string;
  name: string;
  /** One line for the gallery card, describing the feel rather than the values. */
  description: string;
  tokens: PresetTokens;
}

export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: 'soft',
    name: 'Soft',
    description: 'Rounded corners, generous spacing, gentle shadow.',
    tokens: {
      headingSize: 22,
      headingWeight: 700,
      bodySize: 14,
      bodyWeight: 400,
      labelSize: 13,
      labelWeight: 600,
      buttonSize: 15,
      buttonWeight: 700,
      buttonShape: 'pill',
      buttonStyle: 'solid',
      radius: 18,
      borderWidth: 1,
      shadow: 'lg',
      density: 'spacious',
      logoSize: 'medium',
      logoPlacement: 'left',
    },
  },
  {
    id: 'sharp',
    name: 'Sharp',
    description: 'Square edges, tight spacing, no shadow.',
    tokens: {
      headingSize: 20,
      headingWeight: 600,
      bodySize: 14,
      bodyWeight: 400,
      labelSize: 12,
      labelWeight: 600,
      buttonSize: 14,
      buttonWeight: 600,
      buttonShape: 'square',
      buttonStyle: 'solid',
      radius: 0,
      borderWidth: 1,
      shadow: 'none',
      density: 'compact',
      logoSize: 'small',
      logoPlacement: 'left',
    },
  },
  {
    id: 'bold',
    name: 'Bold',
    description: 'Large headings, heavy weights, strong presence.',
    tokens: {
      headingSize: 28,
      headingWeight: 700,
      bodySize: 15,
      bodyWeight: 500,
      labelSize: 13,
      labelWeight: 700,
      buttonSize: 16,
      buttonWeight: 700,
      buttonShape: 'rounded',
      buttonStyle: 'solid',
      radius: 10,
      borderWidth: 2,
      shadow: 'md',
      density: 'comfortable',
      logoSize: 'large',
      logoPlacement: 'left',
    },
  },
  {
    id: 'classic',
    name: 'Classic',
    description: 'Restrained type, outlined buttons, centred mark.',
    tokens: {
      headingSize: 21,
      headingWeight: 600,
      bodySize: 14,
      bodyWeight: 400,
      labelSize: 13,
      labelWeight: 500,
      buttonSize: 15,
      buttonWeight: 600,
      buttonShape: 'rounded',
      buttonStyle: 'outline',
      radius: 6,
      borderWidth: 1,
      shadow: 'sm',
      density: 'comfortable',
      logoSize: 'medium',
      logoPlacement: 'center',
    },
  },
] as const;

export function findThemePreset(id: string): ThemePreset | undefined {
  return THEME_PRESETS.find((p) => p.id === id);
}

/**
 * Apply a preset over the current theme, keeping every colour role and the
 * layout choice. Returns a new object; the inputs are not mutated.
 *
 * Layout is preserved because it is a structural choice (which of the four
 * form layouts renders), not a style one — switching from Soft to Sharp should
 * not silently move a form off the split-panel layout its author chose.
 */
export function applyPreset(current: ThemeTokens, preset: ThemePreset): ThemeTokens {
  return { ...current, ...preset.tokens };
}
