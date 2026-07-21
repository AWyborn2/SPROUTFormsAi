import type { ReactNode } from 'react';
import type { BrandingKit } from '@formai/shared';
import { resolveTheme } from '@formai/shared';
import { containerSurfaceStyle, resolveLayout } from '../../lib/fill-layout.js';
import type { FormContainer } from '@formai/shared';

interface FormLayoutFrameProps {
  orgName: string;
  formName: string;
  branding: BrandingKit | null;
  container?: FormContainer | null;
  /** Fields plus the submit control — identical across every layout. */
  children: ReactNode;
}

const LOGO_PX = { small: 28, medium: 40, large: 56 } as const;

/**
 * Arranges the fill surface according to the theme's layout type.
 *
 * The three arrangements are wrappers over the *same* rendered field list and
 * submit control — only the framing differs. Keeping the body as `children`
 * rather than duplicating it per layout is what stops the layouts drifting
 * apart in behaviour the way the two previews once did.
 *
 * `conversational` is not handled here: it replaces the fill engine rather
 * than reframing it, so `resolveLayout` degrades it to `card` until that
 * ships. A form set to it still serves rather than breaking for respondents.
 */
export function FormLayoutFrame({
  orgName,
  formName,
  branding,
  container,
  children,
}: FormLayoutFrameProps) {
  const theme = resolveTheme(branding?.theme);
  const layout = resolveLayout(theme.layout);
  const logoPx = LOGO_PX[theme.logoSize] ?? LOGO_PX.medium;
  const centred = theme.logoPlacement === 'center';
  const maxWidth = container?.maxWidth ?? 600;
  const glyph = (orgName.trim()[0] ?? '?').toUpperCase();

  const surface = containerSurfaceStyle(container);
  const bodyPadding = `${container?.padding ?? 26}px 28px`;

  const mark = branding?.logoAssetUrl ? (
    <img
      src={branding.logoAssetUrl}
      alt=""
      className="flex-none rounded-[9px] object-contain p-1"
      style={{
        width: logoPx,
        height: logoPx,
        background: 'color-mix(in srgb, var(--org-primary-text) 14%, transparent)',
      }}
    />
  ) : (
    <span
      className="grid flex-none place-items-center rounded-[9px] font-heading font-bold"
      style={{
        width: logoPx,
        height: logoPx,
        background: 'color-mix(in srgb, var(--org-primary-text) 14%, transparent)',
        color: 'var(--org-primary-text)',
      }}
    >
      {glyph}
    </span>
  );

  const heading = (
    <div className={centred ? 'text-center' : 'min-w-0'}>
      <div
        className="font-mono uppercase tracking-wide"
        style={{
          fontSize: 11,
          color: 'color-mix(in srgb, var(--org-primary-text) 60%, transparent)',
        }}
      >
        {orgName || 'Form'}
      </div>
      <div
        className="truncate"
        style={{
          fontFamily: 'var(--org-font)',
          color: 'var(--org-primary-text)',
          fontSize: 'var(--org-heading-size)',
          fontWeight: 'var(--org-heading-weight)' as unknown as number,
        }}
      >
        {formName}
      </div>
      <div
        className="mt-1.5 text-[13px]"
        style={{ color: 'color-mix(in srgb, var(--org-primary-text) 70%, transparent)' }}
      >
        Fields marked * are required
      </div>
    </div>
  );

  const body = (
    <div
      className="flex flex-col gap-6"
      style={{
        fontFamily: 'var(--org-font)',
        padding: bodyPadding,
        background: theme.formBackground || undefined,
      }}
    >
      {children}
    </div>
  );

  // Hero — a tall brand band spanning the width, fields below it on the page.
  if (layout === 'hero') {
    return (
      <div className="w-full" style={{ maxWidth: maxWidth + 120 }}>
        <div
          className={`flex items-center gap-4 px-8 py-10 ${centred ? 'flex-col' : ''}`}
          style={{
            background: 'var(--org-primary)',
            borderTopLeftRadius: surface.borderRadius as string,
            borderTopRightRadius: surface.borderRadius as string,
          }}
        >
          {mark}
          {heading}
        </div>
        <div className="overflow-hidden" style={{ ...surface, borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
          {body}
        </div>
      </div>
    );
  }

  // Split — a persistent brand panel beside the form on desktop, collapsing to
  // a header band on narrow viewports where a side panel would squeeze the
  // fields into an unusable column.
  if (layout === 'split') {
    return (
      <div
        className="grid w-full overflow-hidden md:grid-cols-[minmax(200px,34%)_1fr]"
        style={{ maxWidth: maxWidth + 260, ...surface }}
      >
        <div
          className="flex flex-col gap-3 p-7"
          style={{ background: 'var(--org-primary)' }}
        >
          {mark}
          {heading}
        </div>
        <div style={{ background: theme.formBackground || '#ffffff' }}>{body}</div>
      </div>
    );
  }

  // Card — the default: brand masthead strip above the form card.
  return (
    <div className="w-full" style={{ maxWidth: `${maxWidth}px` }}>
      <div className="overflow-hidden border border-border bg-white" style={surface}>
        <div
          className={`flex items-center gap-3 p-[24px_28px] ${centred ? 'flex-col' : ''}`}
          style={{ background: 'var(--org-primary)' }}
        >
          {mark}
          {heading}
        </div>
        {body}
      </div>
    </div>
  );
}
