/**
 * Competency gating (Should-tier). Links a form section to a required
 * competency, gating that section's visibility.
 */

export interface Competency {
  id: string;
  orgId: string;
  name: string;
  /** Nationally-recognised code, e.g. "RIIWHS204E". */
  code: string;
  holders: number;
}

export interface CompetencyRule {
  id: string;
  orgId: string;
  templateId: string;
  /** Human reference to the gated section, e.g. "Roof & height access items". */
  sectionRef: string;
  competencyId: string;
  enabled: boolean;
}
