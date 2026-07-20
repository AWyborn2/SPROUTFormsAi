import { Button, Icon, Input, Switch, useToast } from '@formai/ui';
import type { BrandingKit, FormFont } from '@formai/shared';
import { useUpdateWhiteLabel } from '../../lib/data/hooks.js';
import { useOnboarding } from '../../lib/onboarding.js';

type ColorKey = 'primaryColor' | 'accentColor';

interface SwatchRow {
  key: ColorKey;
  label: string;
  presets: string[];
}

const SWATCH_ROWS: SwatchRow[] = [
  { key: 'primaryColor', label: 'Primary', presets: ['#253439', '#1f3a5f', '#3a2f5f', '#2f5f3a', '#181b19'] },
  { key: 'accentColor', label: 'Accent', presets: ['#6ec792', '#f0a500', '#e0603a', '#3f8fd0', '#8a5cf0'] },
];

const FONT_OPTIONS: Array<{ name: FormFont; stack: string }> = [
  { name: 'Inter', stack: "'Inter',sans-serif" },
  { name: 'Sora', stack: "'Sora',sans-serif" },
  { name: 'Spectral', stack: "'Spectral',serif" },
];

/**
 * White-label settings — the org branding editor with a live external-form
 * preview. Edits update the app-wide onboarding/branding context, so the
 * preview here reflects them immediately; external visitors on the fill page
 * (`/fill/:token`) only see the new branding once Save persists the kit to
 * `organizations.branding` via `PATCH /org` (the API writes the audit entry).
 */
