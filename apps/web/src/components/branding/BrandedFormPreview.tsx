import { useState } from 'react';
import { Icon } from '@formai/ui';
import type { BrandingKit } from '@formai/shared';
import { resolveTheme } from '@formai/shared';
import { orgBrandVars } from '../../lib/branding.js';
import type { PreviewRegion } from '../../lib/theme-editor.js';

interface BrandedFormPreviewProps {
  orgName: string;
  branding: BrandingKit;
  /** Shown in the fake address bar; falls back to the product domain. */
  domain?: string;
  /** Region to highlight — set while a control has focus, so the owner can see what it changes. */
  highlight?: PreviewRegion | null;
  /** Whether to show the "Powered by FormAI" footer (white-label can remove it). */
  showBadge?: boolean;
}

/**
 * The single branded-form preview, shared by the onboarding wizard and the
 * branding settings screen.
 *
 * Previously each screen carried its own near-identical copy of this markup,
 * which is how both of them ended up hardcoding white text over the brand
 * primary and drifting from what the real fill page renders. One component
 * consuming the same resolved tokens as `FillScreen` is what makes R13's "the
 * preview may not diverge from the live rendering" enforceable rather than
 * aspirational.
 */
export function BrandedFormPreview({
  orgName,
  branding,
  domain,
  highlight,
  showBadge = true,
}: BrandedFormPreviewProps) {
  const [device, setDevice] = useState<'web' | 'mobile'>('web');
  const theme = resolveTheme(branding.theme);
  const glyph = (orgName.trim()[0] ?? '?').toUpperCase();
  const isMobile = device === 'mobile';

  const ring = (region: PreviewRegion) =>
    highlight === region ? 'outline outline-2 outline-offset-[-2px] outline-accent' : '';

  const logoPx = { small: 28, medium: 40, large: 56 }[theme.logoSize];
  const centred = theme.logoPlacement === 'center';

  return (
    <div>
      <div className="mb-[11px] flex items-center gap-2">
        <Icon name="eye" size={15} className="text-accent" />
        <span className="flex-1 font-mono text-[11px] uppercase tracking-wide text-text-tertiary">
          Live preview · what recipients see
        </span>
        <div className="flex gap-1" role="group" aria-label="Preview device">
          {(['web', 'mobile'] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDevice(d)}
              aria-pressed={device === d}
              className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold capitalize ${
                device === d
                  ? 'border-border-strong bg-surface-sunken text-text-primary'
                  : 'border-border text-text-tertiary'
              }`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      <div className={isMobile ? 'flex justify-center' : ''}>
        <div
          className={`overflow-hidden rounded-lg border border-border shadow-md ${ring('page')} ${
            isMobile ? 'w-[300px]' : 'w-full'
          }`}
          style={{
            ...orgBrandVars(branding),
            ...(theme.pageBackground ? { background: theme.pageBackground } : {}),
          }}
        >
          <div className="flex items-center gap-2 border-b border-border bg-surface-sunken px-3.5 py-2">
            <Icon name="lock" size={11} className="text-accent" />
            <span className="truncate font-mono text-[11px] text-text-secondary">
              {domain || 'forms.formai.app'}/vendor-onboarding
            </span>
          </div>

          {/* Masthead */}
          <div
            className={`flex items-center gap-3 px-6 py-5 ${ring('masthead')} ${
              centred ? 'flex-col text-center' : ''
            }`}
            style={{ background: 'var(--org-primary)' }}
          >
            {branding.logoAssetUrl ? (
              <img
                src={branding.logoAssetUrl}
                alt=""
                className={`flex-none rounded-[9px] object-contain p-1 ${ring('logo')}`}
                style={{
                  width: logoPx,
                  height: logoPx,
                  background: 'color-mix(in srgb, var(--org-primary-text) 14%, transparent)',
                }}
              />
            ) : (
              <span
                className={`grid flex-none place-items-center rounded-[9px] font-heading font-bold ${ring('logo')}`}
                style={{
                  width: logoPx,
                  height: logoPx,
                  background: 'color-mix(in srgb, var(--org-primary-text) 14%, transparent)',
                  color: 'var(--org-primary-text)',
                }}
              >
                {glyph}
              </span>
            )}
            <div className={centred ? '' : 'min-w-0'}>
              <div
                className="truncate font-bold"
                style={{
                  fontFamily: 'var(--org-font)',
                  color: 'var(--org-primary-text)',
                  fontSize: 'var(--org-heading-size)',
                  fontWeight: 'var(--org-heading-weight)' as unknown as number,
                }}
              >
                {orgName || 'Your organisation'}
              </div>
              <div
                className="text-[11.5px]"
                style={{ color: 'color-mix(in srgb, var(--org-primary-text) 60%, transparent)' }}
              >
                Vendor onboarding
              </div>
            </div>
          </div>

          {/* Body */}
          <div
            className={ring('body')}
            style={{
              fontFamily: 'var(--org-font)',
              background: theme.formBackground || '#ffffff',
              padding: 'var(--org-pad)',
            }}
          >
            <div
              className="mb-3.5"
              style={{
                fontSize: 'var(--org-heading-size)',
                fontWeight: 'var(--org-heading-weight)' as unknown as number,
                color: theme.headingColor || '#1a2224',
              }}
            >
              Supplier details
            </div>

            <div className={`flex flex-col ${ring('fields')}`} style={{ gap: 'var(--org-gap)' }}>
              {['Legal entity name *', 'Contact email *'].map((label) => (
                <div key={label}>
                  <div
                    className="mb-[5px]"
                    style={{
                      fontSize: 'var(--org-label-size)',
                      fontWeight: 'var(--org-label-weight)' as unknown as number,
                      color: theme.labelColor || '#33403f',
                    }}
                  >
                    {label}
                  </div>
                  <div
                    className="h-9 bg-[#fbfcfc]"
                    style={{
                      borderRadius: 'var(--org-radius)',
                      borderWidth: 'var(--org-border-width)',
                      borderStyle: 'solid',
                      borderColor: theme.borderColor || '#d9dede',
                    }}
                  />
                </div>
              ))}
            </div>

            <div className={`mt-4 flex ${centred ? 'justify-center' : 'justify-end'}`}>
              <div
                className={`px-5 py-2.5 ${ring('button')}`}
                style={{
                  background:
                    theme.buttonStyle === 'outline' ? 'transparent' : 'var(--org-accent)',
                  color:
                    theme.buttonStyle === 'outline'
                      ? 'var(--org-accent)'
                      : 'var(--org-accent-text)',
                  border:
                    theme.buttonStyle === 'outline' ? '1.5px solid var(--org-accent)' : 'none',
                  borderRadius: 'var(--org-button-radius)',
                  fontFamily: 'var(--org-font)',
                  fontSize: 'var(--org-button-size)',
                  fontWeight: 'var(--org-button-weight)' as unknown as number,
                }}
              >
                Submit application
              </div>
            </div>

            {showBadge && (
              <div className="mt-4 text-center text-[10.5px] text-text-tertiary">
                Secure · powered by FormAI
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
