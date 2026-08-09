import { describe, expect, it } from 'vitest';
import { NAV_SCREENS, SCREENS, navScreensFor } from './screens.js';

/**
 * The nav's plan gate.
 *
 * The API is the real boundary — every route behind a gated screen carries
 * `requirePlanFeature`, and the profile ones resolve the same rule through
 * `tierCarriesProfiles`. What these fix is the nav ADVERTISING a surface the
 * organisation cannot use, where the click then 403s and reads as a broken
 * product rather than a plan boundary.
 */

/** A Business-tier org: assessments, competency gating and audit export. */
const BUSINESS = { assessments: true, competencyGating: true, auditExport: true };
/** An individual workspace: none of the three. */
const INDIVIDUAL = { assessments: false, competencyGating: false, auditExport: false };

const keys = (screens: { key: string }[]) => screens.map((s) => s.key);

describe('navScreensFor — the plan gate', () => {
  it('hides an assessments screen from an org whose plan does not carry it', () => {
    const shown = keys(navScreensFor('owner', INDIVIDUAL));
    expect(shown).not.toContain('working-list');
    expect(shown).not.toContain('compliance');
    expect(shown).not.toContain('assessments');
    expect(shown).not.toContain('my-profile');
    // Ungated surfaces are untouched — the gate must not empty the nav.
    expect(shown).toContain('dashboard');
    expect(shown).toContain('templates');
    expect(shown).toContain('team');
  });

  it('shows them to an org whose plan does carry it', () => {
    const shown = keys(navScreensFor('owner', BUSINESS));
    expect(shown).toContain('working-list');
    expect(shown).toContain('compliance');
    expect(shown).toContain('assessments');
    expect(shown).toContain('my-profile');
  });

  it('gates each screen on ITS OWN feature, not one blanket flag', () => {
    // A plan with competency gating but no assessments shows one and not the
    // other — which is the configuration the separate flags exist to express.
    const shown = keys(
      navScreensFor('owner', { assessments: false, competencyGating: true, auditExport: false }),
    );
    expect(shown).toContain('competency');
    expect(shown).not.toContain('assessments');
    expect(shown).not.toContain('audit');
  });

  it('HIDES gated entries while the session is still loading', () => {
    /*
      Undefined means not yet known. Hiding is the only reading that never
      advertises a surface the organisation does not hold — an entry that
      appears and then vanishes is worse than one that appears a moment late.
    */
    const loading = keys(navScreensFor('owner', undefined));
    expect(loading).not.toContain('working-list');
    expect(loading).toContain('dashboard');
  });

  it('treats an unresolvable org (null features) the same as loading', () => {
    expect(keys(navScreensFor('owner', null))).not.toContain('compliance');
  });

  it('still applies the access-level floor alongside the feature gate', () => {
    // Both conditions hold independently: a viewer on a carrying plan is kept
    // out of the Admin-only surfaces, and an owner below the tier is kept out
    // of the gated ones.
    const viewerOnBusiness = keys(navScreensFor('viewer', BUSINESS));
    expect(viewerOnBusiness).not.toContain('working-list');
    expect(viewerOnBusiness).toContain('assessments');
  });
});

describe('the registry itself', () => {
  it('names a feature that a plan can actually carry', () => {
    // A typo in `requiresFeature` would hide the screen from EVERY org, silently
    // and forever, because no plan carries the misspelt flag.
    const known = new Set(['assessments', 'competencyGating', 'auditExport', 'branding', 'whiteLabel', 'smartFill', 'sso', 'panelAppeals']);
    for (const screen of SCREENS) {
      if (screen.requiresFeature) expect(known).toContain(screen.requiresFeature);
    }
  });

  it('gates every nav entry whose API refuses below a tier', () => {
    /*
      The list is the point: each of these has a route carrying
      `requirePlanFeature` (or, for the profile pair, `tierCarriesProfiles`).
      A screen added over one of those APIs without a gate here would advertise
      itself to organisations that cannot open it, which is the bug this fixes.
    */
    const mustBeGated = [
      'taxonomy',
      'working-list',
      'compliance',
      'my-profile',
      'audit',
      'competency',
      'assessments',
      'assessment-queue',
    ];
    for (const key of mustBeGated) {
      const screen = NAV_SCREENS.find((s) => s.key === key);
      expect(screen, `${key} is missing from the nav`).toBeDefined();
      expect(screen!.requiresFeature, `${key} has no plan gate`).toBeTruthy();
    }
  });
});
