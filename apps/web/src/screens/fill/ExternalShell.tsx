import { useEffect } from 'react';
import { Icon } from '@formai/ui';
import type { BrandingKit } from '@formai/shared';
import { DEFAULT_BRANDING, resolveTheme } from '@formai/shared';
import { orgBrandVars } from '../../lib/branding.js';
import { ensureFontLoaded } from '../../lib/font-loader.js';

/**
 * Lightest-chrome wrapper for the public fill pages. Renders logged OUT: the
 * serving org's name and brand kit come from the public `GET /fill/:token`
 * payload (not from any session), applied as the `--org-*` CSS vars. A null
 * kit falls back to the FormAI defaults, and an empty org name (loading /
 * not-found states) falls back to a neutral "FormAI" masthead.
 */
export function ExternalShell({
  orgName,
  branding,
  children,
}: {
  orgName: string;
  branding: BrandingKit | null;
  children: React.ReactNode;
}) {
  const displayName = orgName.trim() || 'FormAI';
  const orgInitial = (displayName[0] ?? 'F').toUpperCase();
  const logoUrl = branding?.logoAssetUrl ?? null;
  const theme = resolveTheme(branding?.theme);
  const chromeLogoPx = { small: 22, medium: 28, large: 32 }[theme.logoSize] ?? 28;

  // `orgBrandVars` only *names* the family in `--org-font`; without this the
  // respondent sees the generic fallback for every font but the ones the app
  // shell happens to bundle. Idempotent, so re-running on kit changes is free.
  const formFont = branding?.formFont ?? DEFAULT_BRANDING.formFont;
  useEffect(() => {
    ensureFontLoaded(formFont);
  }, [formFont]);

  return (
    <div className="flex min-h-screen flex-col bg-surface-page" style={orgBrandVars(branding)}>
      <header className="flex h-14 flex-none items-center justify-between border-b border-border bg-surface-card px-6">
        <div className="flex items-center gap-2.5">
          {/* The public logo route exists precisely so logged-out respondents
              can load the org's mark, so this is its primary surface. Mirrors
              the AppShell conditional: <img> when a logo is set, initial glyph
              otherwise. The glyph's ink is `--org-primary-text` (U7) rather
              than a hardcoded white, which vanishes on a light brand primary. */}
          {/* Size follows the theme's logo setting rather than a fixed 28px,
              so a wordmark that needs room gets it. Capped at 32px here
              regardless: this is a 56px-tall chrome bar, not the form
              masthead, and a large mark would overflow it. */}
          {logoUrl ? (
            <img
              src={logoUrl}
              alt=""
              className="flex-none rounded-[7px] object-contain"
              style={{ width: chromeLogoPx, height: chromeLogoPx }}
            />
          ) : (
            <span
              className="grid flex-none place-items-center rounded-[7px] font-heading text-[13px] font-bold"
              style={{
                width: chromeLogoPx,
                height: chromeLogoPx,
                background: 'var(--org-primary)',
                color: 'var(--org-primary-text)',
              }}
            >
              {orgInitial}
            </span>
          )}
          <span className="text-sm font-semibold" style={{ fontFamily: 'var(--org-font)' }}>
            {displayName}
          </span>
        </div>
        <span className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
          <Icon name="lock" size={12} className="text-accent" />
          Secure · powered by FormAI
        </span>
      </header>
      <div className="fai-scroll flex flex-1 justify-center overflow-auto p-[30px_20px_60px]">
        {children}
      </div>
    </div>
  );
}
