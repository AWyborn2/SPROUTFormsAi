import type { BrandingKit } from '@formai/shared';

type ColorKey = 'primaryColor' | 'secondaryColor' | 'accentColor';

interface ColorRow {
  key: ColorKey;
  label: string;
  presets: string[];
}

const COLOR_ROWS: ColorRow[] = [
  {
    key: 'primaryColor',
    label: 'Primary',
    presets: ['#253439', '#181b19', '#1f3a5f', '#3d2f4f', '#0f3d3e'],
  },
  {
    key: 'secondaryColor',
    label: 'Secondary',
    presets: ['#7c898b', '#5e6a6c', '#9aa4a4', '#45504f', '#c1c8c8'],
  },
  {
    key: 'accentColor',
    label: 'Accent',
    presets: ['#6ec792', '#4f9cf9', '#e0a44f', '#f3685f', '#8b7cf6'],
  },
];

/** Parse a hex or rgb() string to #rrggbb, or null if unrecognised. */
export function parseColor(input: string): string | null {
  const s = input.trim();
  let m = s.match(/^#?([0-9a-f]{3})$/i);
  if (m && m[1]) {
    const c = m[1];
    return `#${c[0]}${c[0]}${c[1]}${c[1]}${c[2]}${c[2]}`;
  }
  m = s.match(/^#?([0-9a-f]{6})$/i);
  if (m && m[1]) return `#${m[1].toLowerCase()}`;
  m = s.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/i);
  if (m) {
    const to2 = (n: string) =>
      Math.max(0, Math.min(255, parseInt(n, 10)))
        .toString(16)
        .padStart(2, '0');
    return `#${to2(m[1]!)}${to2(m[2]!)}${to2(m[3]!)}`;
  }
  return null;
}

/**
 * The three brand colours with presets plus a free colour picker each.
 *
 * Shared by the onboarding wizard and the branding settings screen — the
 * settings screen used to expose only primary and accent from a fixed preset
 * strip, so a secondary colour or a custom hex chosen in the wizard could
 * never be edited again afterwards (R10).
 */
export function BrandColorFields({
  branding,
  onChange,
}: {
  branding: BrandingKit;
  onChange: (patch: Partial<BrandingKit>) => void;
}) {
  return (
    <div className="flex flex-col gap-[13px]">
      {COLOR_ROWS.map((row) => (
        <ColorRowControl
          key={row.key}
          row={row}
          value={branding[row.key]}
          onPick={(hex) => onChange({ [row.key]: hex } as Partial<BrandingKit>)}
        />
      ))}
    </div>
  );
}

function ColorRowControl({
  row,
  value,
  onPick,
}: {
  row: ColorRow;
  value: string;
  onPick: (hex: string) => void;
}) {
  return (
    <div>
      <div className="mb-[7px] flex justify-between">
        <span className="text-[12.5px] text-text-secondary">{row.label}</span>
        <span className="font-mono text-[11.5px] text-text-tertiary">{value}</span>
      </div>
      <div className="flex gap-[7px]">
        {row.presets.map((hex) => (
          <button
            key={hex}
            onClick={() => onPick(hex)}
            aria-label={`${row.label} ${hex}`}
            aria-pressed={value.toLowerCase() === hex.toLowerCase()}
            className="h-[30px] w-[38px] rounded-lg shadow-xs"
            style={{
              background: hex,
              border: `2px solid ${value.toLowerCase() === hex.toLowerCase() ? '#181b19' : 'transparent'}`,
            }}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-[7px]">
        <input
          type="color"
          value={value}
          onChange={(e) => onPick(e.target.value)}
          aria-label={`Pick a custom ${row.label.toLowerCase()} colour`}
          className="h-[30px] w-[34px] flex-none cursor-pointer rounded-md border border-border bg-surface-card p-0.5"
        />
        <input
          defaultValue={value}
          key={value}
          onBlur={(e) => {
            const parsed = parseColor(e.target.value);
            if (parsed) onPick(parsed);
          }}
          placeholder="#RRGGBB or rgb(0,0,0)"
          className="h-[30px] min-w-0 flex-1 rounded-md border border-border bg-surface-sunken px-[9px] font-mono text-xs text-text-primary"
        />
      </div>
    </div>
  );
}
