/**
 * Pure helpers for the theme editor: the "applies to" guidance each control
 * carries, the preview region it highlights, and HEX/RGB text conversion.
 *
 * Kept out of the components because `apps/web` vitest runs in a node
 * environment with no jsdom, so anything rendered is untestable here. The
 * guidance mapping in particular is the answer to "no true guidance of what
 * branding selections get applied to what areas", so it earns real coverage.
 */
import type { ThemeTokens } from '@formai/shared';

/** Regions of the preview a control can highlight. */
export type PreviewRegion = 'masthead' | 'body' | 'fields' | 'button' | 'page' | 'logo';

export interface ControlGuidance {
  /** Short chip text: where this setting shows up. */
  appliesTo: string;
  /** Which preview region lights up while the control has focus. */
  region: PreviewRegion;
}

/**
 * Every themeable control, mapped to plain-language guidance. Keys cover both
 * the brand kit (primary/secondary/accent/font/logo) and the theme tokens,
 * because from the owner's point of view they are one editor.
 */
export const CONTROL_GUIDANCE: Record<string, ControlGuidance> = {
  // Brand kit
  primaryColor: { appliesTo: 'Form header background', region: 'masthead' },
  secondaryColor: { appliesTo: 'Supporting text and dividers', region: 'body' },
  accentColor: { appliesTo: 'Buttons and links', region: 'button' },
  formFont: { appliesTo: 'All text on the form', region: 'body' },
  logoAssetUrl: { appliesTo: 'Form header', region: 'logo' },

  // Theme — colour roles
  pageBackground: { appliesTo: 'Page behind the form', region: 'page' },
  formBackground: { appliesTo: 'The form card itself', region: 'body' },
  headingColor: { appliesTo: 'Section headings', region: 'body' },
  bodyColor: { appliesTo: 'Answer text', region: 'fields' },
  labelColor: { appliesTo: 'Question labels', region: 'fields' },

  // Theme — typography
  headingSize: { appliesTo: 'Form title and section headings', region: 'masthead' },
  headingWeight: { appliesTo: 'Form title and section headings', region: 'masthead' },
  bodySize: { appliesTo: 'Answer text', region: 'fields' },
  bodyWeight: { appliesTo: 'Answer text', region: 'fields' },
  labelSize: { appliesTo: 'Question labels', region: 'fields' },
  labelWeight: { appliesTo: 'Question labels', region: 'fields' },
  buttonSize: { appliesTo: 'Submit button text', region: 'button' },
  buttonWeight: { appliesTo: 'Submit button text', region: 'button' },

  // Theme — shape and surface
  buttonShape: { appliesTo: 'Submit button corners', region: 'button' },
  buttonStyle: { appliesTo: 'Submit button fill', region: 'button' },
  radius: { appliesTo: 'Form card corners', region: 'body' },
  borderWidth: { appliesTo: 'Form card border', region: 'body' },
  borderColor: { appliesTo: 'Form card border', region: 'body' },
  shadow: { appliesTo: 'Form card shadow', region: 'body' },
  density: { appliesTo: 'Spacing between questions', region: 'fields' },

  // Theme — logo and layout
  logoSize: { appliesTo: 'Logo in the form header', region: 'logo' },
  logoPlacement: { appliesTo: 'Logo in the form header', region: 'logo' },
  layout: { appliesTo: 'The whole form arrangement', region: 'page' },
};

export function guidanceFor(key: string): ControlGuidance | undefined {
  return CONTROL_GUIDANCE[key];
}

/** Colour text-entry modes offered next to the picker. */
export const COLOR_FORMATS = ['hex', 'rgb'] as const;
export type ColorFormat = (typeof COLOR_FORMATS)[number];

function clampChannel(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** `#aabbcc` -> `{ r, g, b }`. Returns null for anything unparseable. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const hex = (n: number) => clampChannel(n).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * Render a stored hex in the requested text format. Storage is always hex —
 * RGB is a display and entry convenience only, so switching formats never
 * changes the persisted value.
 */
export function formatColor(hex: string, format: ColorFormat): string {
  if (format === 'hex') return hex;
  const rgb = hexToRgb(hex);
  return rgb ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` : hex;
}

/**
 * Parse typed colour text in either format back to hex. Accepts `#abc`,
 * `#aabbcc`, bare `aabbcc`, and `rgb(r, g, b)` with or without the wrapper, so
 * a pasted value from a brand guide usually just works. Returns null when the
 * text is not a colour yet — callers keep the previous value rather than
 * writing a broken one mid-typing.
 */
export function parseColorInput(text: string): string | null {
  const raw = text.trim();
  if (!raw) return null;

  const short = /^#?([0-9a-f]{3})$/i.exec(raw);
  if (short) {
    const [r, g, b] = short[1]!.split('') as [string, string, string];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }

  const long = /^#?([0-9a-f]{6})$/i.exec(raw);
  if (long) return `#${long[1]!.toLowerCase()}`;

  const rgb = /^(?:rgb\s*\(\s*)?(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*\)?$/i.exec(raw);
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map((n) => Number(n)) as [number, number, number];
    if ([r, g, b].some((n) => n > 255)) return null;
    return rgbToHex(r, g, b);
  }

  return null;
}

/**
 * Which theme keys a given editor section owns. Drives both the section
 * rendering and the "this section changed something" affordance.
 */
export const EDITOR_SECTIONS: { id: string; title: string; keys: (keyof ThemeTokens)[] }[] = [
  {
    id: 'colors',
    title: 'Colours',
    keys: ['pageBackground', 'formBackground', 'headingColor', 'bodyColor', 'labelColor'],
  },
  {
    id: 'typography',
    title: 'Typography',
    keys: [
      'headingSize',
      'headingWeight',
      'bodySize',
      'bodyWeight',
      'labelSize',
      'labelWeight',
      'buttonSize',
      'buttonWeight',
    ],
  },
  { id: 'buttons', title: 'Buttons & inputs', keys: ['buttonShape', 'buttonStyle'] },
  {
    id: 'surface',
    title: 'Borders & shading',
    keys: ['radius', 'borderWidth', 'borderColor', 'shadow'],
  },
  { id: 'logo', title: 'Logo', keys: ['logoSize', 'logoPlacement'] },
  { id: 'layout', title: 'Layout & density', keys: ['layout', 'density'] },
];
