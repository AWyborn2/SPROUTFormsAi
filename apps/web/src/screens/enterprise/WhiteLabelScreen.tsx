import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Icon, Input, Switch, useToast } from '@formai/ui';
import { BrandColorFields } from '../../components/branding/BrandColorFields.js';
import { BrandedFormPreview } from '../../components/branding/BrandedFormPreview.js';
import { FontPicker } from '../../components/branding/FontPicker.js';
import { LogoUploadControl } from '../../components/branding/LogoUploadControl.js';
import { ThemeCustomizer } from '../../components/branding/ThemeCustomizer.js';
import { ThemePresetGallery } from '../../components/branding/ThemePresetGallery.js';
import { useBilling, useUpdateWhiteLabel } from '../../lib/data/hooks.js';
import { ensureFontLoaded } from '../../lib/font-loader.js';
import { useOnboarding } from '../../lib/onboarding.js';
import { brandingBlockAccess, whiteLabelBlockAccess } from '../../lib/plan-gating.js';
import type { PreviewRegion } from '../../lib/theme-editor.js';

/**
 * Branding settings â€” the post-onboarding editor for the org's kit (R10), with
 * a live external-form preview.
 *
 * Two blocks with different entitlements. The **branding block** (logo,
 * colours, font) is free at every tier and shares its controls with the
 * onboarding wizard, so anything set in the wizard can be changed here â€” this
 * is the only place a logo is editable after setup. The **white-label block**
 * (custom domain, sender address, badge removal) stays plan-gated on
 * `features.whiteLabel`; since branding went free the `PATCH /org` gate was
 * removed, making this the single enforcement site for R9's paid half.
 *
 * Edits update the app-wide onboarding/branding context, so the preview
 * reflects them immediately; external visitors on the fill page
 * (`/fill/:token`) only see the new branding once Save persists the kit to
 * `organizations.branding` via `PATCH /org` (the API writes the audit entry).
 */
