import { useEffect, useState } from 'react';
import {
  COLOR_FORMATS,
  formatColor,
  parseColorInput,
  type ColorFormat,
} from '../../lib/theme-editor.js';

interface ThemeColorFieldProps {
  /** Stored value: a hex string, or `''` meaning "keep the product default". */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

/**
 * A single theme colour role: swatch picker, text entry, and a HEX/RGB toggle.
 *
 * Storage is always hex — RGB is an entry and display convenience only, so
 * switching formats never rewrites what is persisted. Text that is not yet a
 * colour leaves the stored value alone rather than writing a broken one on
 * every keystroke, which is why typing "#1" mid-entry does not blank the form.
 *
 * The empty value is first-class: these roles fall back to the product's own
 * design tokens when unset, so "Default" is a real choice rather than a blank.
 */
export function ThemeColorField({ value, onChange, disabled }: ThemeColorFieldProps) {
  const [format, setFormat] = useState<ColorFormat>('hex');
  const [text, setText] = useState(() => formatColor(value, 'hex'));

  // Re-sync when the value changes elsewhere (a preset applied, a scan result)
  // or when the display format switches.
  useEffect(() => {
    setText(value ? formatColor(value, format) : '');
  }, [value, format]);

  const isDefault = value === '';

  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        aria-label="Colour picker"
        value={value || '#ffffff'}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-9 flex-none cursor-pointer rounded border border-border bg-surface-card p-0.5"
      />
      <input
        type="text"
        value={text}
        disabled={disabled}
        placeholder={isDefault ? 'Default' : undefined}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = parseColorInput(e.target.value);
          if (parsed) onChange(parsed);
        }}
        className="min-w-0 flex-1 rounded-md border border-border bg-surface-sunken px-2.5 py-1.5 font-mono text-[12px]"
      />
      <div className="flex flex-none gap-0.5" role="group" aria-label="Colour format">
        {COLOR_FORMATS.map((f) => (
          <button
            key={f}
            type="button"
            disabled={disabled}
            onClick={() => setFormat(f)}
            aria-pressed={format === f}
            className={`rounded px-1.5 py-1 text-[10.5px] font-semibold uppercase ${
              format === f ? 'bg-surface-sunken text-text-primary' : 'text-text-tertiary'
            }`}
          >
            {f}
          </button>
        ))}
      </div>
      {!isDefault && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange('')}
          title="Reset to the product default"
          className="flex-none rounded px-1.5 py-1 text-[10.5px] font-semibold text-text-tertiary"
        >
          Reset
        </button>
      )}
    </div>
  );
}
