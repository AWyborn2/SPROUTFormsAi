/**
 * Single source of truth for plan tiers and their feature entitlements.
 * Used by both the API (enforcement middleware) and exported for the frontend
 * to display capabilities without extra round-trips.
 */

export type PlanTier = 'individual' | 'team' | 'business' | 'enterprise';
export type AccountKind = 'individual' | 'team';

export interface PlanFeatures {
  branding: boolean;
  sso: boolean;
  auditExport: boolean;
  competencyGating: boolean;
}

export interface PlanConfig {
  seatLimit: number;
  features: PlanFeatures;
}

export const PLAN_CONFIG: Record<PlanTier, PlanConfig> = {
  individual: {
    seatLimit: 1,
    features: { branding: false, sso: false, auditExport: false, competencyGating: false },
  },
  team: {
    seatLimit: 5,
    features: { branding: false, sso: false, auditExport: false, competencyGating: false },
  },
  business: {
    seatLimit: 15,
    features: { branding: true, sso: false, auditExport: true, competencyGating: false },
  },
  enterprise: {
    seatLimit: 100,
    features: { branding: true, sso: true, auditExport: true, competencyGating: true },
  },
};

export const PLAN_TIERS = Object.keys(PLAN_CONFIG) as PlanTier[];
