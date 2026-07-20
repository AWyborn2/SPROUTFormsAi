import { Link, useNavigate } from 'react-router-dom';
import { Button, Icon, useToast } from '@formai/ui';
import type { BrandingKit, FormFont } from '@formai/shared';
import { BrandMark } from '../../components/BrandMark.js';
import { useUpdateOrg } from '../../lib/data/hooks.js';
import { useOnboarding } from '../../lib/onboarding.js';
import { Stepper } from './Stepper.js';

type ColorKey = 'primaryColor' | 'secondaryColor' | 'accentColor';

interface ColorRow {
  key: ColorKey;
  label: string;
  presets: string[];
}

const COLOR_ROWS: ColorRow[] = [
  { key: 'primaryColor', label: 'Primary', presets: ['#253439', '#181b19', '#1f3a5f', '#3d2f4f', '#0f3d3e'] },
  { key: 'secondaryColor', label: 'Secondary', presets: ['#7c898b', '#5e6a6c', '#9aa4a4', '#45504f', '#c1c8c8'] },
  { key: 'accentColor', label: 'Accent', presets: ['#6ec792', '#4f9cf9', '#e0a44f', '#f3685f', '#8b7cf6'] },
];

const FONT_OPTIONS: Array<{ name: FormFont; stack: string }> = [
  { name: 'Inter', stack: "'Inter',sans-serif" },
  { name: 'Sora', stack: "'Sora',sans-serif" },
  { name: 'Spectral', stack: "'Spectral',serif" },
];

/** Parse a hex or rgb() string to #rrggbb, or null if unrecognised. */
function parseColor(input: string): string | null {
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
      Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0');
    return `#${to2(m[1]!)}${to2(m[2]!)}${to2(m[3]!)}`;
  }
  return null;
}

