/**
 * Step sequencing for the conversational fill layout — one question per
 * screen, with progress, next/back, and a review before submit.
 *
 * This is the piece that makes `conversational` different in kind from the
 * other layouts: card, hero and split reframe the same single page, while this
 * changes what a respondent is asked at a time. All of the decision logic
 * lives here, pure, because components cannot be rendered in this workspace's
 * test environment — and getting "can I advance past this required field"
 * wrong is a silent data-loss bug, not a cosmetic one.
 */
import type { FormField } from '@formai/shared';

export interface FillStep {
  /** Fields shown together on this screen. */
  fields: FormField[];
  /** Section heading introducing the step, when the form has one. */
  title: string | null;
}

/**
 * Group a field list into steps.
 *
 * Section headers become step boundaries rather than rendered rows: in a
 * one-at-a-time flow a heading is the screen's title, not a thing to scroll
 * past. Fields before any header form an opening step, and consecutive headers
 * do not emit empty screens.
 *
 * Every non-header field lands in exactly one step, which the tests assert —
 * a field silently dropped here is a question the respondent is never asked
 * and a value the org never receives.
 */
export function buildSteps(fields: FormField[]): FillStep[] {
  const steps: FillStep[] = [];
  let current: FillStep = { fields: [], title: null };

  for (const field of fields) {
    if (field.type === 'section_header') {
      if (current.fields.length > 0) steps.push(current);
      current = { fields: [], title: field.label ?? null };
      continue;
    }
    current.fields.push(field);
  }
  if (current.fields.length > 0) steps.push(current);

  return steps;
}

/** Total screens including the review step, used for the progress fraction. */
export function totalScreens(steps: FillStep[]): number {
  return steps.length + 1;
}

/**
 * Progress through the flow as 0..1.
 *
 * The review screen is the only place this reaches 1: showing 100% while a
 * respondent still has to press Submit reads as "already done" and is a real
 * source of abandoned submissions.
 */
export function progressAt(index: number, steps: FillStep[]): number {
  const total = totalScreens(steps);
  if (total <= 1) return 1;
  return Math.min(1, Math.max(0, index / (total - 1)));
}

/** The ids a given step is responsible for. */
export function stepFieldIds(step: FillStep | undefined): string[] {
  return step ? step.fields.map((f) => f.id) : [];
}

/**
 * Which step a validation error belongs to, so a failure surfaced at submit
 * can send the respondent back to the screen that owns it rather than leaving
 * them on a review page with an error they cannot see the cause of.
 */
export function stepIndexForField(steps: FillStep[], fieldId: string): number {
  return steps.findIndex((step) => step.fields.some((f) => f.id === fieldId));
}

/**
 * Required fields on this step that are still empty.
 *
 * Blank strings and empty arrays count as unanswered — a respondent who types
 * a space into a required box has not answered it, and accepting that produces
 * a submission the org has to chase.
 */
export function unansweredRequired(
  step: FillStep | undefined,
  values: Record<string, unknown>,
): string[] {
  if (!step) return [];
  return step.fields
    .filter((f) => f.required && isEmptyValue(values[f.id]))
    .map((f) => f.id);
}

export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** True when the respondent may move on from `index`. */
export function canAdvance(
  steps: FillStep[],
  index: number,
  values: Record<string, unknown>,
): boolean {
  return unansweredRequired(steps[index], values).length === 0;
}
