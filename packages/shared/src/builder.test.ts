/**
 * The builder's vocabulary carries two properties the rest of the product
 * depends on, and both are easy to break silently:
 *
 *  1. An absent `MarkStyle` means "whatever the field type already draws", so
 *     hundreds of placements authored before it existed keep exporting
 *     identically. Nothing here may give it a default.
 *  2. A span is clamped on READ, never on write, so narrowing a section from
 *     three columns to two and widening it back restores what the author set
 *     rather than what the narrow view could show.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILDER_NEXT_LABELS,
  BUILDER_STEPS,
  BUILDER_STEP_LABELS,
  DEFAULT_SETUP_ANSWERS,
  GLYPH_LABELS,
  MARK_STYLES_DRAWN,
  emptyDraftState,
  isGlyphDrawn,
  resolveBuilderStep,
  resolveSpan,
  stepIndex,
  type SectionColumns,
} from './builder.js';
import { GLYPH_KINDS } from './form-field.js';

describe('builder steps', () => {
  it('has the steps the stepper renders, in order', () => {
    expect(BUILDER_STEPS).toEqual([
      'upload',
      'generate',
      'units',
      'answer_key',
      'placement',
      'workflow',
    ]);
  });

  it('labels every step, and gives every step a next action', () => {
    // A step with no label renders blank in the stepper; one with no next
    // label renders a button that says nothing about what it does.
    for (const step of BUILDER_STEPS) {
      expect(BUILDER_STEP_LABELS[step]).toBeTruthy();
      expect(BUILDER_NEXT_LABELS[step]).toBeTruthy();
    }
  });

  it('indexes steps by position', () => {
    expect(stepIndex('upload')).toBe(0);
    expect(stepIndex('workflow')).toBe(BUILDER_STEPS.length - 1);
  });

  /*
    A RETIRED STEP MUST NOT STRAND A SAVED DRAFT.

    `step` is validated on the way into the database and read back to decide
    which screen opens. `design` was retired once its two jobs landed elsewhere
    — field correction into Generate, colours and logo into client brands — and
    a draft parked on it would otherwise fail that validation and take an
    author's whole saved state with it.
  */
  it('resumes a retired step on the one that absorbed it', () => {
    expect(resolveBuilderStep('design')).toBe('generate');
  });

  it('passes a live step through unchanged', () => {
    for (const step of BUILDER_STEPS) expect(resolveBuilderStep(step)).toBe(step);
  });

  it('falls back to upload for nothing, and for a step nobody has heard of', () => {
    /*
      Absent is a new draft. A value naming no step that ever existed is a
      client bug — and the SAVE route refuses that outright, so this fallback is
      the defensive read for a row already in the database rather than a licence
      to store nonsense.
    */
    expect(resolveBuilderStep(undefined)).toBe('upload');
    expect(resolveBuilderStep('')).toBe('upload');
    expect(resolveBuilderStep('teleport')).toBe('upload');
  });
});

describe('resolveSpan', () => {
  it('defaults to one column', () => {
    expect(resolveSpan({ id: 'f1' }, 3)).toBe(1);
  });

  it('passes a span that fits through unchanged', () => {
    expect(resolveSpan({ id: 'f1', span: 2 }, 3)).toBe(2);
    expect(resolveSpan({ id: 'f1', span: 3 }, 3)).toBe(3);
  });

  it('clamps a span wider than its section, without rewriting it', () => {
    // The stored span stays 3. A section narrowed to 2 renders it as 2, and
    // widening the section back restores the author's 3 — which is why the
    // clamp is here and not in the writer.
    const field = { id: 'f1', span: 3 as SectionColumns };

    expect(resolveSpan(field, 2)).toBe(2);
    expect(field.span).toBe(3);
    expect(resolveSpan(field, 3)).toBe(3);
  });

  it('clamps to one in a single-column section', () => {
    expect(resolveSpan({ id: 'f1', span: 3 }, 1)).toBe(1);
  });
});

describe('mark styles', () => {
  it('labels every glyph the builder offers', () => {
    for (const glyph of GLYPH_KINDS) expect(GLYPH_LABELS[glyph]).toBeTruthy();
  });

  it('claims EVERY glyph draws, because every one now does', () => {
    /*
      There is no longer an authorable-but-ignored tier. The exporter's
      `DRAWN_BY_GLYPH` is a total `Record<GlyphKind, DrawnGlyph>`, so a glyph
      added without a renderer fails to compile there — a stronger guard than
      this list ever was, and the reason this list can now be derived.
    */
    expect([...MARK_STYLES_DRAWN].sort()).toEqual([...GLYPH_KINDS].sort());
    for (const glyph of GLYPH_KINDS) expect(isGlyphDrawn(glyph)).toBe(true);
  });

  it('lists no glyph it does not also define', () => {
    for (const glyph of MARK_STYLES_DRAWN) expect(GLYPH_KINDS).toContain(glyph);
  });
});

describe('emptyDraftState', () => {
  it('starts on upload with nothing read yet', () => {
    const draft = emptyDraftState();

    expect(draft.step).toBe('upload');
    expect(draft.extraction).toBeNull();
    expect(draft.fields).toEqual([]);
    expect(draft.manifest).toBeNull();
    expect(draft.workflow).toBeNull();
  });

  it('does not share the default setup answers between drafts', () => {
    // A shared array would let one draft's pathway edit reach every other
    // draft created in the same process.
    const a = emptyDraftState();
    const b = emptyDraftState();
    a.setup.pathways.push('rpl');

    expect(b.setup.pathways).toEqual(DEFAULT_SETUP_ANSWERS.pathways);
    expect(DEFAULT_SETUP_ANSWERS.pathways).not.toContain('rpl_duplicate');
  });

  it('defaults to the pass rule marking actually implements', () => {
    // `overall_percentage` is offered so an author can record that intent, but
    // `markTheory` gates on the mandatory set — defaulting to the unimplemented
    // rule would silently mark every tool by a rule it does not use.
    expect(DEFAULT_SETUP_ANSWERS.passRule).toBe('mandatory_all_correct');
  });

  it('defaults a logbook threshold to notifying, never blocking', () => {
    expect(DEFAULT_SETUP_ANSWERS.thresholdBehaviour).toBe('notify');
  });
});