export function WhiteLabelScreen() {
  const { toast } = useToast();
  const { orgName, branding, setBranding, whiteLabel, setWhiteLabel, brandStyle } = useOnboarding();
  const save = useUpdateWhiteLabel();
  const logoGlyph = (orgName.trim()[0] ?? 'M').toUpperCase();

  return (
    <div className="fai-rise mx-auto grid max-w-[1000px] grid-cols-1 items-start gap-6 p-[30px_28px_60px] lg:grid-cols-2">
      {/* Editor */}
      <div className="rounded-xl border border-border bg-surface-card p-[26px] shadow-sm">
        <div className="mb-[5px] font-heading text-[17px] font-bold">External form branding</div>
        <p className="mb-[22px] text-[13.5px] text-text-secondary">
          Applied to every external-facing form and its confirmation email.
        </p>

        {/* Colours */}
        <div className="mb-[11px] text-[13px] font-semibold">Brand colours</div>
        <div className="mb-5 flex flex-col gap-[13px]">
          {SWATCH_ROWS.map((row) => (
            <div key={row.key}>
              <div className="mb-[7px] flex justify-between">
                <span className="text-[12.5px] text-text-secondary">{row.label}</span>
                <span className="font-mono text-[11.5px] text-text-tertiary">
                  {branding[row.key].toUpperCase()}
                </span>
              </div>
              <div className="flex gap-[7px]">
                {row.presets.map((hex) => {
                  const selected = branding[row.key].toLowerCase() === hex.toLowerCase();
                  return (
                    <button
                      key={hex}
                      onClick={() => setBranding({ [row.key]: hex } as Partial<BrandingKit>)}
                      aria-label={`${row.label} ${hex}`}
                      aria-pressed={selected}
                      className="h-[30px] w-[38px] rounded-lg shadow-xs"
                      style={{
                        background: hex,
                        border: `2px solid ${selected ? 'var(--brand-ink)' : 'rgba(0,0,0,.08)'}`,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Font */}
        <div className="mb-[9px] text-[13px] font-semibold">Form font</div>
        <div className="mb-5 flex gap-2">
          {FONT_OPTIONS.map((f) => {
            const selected = branding.formFont === f.name;
            return (
              <button
                key={f.name}
                onClick={() => setBranding({ formFont: f.name })}
                aria-pressed={selected}
                className="fai-chip-btn flex-1 rounded-md border-[1.5px] px-2 py-[11px] text-center"
                style={{
                  borderColor: selected ? 'var(--border-accent)' : 'var(--border-default)',
                  background: selected ? 'var(--surface-accent-soft)' : 'var(--surface-card)',
                }}
              >
                <span className="block text-[17px] font-semibold" style={{ fontFamily: f.stack }}>
                  Ag
                </span>
                <span className="mt-[3px] block text-[11px] text-text-tertiary">{f.name}</span>
              </button>
            );
          })}
        </div>

        {/* Domain / sender / badge */}
        <div className="flex flex-col gap-3.5">
          <Input
            label="Custom form domain"
            leadingIcon="globe"
            value={whiteLabel.customDomain}
            onChange={(e) => setWhiteLabel({ customDomain: e.target.value })}
          />
          <Input
            label="Email sender address"
            leadingIcon="mail"
            value={whiteLabel.senderEmail}
            onChange={(e) => setWhiteLabel({ senderEmail: e.target.value })}
          />
          <div className="flex items-center justify-between gap-2.5 rounded-md border border-border-subtle bg-surface-sunken px-3.5 py-3">
            <div>
              <div className="text-[13px] font-semibold">Remove “Powered by FormAI”</div>
              <div className="text-[11.5px] text-text-tertiary">Enterprise · shown on external forms</div>
            </div>
            <Switch
              checked={whiteLabel.removeBadge}
              onChange={(e) => setWhiteLabel({ removeBadge: e.target.checked })}
              aria-label="Remove Powered by FormAI badge"
            />
          </div>
        </div>

        <div className="mt-[22px]">
          <Button
            leadingIcon="check"
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                { branding },
                {
                  onSuccess: () =>
                    toast({ variant: 'success', message: 'White-label settings applied to all external forms.' }),
                  onError: () =>
                    toast({ variant: 'danger', message: 'Could not save branding — try again.' }),
                },
              )
            }
          >
            Save branding
          </Button>
        </div>
      </div>

      {/* Live preview */}
      <div className="sticky top-4">
        <div className="mb-[11px] flex items-center gap-2">
          <Icon name="eye" size={15} className="text-accent" />
          <span className="font-mono text-[11px] uppercase tracking-wide text-text-tertiary">
            Live preview · what recipients see
          </span>
        </div>
        <div className="overflow-hidden rounded-lg border border-border shadow-md" style={brandStyle()}>
          <div className="flex items-center gap-2 border-b border-border bg-surface-sunken px-3.5 py-2">
            <Icon name="lock" size={11} className="text-accent" />
            <span className="font-mono text-[11px] text-text-secondary">
              {whiteLabel.customDomain}/vendor-onboarding
            </span>
          </div>
          <div className="flex h-[82px] items-center gap-3 px-6" style={{ background: 'var(--org-primary)' }}>
            <span className="grid h-[38px] w-[38px] place-items-center rounded-[9px] bg-white/[0.14] font-heading text-base font-bold text-white">
              {logoGlyph}
            </span>
            <div>
              <div className="text-base font-bold text-white" style={{ fontFamily: 'var(--org-font)' }}>
                {orgName}
              </div>
              <div className="text-[11.5px] text-white/60">Vendor onboarding</div>
            </div>
          </div>
          <div className="bg-white px-6 py-[22px]" style={{ fontFamily: 'var(--org-font)' }}>
            <div className="mb-3.5 text-[17px] font-bold text-[#1a2224]" style={{ fontFamily: 'var(--org-font)' }}>
              Supplier details
            </div>
            <div className="mb-3">
              <div className="mb-[5px] text-xs font-semibold text-[#33403f]">Legal entity name *</div>
              <div className="h-9 rounded-lg border border-[#d9dede] bg-[#fbfcfc]" />
            </div>
            <div className="mt-4 flex justify-end">
              <div
                className="rounded-lg px-5 py-2.5 text-[13px] font-bold"
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
      </div>
    </div>
  );
}
