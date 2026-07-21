import type { ThemeTokens } from '@formai/shared';
import { applyPreset, resolveTheme, THEME_PRESETS } from '@formai/shared';

interface ThemePresetGalleryProps {
  theme: ThemeTokens;
  onChange: (next: ThemeTokens) => void;
  disabled?: boolean;
}

/**
 * The landing view of the editor: pick a look, keep your colours.
 *
 * Each card renders in the org's *own* palette rather than the preset's,
 * because presets carry no colour at all — that is what makes every option
 * on-brand by default and why choosing one can never undo a palette the owner
 * spent time on.
 */
export function ThemePresetGallery({ theme, onChange, disabled }: ThemePresetGalleryProps) {
  const resolved = resolveTheme(theme);

  /** A preset is "current" when every value it sets already matches. */
  const isActive = (tokens: Record<string, unknown>) =>
    Object.entries(tokens).every(
      ([key, value]) => resolved[key as keyof typeof resolved] === value,
    );

  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      {THEME_PRESETS.map((preset) => {
        const active = isActive(preset.tokens as Record<string, unknown>);
        const radius = preset.tokens.radius ?? resolved.radius;
        const buttonRadius = { rounded: 6, pill: 999, square: 0 }[
          preset.tokens.buttonShape ?? resolved.buttonShape
        ];
        const outline = (preset.tokens.buttonStyle ?? resolved.buttonStyle) === 'outline';

        return (
          <button
            key={preset.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(applyPreset(theme, preset))}
            aria-pressed={active}
            title={preset.description}
            className={`flex flex-col gap-1.5 border p-2.5 text-left ${
              active ? 'border-accent bg-surface-sunken' : 'border-border bg-surface-card'
            }`}
            style={{ borderRadius: 10 }}
          >
            {/* Miniature of the form card, in the org's own colours. */}
            <div
              className="flex h-[52px] flex-col justify-between p-1.5"
              style={{
                borderRadius: radius,
                border: `${preset.tokens.borderWidth ?? resolved.borderWidth}px solid var(--org-secondary, #d9dede)`,
                background: '#ffffff',
              }}
            >
              <div>
                <div className="h-1.5 w-3/5 rounded-sm" style={{ background: 'var(--org-primary)' }} />
                <div className="mt-1 h-1 w-2/5 rounded-sm bg-[#e5e7eb]" />
              </div>
              <div
                className="h-3 w-3/5"
                style={{
                  borderRadius: buttonRadius,
                  background: outline ? 'transparent' : 'var(--org-accent)',
                  border: outline ? '1px solid var(--org-accent)' : 'none',
                }}
              />
            </div>
            <span className="text-[12px] font-semibold">{preset.name}</span>
          </button>
        );
      })}
    </div>
  );
}
