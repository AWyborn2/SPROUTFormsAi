import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Icon, useToast } from '@formai/ui';
import { DEFAULT_BRANDING } from '@formai/shared';
import { BrandMark } from '../../components/BrandMark.js';
import { BrandColorFields } from '../../components/branding/BrandColorFields.js';
import { FontPicker } from '../../components/branding/FontPicker.js';
import { LogoUploadControl } from '../../components/branding/LogoUploadControl.js';
import { ensureFontLoaded } from '../../lib/font-loader.js';
import { useInviteMember, useUpdateOrg } from '../../lib/data/hooks.js';
import { useOnboarding } from '../../lib/onboarding.js';
import { extractPaletteFromImageFile, mergeExtractedPalette } from '../../lib/palette-extract.js';
import {
  summarizeInviteResults,
  toRoleName,
  type InviteResult,
  type InviteSettled,
} from '../../lib/onboarding-routing.js';
import { Stepper } from './Stepper.js';

/** Step 2 — the org branding kit, with a live preview of a real branded form. */
export function BrandingScreen() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { orgName, branding, invites, setBranding, brandStyle } = useOnboarding();
  const updateOrg = useUpdateOrg();
  const inviteMember = useInviteMember();
  const [finishing, setFinishing] = useState(false);
  const [inviteResults, setInviteResults] = useState<InviteResult[] | null>(null);

  const orgInitial = (orgName.trim()[0] ?? '?').toUpperCase();

  // The live preview renders `var(--org-font)`, which only names the family —
  // load it whenever the selection changes (including on resume, where the
  // saved kit arrives without the picker having been touched).
  useEffect(() => {
    ensureFontLoaded(branding.formFont);
  }, [branding.formFont]);

  /**
   * Pre-fill the palette from the logo's own colours (R7). Read from the
   * local file rather than the uploaded URL — the bytes are already here and
   * a same-origin blob can't taint the canvas. Deliberately outside the
   * upload try/catch: extraction is cosmetic, so a failure must never surface
   * as an upload error. Only fields still at their defaults are written, so a
   * colour the user picked by hand survives a re-upload, and every field
   * stays editable afterwards.
   */
  const prefillPalette = async (file: File) => {
    const extracted = await extractPaletteFromImageFile(file);
    const patch = mergeExtractedPalette(branding, extracted, DEFAULT_BRANDING);
    if (Object.keys(patch).length > 0) setBranding(patch);
  };

  /**
   * Persist the wizard's choices and stamp onboarding complete via `PATCH /org`,
   * then send the Step 1 invite rows. An empty name is dropped so we never
   * overwrite the auto-provisioned org name with ''; if the save itself fails we
   * stay on this step so the user can retry.
   *
   * Invites are best-effort and deliberately do not gate completion — a seat
   * limit or a bad address must not trap someone in the wizard. Because the
   * Step 1 rows are off-screen by now, the per-email outcome renders here
   * before the transition to the app.
   */
  const finishSetup = async () => {
    setFinishing(true);
    const name = orgName.trim();
    const payload = { branding, onboardingComplete: true as const };
    try {
      await updateOrg.mutateAsync(name ? { name, ...payload } : payload);
    } catch {
      setFinishing(false);
      toast({
        variant: 'danger',
        message: 'Could not save your organisation settings — try again.',
      });
      return;
    }

    const rows = invites.filter((inv) => inv.email.trim());
    if (rows.length === 0) {
      navigate('/app');
      return;
    }

    const settled = await Promise.all(
      rows.map(async (inv): Promise<InviteSettled> => {
        const email = inv.email.trim();
        try {
          const value = await inviteMember.mutateAsync({ email, role: toRoleName(inv.role) });
          return { email, ok: true, value: value ? { emailSent: value.emailSent } : null };
        } catch (error) {
          return { email, ok: false, error };
        }
      }),
    );
    setInviteResults(summarizeInviteResults(settled).results);
    setFinishing(false);
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
              External forms — vendor onboarding, customer intake — go out under your identity, not
              ours.
            </p>

            {/* Logo */}
            <div className="mb-[9px] text-[13px] font-semibold">Logo</div>
            <div className="mb-[22px]">
              <LogoUploadControl
                value={branding.logoAssetUrl ?? null}
                initial={orgInitial}
                swatchColor={branding.primaryColor}
                onChange={(url) => setBranding({ logoAssetUrl: url })}
                onUploaded={prefillPalette}
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
                {branding.logoAssetUrl ? (
                  <img
                    src={branding.logoAssetUrl}
                    alt=""
                    className="h-10 w-10 flex-none rounded-[9px] object-contain p-1"
                    style={{
                      background: 'color-mix(in srgb, var(--org-primary-text) 14%, transparent)',
                    }}
                  />
                ) : (
                  <span
                    className="grid h-10 w-10 place-items-center rounded-[9px] font-heading text-[17px] font-bold"
                    style={{
                      background: 'color-mix(in srgb, var(--org-primary-text) 14%, transparent)',
                      color: 'var(--org-primary-text)',
                    }}
                  >
                    {orgInitial}
                  </span>
                )}
                <div>
                  <div
                    className="text-[17px] font-bold"
                    style={{ fontFamily: 'var(--org-font)', color: 'var(--org-primary-text)' }}
                  >
                    {orgName}
                  </div>
                  <div
                    className="text-[11.5px]"
                    style={{ color: 'color-mix(in srgb, var(--org-primary-text) 60%, transparent)' }}
                  >
                    Vendor onboarding
                  </div>
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

        {inviteResults && <InviteResultsPanel results={inviteResults} />}

        <div className="mt-[26px] flex max-w-[1000px] items-center justify-between">
          {inviteResults ? (
            <span className="text-[13.5px] text-text-tertiary">
              Your organisation is set up — you can manage invites from Team.
            </span>
          ) : (
            <Link to="/setup" className="text-[13.5px] text-text-tertiary">
              Back
            </Link>
          )}
          {inviteResults ? (
            <Button onClick={() => navigate('/app')}>Go to dashboard</Button>
          ) : (
            <Button onClick={() => void finishSetup()} loading={finishing}>
              Finish setup
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Per-email invite outcome, shown on the finish step because the rows that
 * produced it were entered on Step 1 and are no longer visible. Failures are
 * informational: the org is already set up by the time this renders.
 */
function InviteResultsPanel({ results }: { results: InviteResult[] }) {
  const failed = results.filter((r) => r.status === 'failed').length;
  return (
    <div
      role="status"
      className="mt-[26px] rounded-xl border border-border bg-surface-card p-[22px] shadow-sm"
    >
      <div className="mb-1 text-[15px] font-semibold">
        {failed === 0
          ? 'Invites sent'
          : `${results.length - failed} of ${results.length} invites sent`}
      </div>
      <p className="mb-[13px] text-[13px] text-text-secondary">
        Setup is complete either way — anything that failed can be retried from the Team screen.
      </p>
      <ul className="flex flex-col gap-[7px]">
        {results.map((r) => (
          <li key={r.email} className="flex items-start gap-2.5 text-[13px]">
            <Icon
              name={r.status === 'failed' ? 'info' : 'check'}
              size={14}
              className={`mt-0.5 flex-none ${r.status === 'failed' ? 'text-danger' : 'text-accent'}`}
            />
            <span className="min-w-0 flex-1">
              <span className="font-medium text-text-primary">{r.email}</span>{' '}
              <span className="text-text-tertiary">— {r.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
