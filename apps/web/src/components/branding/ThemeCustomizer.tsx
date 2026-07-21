import { useState } from 'react';
import { Icon } from '@formai/ui';
import type { ThemeTokens } from '@formai/shared';
import { resolveTheme } from '@formai/shared';
import {
  EDITOR_SECTIONS,
  guidanceFor,
  type PreviewRegion,
} from '../../lib/theme-editor.js';
import { ThemeColorField } from './ThemeColorField.js';

/** How each theme key is edited. Kept beside the renderer that consumes it. */
const CONTROL_KIND: Record<string, { kind: 'color' | 'number' | 'select'; options?: (string | number)[]; min?: number; max?: number }> = {
  pageBackground: { kind: 'color' },
  formBackground: { kind: 'color' },
  headingColor: { kind: 'color' },
  bodyColor: { kind: 'color' },
  labelColor: { kind: 'color' },
  borderColor: { kind: 'color' },

  headingSize: { kind: 'number', min: 12, max: 48 },
  bodySize: { kind: 'number', min: 10, max: 24 },
  labelSize: { kind: 'number', min: 10, max: 24 },
  buttonSize: { kind: 'number', min: 10, max: 24 },
  radius: { kind: 'number', min: 0, max: 40 },
  borderWidth: { kind: 'number', min: 0, max: 6 },

  headingWeight: { kind: 'select', options: [400, 500, 600, 700] },
  bodyWeight: { kind: 'select', options: [400, 500, 600, 700] },
  labelWeight: { kind: 'select', options: [400, 500, 600, 700] },
  buttonWeight: { kind: 'select', options: [400, 500, 600, 700] },
  buttonShape: { kind: 'select', options: ['rounded', 'pill', 'square'] },
  buttonStyle: { kind: 'select', options: ['solid', 'outline', 'soft'] },
  shadow: { kind: 'select', options: ['none', 'sm', 'md', 'lg'] },
  density: { kind: 'select', options: ['compact', 'comfortable', 'spacious'] },
  logoSize: { kind: 'select', options: ['small', 'medium', 'large'] },
  logoPlacement: { kind: 'select', options: ['left', 'center'] },
  layout: { kind: 'select', options: ['card', 'hero', 'split', 'conversational'] },
};

/** Turn `headingSize` into `Heading size` rather than maintaining a second label map. */
function humanize(key: string): string {
  const spaced = key.replace(/([A-Z])/g, ' $1').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

interface ThemeCustomizerProps {
  theme: ThemeTokens;
  onChange: (patch: ThemeTokens) => void;
  onHighlight: (region: PreviewRegion | null) => void;
  disabled?: boolean;
}

/**
 * The "Customize" half of the editor: every fine control, grouped into
 * collapsible sections, each carrying an "applies to" chip.
 *
 * The chips are the feature, not decoration — the gap this work addresses is
 * that branding offered no indication of which surface a given selection
 * affects. Focusing a control also highlights the matching preview region.
 */
export function ThemeCustomizer({ theme, onChange, onHighlight, disabled }: ThemeCustomizerProps) {
  const [openSection, setOpenSection] = useState<string | null>('colors');
  const resolved = resolveTheme(theme);

  return (
    <div className="flex flex-col gap-2">
      {EDITOR_SECTIONS.map((section) => {
        const open = openSection === section.id;
        return (
          <div key={section.id} className="rounded-md border border-border">
            <button
              type="button"
              onClick={() => setOpenSection(open ? null : section.id)}
              aria-expanded={open}
              className="flex w-full items-center justify-between px-3.5 py-2.5 text-left"
            >
              <span className="text-[13px] font-semibold">{section.title}</span>
              <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} className="text-text-tertiary" />
            </button>

            {open && (
              <div className="flex flex-col gap-3 border-t border-border-subtle px-3.5 py-3">
                {section.keys.map((key) => {
                  const spec = CONTROL_KIND[key];
                  const guidance = guidanceFor(key);
                  if (!spec) return null;
                  const value = resolved[key];

                  return (
                    <div
                      key={key}
                      onFocus={() => onHighlight(guidance?.region ?? null)}
                      onBlur={() => onHighlight(null)}
                      onMouseEnter={() => onHighlight(guidance?.region ?? null)}
                      onMouseLeave={() => onHighlight(null)}
                    >
                      <div className="mb-1 flex items-center gap-2">
                        <label className="text-xs font-semibold text-text-primary">
                          {humanize(key)}
                        </label>
                        {guidance && (
                          <span className="rounded-full border border-border-subtle bg-surface-sunken px-2 py-0.5 text-[10.5px] text-text-tertiary">
                            {guidance.appliesTo}
                          </span>
                        )}
                      </div>

                      {spec.kind === 'color' && (
                        <ThemeColorField
                          value={String(value)}
                          disabled={disabled}
                          onChange={(hex) => onChange({ [key]: hex } as ThemeTokens)}
                        />
                      )}

                      {spec.kind === 'number' && (
                        <div className="flex items-center gap-2">
                          <input
                            type="range"
                            min={spec.min}
                            max={spec.max}
                            value={Number(value)}
                            disabled={disabled}
                            onChange={(e) =>
                              onChange({ [key]: Number(e.target.value) } as ThemeTokens)
                            }
                            className="flex-1"
                          />
                          <span className="w-10 text-right font-mono text-[11px] text-text-secondary">
                            {String(value)}
                          </span>
                        </div>
                      )}

                      {spec.kind === 'select' && (
                        <select
                          value={String(value)}
                          disabled={disabled}
                          onChange={(e) => {
                            const raw = e.target.value;
                            const next = spec.options?.every((o) => typeof o === 'number')
                              ? Number(raw)
                              : raw;
                            onChange({ [key]: next } as ThemeTokens);
                          }}
                          className="w-full rounded-md border border-border bg-surface-card px-2.5 py-1.5 text-[13px]"
                        >
                          {spec.options?.map((opt) => (
                            <option key={String(opt)} value={String(opt)}>
                              {String(opt)}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
