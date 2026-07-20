import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@formai/ui';
import { useSession } from '../lib/data/hooks.js';
import { shouldShowBrandingNudge } from '../lib/onboarding-routing.js';

/**
 * The soft resume path for an abandoned setup wizard (R5/F2).
 *
 * Deliberately not a blocking modal: the owner is already in the app and the
 * org works without a branding kit. Dismissal is component-local on purpose —
 * it silences the banner for this session only, so an owner who keeps putting
 * it off is asked again next login, while finishing the wizard removes it for
 * good (the completion `PATCH /org` invalidates the session query, this
 * re-reads `onboardingCompletedAt`, and the nudge stops rendering by itself).
 */
export function FinishBrandingBanner() {
  const { data: session, isLoading } = useSession();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || !shouldShowBrandingNudge({ session, isLoading })) return null;

  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-border bg-surface-sunken px-6 py-2.5"
    >
      <span
        className="grid h-7 w-7 flex-none place-items-center rounded-md"
        style={{ background: 'var(--org-accent)', color: 'var(--org-accent-text)' }}
      >
        <Icon name="sliders-horizontal" size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold text-text-primary">
          Finish setting up your brand
        </span>
        <span className="block text-[12px] text-text-secondary">
          Add your logo, colours and font so external forms go out under your identity.
        </span>
      </span>
      <Link
        to="/setup/branding"
        className="fai-chip-btn flex-none rounded-md border border-border bg-surface-card px-3 py-1.5 text-xs font-semibold text-text-primary"
      >
        Finish branding
      </Link>
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss branding reminder"
        className="grid h-7 w-7 flex-none place-items-center rounded-md text-text-tertiary hover:bg-surface-hover"
      >
        <Icon name="x" size={15} />
      </button>
    </div>
  );
}
