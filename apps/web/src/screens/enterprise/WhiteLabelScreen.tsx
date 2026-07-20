import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Button, Icon, Input, Switch, useToast } from '@formai/ui';
import { BrandColorFields } from '../../components/branding/BrandColorFields.js';
import { FontPicker } from '../../components/branding/FontPicker.js';
import { LogoUploadControl } from '../../components/branding/LogoUploadControl.js';
import { useBilling, useUpdateWhiteLabel } from '../../lib/data/hooks.js';
import { ensureFontLoaded } from '../../lib/font-loader.js';
import { useOnboarding } from '../../lib/onboarding.js';
import { brandingBlockAccess, whiteLabelBlockAccess } from '../../lib/plan-gating.js';

/**
 * Branding settings — the post-onboarding editor for the org's kit (R10), with
 * a live external-form preview.
 *
 * Two blocks with different entitlements. The **branding block** (logo,
 * colours, font) is free at every tier and shares its controls with the
 * onboarding wizard, so anything set in the wizard can be changed here — this
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
  const { orgName, branding, setBranding, whiteLabel, setWhiteLabel, brandStyle } = useOnboarding();
  const { data: billing } = useBilling();
  const save = useUpdateWhiteLabel();

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
        {/* Branding block — free at every tier */}
        <div className="rounded-xl border border-border bg-surface-card p-[26px] shadow-sm">
          <div className="mb-[5px] font-heading text-[17px] font-bold">External form branding</div>
          <p className="mb-[22px] text-[13.5px] text-text-secondary">
            Applied to every external-facing form and its confirmation email. Included on every
            plan.
          </p>

          <fieldset disabled={!brandingAccess.editable} className="border-0 p-0">
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
                      toast({ variant: 'danger', message: 'Could not save branding — try again.' }),
                  },
                )
              }
            >
              Save branding
            </Button>
          </div>
        </div>

        {/* White-label block — Business and above */}
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
                <div className="text-[13px] font-semibold">Remove “Powered by FormAI”</div>
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
            <span className="truncate font-mono text-[11px] text-text-secondary">
              {whiteLabel.customDomain || 'forms.formai.app'}/vendor-onboarding
            </span>
          </div>
          <div className="flex h-[82px] items-center gap-3 px-6" style={{ background: 'var(--org-primary)' }}>
            {branding.logoAssetUrl ? (
              <img
                src={branding.logoAssetUrl}
                alt=""
                className="h-[38px] w-[38px] flex-none rounded-[9px] bg-white/[0.14] object-contain p-1"
              />
            ) : (
              <span className="grid h-[38px] w-[38px] place-items-center rounded-[9px] bg-white/[0.14] font-heading text-base font-bold text-white">
                {logoGlyph}
              </span>
            )}
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
