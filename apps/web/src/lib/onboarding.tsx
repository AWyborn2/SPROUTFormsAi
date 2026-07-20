import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { BrandingKit, Role } from '@formai/shared';
import { DEFAULT_BRANDING } from '@formai/shared';
import { orgBrandVars } from './branding.js';
import { useSession } from './data/hooks.js';

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
  hasLogo: boolean;
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

/**
 * Fixture fallback shown only on unauthenticated demo surfaces (the external
 * fill flow) where no session exists. Once `/auth/me` resolves, the effect
 * below replaces it with the org's real name, so a user who never touches the
 * name field finishes onboarding without renaming their org to this fixture.
 */
const DEMO_ORG_NAME = 'Meridian Operations';

export function OnboardingProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const [state, setState] = useState<OnboardingState>({
    authMode: 'signup',
    name: '',
    email: '',
    password: '',
    orgName: DEMO_ORG_NAME,
    teamSize: '50–200',
    invites: [{ email: '', role: 'builder' }],
    branding: { ...DEFAULT_BRANDING },
    hasLogo: false,
    whiteLabel: {
      customDomain: 'forms.meridian.co',
      senderEmail: 'noreply@meridian.co',
      removeBadge: true,
    },
  });

  // Adopt the session's org name unless the user has already typed their own.
  const sessionOrgName = session?.orgName;
  useEffect(() => {
    if (!sessionOrgName) return;
    setState((s) =>
      s.orgName === '' || s.orgName === DEMO_ORG_NAME ? { ...s, orgName: sessionOrgName } : s,
    );
  }, [sessionOrgName]);

  const value = useMemo<OnboardingCtx>(() => {
    const patch = (p: Partial<OnboardingState>) => setState((s) => ({ ...s, ...p }));
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
      setBranding: (bp) => setState((s) => ({ ...s, branding: { ...s.branding, ...bp } })),
      setWhiteLabel: (wp) => setState((s) => ({ ...s, whiteLabel: { ...s.whiteLabel, ...wp } })),
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
