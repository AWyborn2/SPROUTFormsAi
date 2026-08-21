/**
 * Shared tone → token-class maps for the training screens' bars and figures.
 * Both the matrix's compliance band (95/80 thresholds) and the summary's group
 * band (90/85) resolve to the same three tones; the class mapping lives once
 * here so the two screens cannot drift on what a tone looks like.
 */
export type Tone = 'success' | 'warning' | 'danger';

export const TONE_BAR: Record<Tone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

export const TONE_TEXT: Record<Tone, string> = {
  success: 'text-success-text',
  warning: 'text-warning-text',
  danger: 'text-danger-text',
};