/** Step 2 — the org branding kit, with a live preview of a real branded form. */
export function BrandingScreen() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { orgName, branding, hasLogo, setBranding, patch, brandStyle } = useOnboarding();
  const updateOrg = useUpdateOrg();

  const orgInitial = (orgName.trim()[0] ?? 'M').toUpperCase();

  /**
   * Persist the wizard's choices via `PATCH /org`, then enter the app. An
   * empty name is dropped so we never overwrite the auto-provisioned org
   * name with ''; on failure we stay on this step so the user can retry.
   */
  const finishSetup = () => {
    const name = orgName.trim();
    updateOrg.mutate(name ? { name, branding } : { branding }, {
      onSuccess: () => navigate('/app'),
      onError: () =>
        toast({
          variant: 'danger',
          message: 'Could not save your organisation settings — try again.',
        }),
    });
  };

  return (
    <div className="fai-fade flex min-h-screen flex-col items-center px-6 py-12">
      <div className="w-full max-w-[1000px]">
        <div className="mb-[30px] flex items-center gap-3">
          <BrandMark size={26} />
          <span className="font-heading text-lg font-bold tracking-tight">FormAI</span>
        </div>
        <Stepper active={1} />

        <div className="grid grid-cols-1 items-start gap-[26px] md:grid-cols-2">
          {/* Config */}
          <div className="rounded-xl border border-border bg-surface-card p-8 shadow-sm">
            <div className="mb-2.5 font-mono text-[11px] uppercase tracking-wide text-text-tertiary">
              Step 2 · Branding kit
            </div>
            <h3 className="mb-1.5 text-2xl">Make forms carry your brand</h3>
            <p className="mb-6 text-sm text-text-secondary">
              External forms — vendor onboarding, customer intake — go out under your identity,
              not ours.
            </p>

            {/* Logo */}
            <div className="mb-[9px] text-[13px] font-semibold">Logo</div>
            <button
              onClick={() => patch({ hasLogo: true })}
              className="fai-chip-btn mb-[22px] flex w-full items-center gap-[13px] rounded-md border-[1.5px] border-dashed border-border-strong bg-surface-sunken p-[14px] text-left"
            >
              <span
                className="grid h-11 w-11 flex-none place-items-center rounded-[10px] font-heading text-[17px] font-bold text-white"
                style={{ background: branding.primaryColor }}
              >
                {orgInitial}
              </span>
              <span className="flex-1">
                <span className="block font-ui text-[13.5px] font-semibold text-text-primary">
                  {hasLogo ? 'meridian-mark.svg' : 'Upload your logo'}
                </span>
                <span className="block text-xs text-text-tertiary">
                  SVG or PNG · transparent background
                </span>
              </span>
              <Icon name="upload" size={17} className="text-text-tertiary" />
            </button>

            {/* Colours */}
            <div className="mb-[11px] text-[13px] font-semibold">Brand colours</div>
            <div className="mb-[22px] flex flex-col gap-[13px]">
              {COLOR_ROWS.map((row) => (
                <ColorRowControl
                  key={row.key}
                  row={row}
                  value={branding[row.key]}
                  onPick={(hex) => setBranding({ [row.key]: hex } as Partial<BrandingKit>)}
                />
              ))}
            </div>

            {/* Font */}
            <div className="mb-[9px] text-[13px] font-semibold">Form font</div>
            <div className="flex gap-2">
              {FONT_OPTIONS.map((f) => {
                const selected = branding.formFont === f.name;
                return (
                  <button
                    key={f.name}
                    onClick={() => setBranding({ formFont: f.name })}
                    className="fai-chip-btn flex-1 rounded-md border-[1.5px] px-2 py-[11px] text-center"
                    style={{
                      borderColor: selected ? 'var(--border-accent)' : 'var(--border-default)',
                      background: selected ? 'var(--surface-accent-soft)' : 'var(--surface-card)',
                    }}
                  >
                    <span
                      className="block text-[17px] font-semibold text-text-primary"
                      style={{ fontFamily: f.stack }}
                    >
                      Ag
                    </span>
                    <span className="mt-[3px] block text-[11px] text-text-tertiary">{f.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Live preview */}
          <div className="sticky top-4">
            <div className="mb-[11px] flex items-center gap-2">
              <Icon name="eye" size={15} className="text-accent" />
              <span className="font-mono text-[11px] uppercase tracking-wide text-text-tertiary">
                Live preview · vendor onboarding
              </span>
            </div>
            <div
              className="overflow-hidden rounded-lg border border-border shadow-md"
              style={brandStyle()}
            >
              <div
                className="flex h-[88px] items-center gap-3 px-[26px]"
                style={{ background: 'var(--org-primary)' }}
              >
                <span className="grid h-10 w-10 place-items-center rounded-[9px] bg-white/[0.14] font-heading text-[17px] font-bold text-white">
                  {orgInitial}
                </span>
                <div>
                  <div
                    className="text-[17px] font-bold text-white"
                    style={{ fontFamily: 'var(--org-font)' }}
                  >
                    {orgName}
                  </div>
                  <div className="text-[11.5px] text-white/60">Vendor onboarding</div>
                </div>
              </div>
              <div className="bg-white px-[26px] py-6" style={{ fontFamily: 'var(--org-font)' }}>
                <div
                  className="mb-1 text-lg font-bold text-[#1a2224]"
                  style={{ fontFamily: 'var(--org-font)' }}
                >
                  Supplier details
                </div>
                <div className="mb-[18px] text-[12.5px] text-[#6b7677]">
                  Fields marked * are required.
                </div>
                <div className="mb-[14px]">
                  <div className="mb-[5px] text-xs font-semibold text-[#33403f]">
                    Legal entity name *
                  </div>
                  <div className="h-[38px] rounded-lg border border-[#d9dede] bg-[#fbfcfc]" />
                </div>
                <div className="mb-[18px]">
                  <div className="mb-[5px] text-xs font-semibold text-[#33403f]">
                    Business category *
                  </div>
                  <div className="flex h-[38px] items-center justify-end rounded-lg border border-[#d9dede] bg-[#fbfcfc] px-3">
                    <Icon name="chevron-down" size={15} color="#9aa4a4" />
                  </div>
                </div>
                <div className="flex justify-end">
                  <div
                    className="rounded-lg px-5 py-2.5 text-[13.5px] font-bold"
                    style={{
                      background: 'var(--org-accent)',
                      color: 'var(--org-accent-text)',
                      fontFamily: 'var(--org-font)',
                    }}
                  >
                    Submit application
                  </div>
                </div>
              </div>
            </div>
            <p className="mt-3 flex items-center gap-1.5 text-xs text-text-tertiary">
              <Icon name="info" size={13} />
              Green passes contrast only with dark text on top — we lock the button label to ink
              automatically.
            </p>
          </div>
        </div>

        <div className="mt-[26px] flex max-w-[1000px] items-center justify-between">
          <Link to="/setup" className="text-[13.5px] text-text-tertiary">
            Back
          </Link>
          <Button onClick={finishSetup} loading={updateOrg.isPending}>
            Finish setup
          </Button>
        </div>
      </div>
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
            aria-label={hex}
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
