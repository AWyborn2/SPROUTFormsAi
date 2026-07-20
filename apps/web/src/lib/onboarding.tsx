import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { BrandingKit, Role } from '@formai/shared';
import { orgBrandVars } from './branding.js';
import { useSession } from './data/hooks.js';
import { onboardingSeedFromSession, whiteLabelSeed } from './onboarding-routing.js';

export type AuthMode = 'signup' | 'signin';

export interface Invite {
  email: string;
  role: Role;
}

/**
 * White-label delivery settings — org-wide, edited on the white-label settings
 * screen. Kept alongside the branding kit so the external fill flow and the
 * settings editor read one source (this provider wraps the whole app).
 */
export interface WhiteLabelState {
  customDomain: string;
  senderEmail: string;
  removeBadge: boolean;
}

/**
 * Wizard/editor UI state only — nothing here persists by itself. The
 * onboarding wizard's "Finish setup" and the white-label screen's save both
 * write the collected name/branding to the API via `PATCH /org`
 * (`useUpdateOrg` / `useUpdateWhiteLabel` in lib/data/hooks.ts).
 */
interface OnboardingState {
  authMode: AuthMode;
  name: string;
  email: string;
  password: string;
  orgName: string;
  teamSize: string;
  invites: Invite[];
  branding: BrandingKit;
  whiteLabel: WhiteLabelState;
}

interface OnboardingCtx extends OnboardingState {
  setAuthMode: (m: AuthMode) => void;
  patch: (p: Partial<OnboardingState>) => void;
  addInvite: () => void;
  updateInvite: (index: number, patch: Partial<Invite>) => void;
  setBranding: (patch: Partial<BrandingKit>) => void;
  setWhiteLabel: (patch: Partial<WhiteLabelState>) => void;
  /** CSS custom properties applying the org brand to a preview subtree. */
  brandStyle: () => React.CSSProperties;
}

const Ctx = createContext<OnboardingCtx | null>(null);

export function OnboardingProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const [state, setState] = useState<OnboardingState>({
    authMode: 'signup',
    name: '',
    email: '',
    password: '',
    invites: [{ email: '', role: 'builder' }],
    whiteLabel: whiteLabelSeed(),
    // Neutral until `/auth/me` resolves — an unauthenticated surface has no org.
    ...onboardingSeedFromSession(null),
  });

  /**
   * Seed the wizard from server truth the first time a session arrives.
   *
   * Without this a resumed wizard opens on `DEFAULT_BRANDING` and "Finish
   * setup" writes those defaults straight over the kit the org already saved.
   * Latched on first edit so a slow `/auth/me` can never overwrite typing that
   * has already started.
   */
  const hydratedRef = useRef(false);
  const editedRef = useRef(false);
  useEffect(() => {
    if (!session || hydratedRef.current || editedRef.current) return;
    hydratedRef.current = true;
    setState((s) => ({ ...s, ...onboardingSeedFromSession(session) }));
  }, [session]);

  const value = useMemo<OnboardingCtx>(() => {
    const patch = (p: Partial<OnboardingState>) => {
      editedRef.current = true;
      setState((s) => ({ ...s, ...p }));
    };
    return {
      ...state,
      setAuthMode: (authMode) => patch({ authMode }),
      patch,
      addInvite: () =>
        setState((s) => ({ ...s, invites: [...s.invites, { email: '', role: 'builder' }] })),
      updateInvite: (index, ip) =>
        setState((s) => ({
          ...s,
          invites: s.invites.map((inv, i) => (i === index ? { ...inv, ...ip } : inv)),
        })),
      setBranding: (bp) => {
        editedRef.current = true;
        setState((s) => ({ ...s, branding: { ...s.branding, ...bp } }));
      },
      setWhiteLabel: (wp) => {
        editedRef.current = true;
        setState((s) => ({ ...s, whiteLabel: { ...s.whiteLabel, ...wp } }));
      },
      brandStyle: () => orgBrandVars(state.branding),
    };
  }, [state]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOnboarding(): OnboardingCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useOnboarding must be used within OnboardingProvider');
  return ctx;
}
