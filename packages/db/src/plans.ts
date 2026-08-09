/**
 * Single source of truth for plan tiers and their feature entitlements.
 * Used by both the API (enforcement middleware) and exported for the frontend
 * to display capabilities without extra round-trips.
 */

export type PlanTier = 'individual' | 'team' | 'business' | 'enterprise';
export type AccountKind = 'individual' | 'team';

/*
  A TYPE ALIAS rather than an interface, deliberately. Only an alias gets an
  implicit index signature, which is what lets the resolved flags be handed to
  `SessionInfo.features` (declared in shared as a string-keyed boolean record,
  because shared cannot import this package without a cycle) with no cast. An
  interface would force an `as` at that boundary, and an assertion there would
  keep compiling the day a non-boolean field is added here.
*/
export type PlanFeatures = {
  /** Custom branding (logo, colors, fonts) on forms. Free at every tier. */
  branding: boolean;
  /** Remove "Powered by" attribution / full white-label. Business+ only. */
  whiteLabel: boolean;
  /**
   * Smart Fill — AI mapping of a spoken transcript onto many fields at once.
   * Business+ only. Gates the AI step alone: on-device dictation into a single
   * field is free at every tier and never checks this.
   */
  smartFill: boolean;
  sso: boolean;
  auditExport: boolean;
  /**
   * Competency records, gating rules, and the prerequisite / assessor-eligibility
   * checks that read them. Business+ — it moved down a tier when multi-part
   * assessments shipped, because assessor eligibility per machine depends on it
   * and assessments start at Business. The revenue it used to reserve for
   * Enterprise is recaptured by the candidate seat allowance instead.
   */
  competencyGating: boolean;
  /** Multi-part assessment cases. Business+. */
  assessments: boolean;
  /**
   * Panel review of a disputed outcome. Enterprise only — the
   * independent-assessor arm of an appeal is a linked re-assessment case and
   * ships at Business; modelling a panel's membership and per-member verdicts
   * does not.
   */
  panelAppeals: boolean;
}

export interface PlanConfig {
  /**
   * Staff seats — everyone except candidates. See `candidateSeatLimit` for why
   * they are counted apart.
   */
  seatLimit: number;
  /**
   * Candidates the org may enrol, or `null` for unlimited.
   *
   * Counted separately from staff because the two scale independently: a site
   * with 15 trainers may assess several hundred operators, so charging
   * candidates against the staff limit would exhaust every tier at one site.
   * `0` means the tier cannot enrol candidates at all.
   */
  candidateSeatLimit: number | null;
  features: PlanFeatures;
}

export const PLAN_CONFIG: Record<PlanTier, PlanConfig> = {
  individual: {
    seatLimit: 1,
    candidateSeatLimit: 0,
    features: {
      branding: true,
      whiteLabel: false,
      smartFill: false,
      sso: false,
      auditExport: false,
      competencyGating: false,
      assessments: false,
      panelAppeals: false,
    },
  },
  team: {
    seatLimit: 5,
    candidateSeatLimit: 0,
    features: {
      branding: true,
      whiteLabel: false,
      smartFill: false,
      sso: false,
      auditExport: false,
      competencyGating: false,
      assessments: false,
      panelAppeals: false,
    },
  },
  business: {
    seatLimit: 15,
    candidateSeatLimit: 200,
    features: {
      branding: true,
      whiteLabel: true,
      smartFill: true,
      sso: false,
      auditExport: true,
      competencyGating: true,
      assessments: true,
      panelAppeals: false,
    },
  },
  enterprise: {
    seatLimit: 100,
    candidateSeatLimit: null,
    features: {
      branding: true,
      whiteLabel: true,
      smartFill: true,
      sso: true,
      auditExport: true,
      competencyGating: true,
      assessments: true,
      panelAppeals: true,
    },
  },
};

export const PLAN_TIERS = Object.keys(PLAN_CONFIG) as PlanTier[];