export function WhiteLabelScreen() {
  const { toast } = useToast();
  const { orgName, branding, setBranding, whiteLabel, setWhiteLabel } = useOnboarding();
  const { data: billing } = useBilling();
  const save = useUpdateWhiteLabel();
  const [customizing, setCustomizing] = useState(false);
  const [highlight, setHighlight] = useState<PreviewRegion | null>(null);

  const brandingAccess = brandingBlockAccess(billing?.features);
  const whiteLabelAccess = whiteLabelBlockAccess(billing?.features);
  const logoGlyph = (orgName.trim()[0] ?? '?').toUpperCase();

  // The preview renders `var(--org-font)`, which only names the family.
  useEffect(() => {
    ensureFontLoaded(branding.formFont);
  }, [branding.formFont]);

  return (
    <div className="fai-rise mx-auto grid max-w-[1000px] grid-cols-1 items-start gap-6 p-[30px_28px_60px] lg:grid-cols-2">
      <div className="flex flex-col gap-6">
        {/* Branding block â€” free at every tier */}
        <div className="rounded-xl border border-border bg-surface-card p-[26px] shadow-sm">
          <div className="mb-[5px] font-heading text-[17px] font-bold">External form branding</div>
          <p className="mb-[22px] text-[13.5px] text-text-secondary">
            Applied to every external-facing form. Included on every plan.
          </p>

          <fieldset disabled={!brandingAccess.editable} className="border-0 p-0">
            {/* Presets first: pick a look, keep your colours. */}
            <div className="mb-[9px] text-[13px] font-semibold">Style preset</div>
            <div className="mb-[22px]">
              <ThemePresetGallery
                theme={branding.theme ?? {}}
                onChange={(theme) => setBranding({ theme })}
                disabled={!brandingAccess.editable}
              />
            </div>

            {/* Logo */}
            <div className="mb-[9px] text-[13px] font-semibold">Logo</div>
            <div className="mb-[22px]">
              <LogoUploadControl
                value={branding.logoAssetUrl ?? null}
                initial={logoGlyph}
                swatchColor={branding.primaryColor}
                onChange={(url) => setBranding({ logoAssetUrl: url })}
              />
            </div>

            {/* Colours */}
            <div className="mb-[11px] text-[13px] font-semibold">Brand colours</div>
            <div className="mb-[22px]">
              <BrandColorFields branding={branding} onChange={setBranding} />
            </div>

            {/* Font */}
            <div className="mb-[9px] text-[13px] font-semibold">Form font</div>
            <FontPicker
              value={branding.formFont}
              onPick={(family) => setBranding({ formFont: family })}
            />

            {/* Everything finer lives behind one expander, so the landing view
                stays a preset gallery rather than a wall of controls. */}
            <button
              type="button"
              onClick={() => setCustomizing((v) => !v)}
              aria-expanded={customizing}
              className="mt-[22px] flex w-full items-center justify-between rounded-md border border-dashed border-border-strong px-3.5 py-2.5 text-left"
            >
              <span className="text-[13px] font-semibold">
                Customize theme
                <span className="ml-1.5 font-normal text-text-tertiary">
                  colours, typography, buttons, logoâ€¦
                </span>
              </span>
              <Icon
                name={customizing ? 'chevron-down' : 'chevron-right'}
                size={14}
                className="text-text-tertiary"
              />
            </button>

            {customizing && (
              <div className="mt-3">
                <ThemeCustomizer
                  theme={branding.theme ?? {}}
                  onChange={(patch) => setBranding({ theme: { ...branding.theme, ...patch } })}
                  onHighlight={setHighlight}
                  disabled={!brandingAccess.editable}
                />
              </div>
            )}
          </fieldset>

          <div className="mt-[22px]">
            <Button
              leadingIcon="check"
              loading={save.isPending}
              onClick={() =>
                save.mutate(
                  { branding },
                  {
                    onSuccess: () =>
                      toast({
                        variant: 'success',
                        message: 'Branding applied to all external forms.',
                      }),
                    onError: () =>
                      toast({ variant: 'danger', message: 'Could not save branding â€” try again.' }),
                  },
                )
              }
            >
              Save branding
            </Button>
          </div>
        </div>

        {/* White-label block â€” Business and above */}
        <div className="rounded-xl border border-border bg-surface-card p-[26px] shadow-sm">
          <div className="mb-[5px] flex items-center gap-2">
            <span className="font-heading text-[17px] font-bold">White-label delivery</span>
            {!whiteLabelAccess.editable && (
              <span className="flex items-center gap-1 rounded-full border border-border bg-surface-sunken px-2 py-0.5 text-[11px] font-semibold text-text-secondary">
                <Icon name="lock" size={11} />
                Business
              </span>
            )}
          </div>
          <p className="mb-[22px] text-[13.5px] text-text-secondary">
            Serve forms from your own domain and send confirmations from your own address.
          </p>

          <fieldset
            disabled={!whiteLabelAccess.editable}
            aria-describedby={whiteLabelAccess.editable ? undefined : 'white-label-upgrade'}
            className={`flex flex-col gap-3.5 border-0 p-0 ${
              whiteLabelAccess.editable ? '' : 'opacity-55'
            }`}
          >
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
                <div className="text-[13px] font-semibold">Remove â€œPowered by FormAIâ€</div>
                <div className="text-[11.5px] text-text-tertiary">Shown on external forms</div>
              </div>
              <Switch
                checked={whiteLabel.removeBadge}
                onChange={(e) => setWhiteLabel({ removeBadge: e.target.checked })}
                aria-label="Remove Powered by FormAI badge"
              />
            </div>
          </fieldset>

          {!whiteLabelAccess.editable && (
            <div
              id="white-label-upgrade"
              className="mt-3.5 flex items-center gap-3 rounded-md border border-border-subtle bg-surface-sunken px-3.5 py-3"
            >
              <Icon name="sparkles" size={15} className="flex-none text-accent" />
              <span className="min-w-0 flex-1 text-[12.5px] text-text-secondary">
                {whiteLabelAccess.upgradeHint}
              </span>
              <Link
                to="/app/billing"
                className="fai-chip-btn flex-none rounded-md border border-border bg-surface-card px-3 py-1.5 text-xs font-semibold text-text-primary"
              >
                See plans
              </Link>
            </div>
          )}
        </div>
      </div>

      {/* Live preview — the same component the onboarding wizard uses, so the
          two can no longer drift from each other or from the real fill page. */}
      <div className="sticky top-4">
        <BrandedFormPreview
          orgName={orgName}
          branding={branding}
          domain={whiteLabel.customDomain}
          highlight={highlight}
          showBadge={!whiteLabel.removeBadge}
        />
      </div>
    </div>
  );
}
