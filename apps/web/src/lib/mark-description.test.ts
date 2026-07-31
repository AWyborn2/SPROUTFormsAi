/**
 * What the review panel promises, against what the exporter actually draws.
 *
 * The panel told a reviewer "a ✓ in its box" for every choice field. That is
 * wrong for the fields that matter most: an auto-marked question gets a RING
 * around the answer chosen, coloured by whether it was right, and an outcome cell
 * gets a tick OR a cross. Someone confirming 229 boxes on the strength of that
 * sentence was confirming them against the wrong picture of the result.
 *
 * These tests are the contract between this copy and `round-trip.ts`. If the
 * renderer's branching changes and this does not, the panel starts lying again —
 * so each case here names the renderer path it describes.
 */
import { describe, expect, it } from 'vitest';
import { markDescription, markSentence } from './mark-description.js';

describe('markDescription', () => {
  it('promises both states for an outcome cell', () => {
    // round-trip.ts: SELF_ANSWERING draws a vector tick or cross from a boolean.
    const d = markDescription({ type: 'check_cross' });

    expect(d.mark).toContain('✓');
    expect(d.mark).toContain('✗');
  });

  it('says which empty cell is the only empty one', () => {
    // A cross used to be indistinguishable from never-assessed on the page. That
    // is fixed; the copy has to stop a reader inferring the old behaviour.
    const d = markDescription({ type: 'check_cross' });

    expect(d.detail).toMatch(/nobody assessed|never|only empty/i);
  });

  it('treats boolean_yes_no the same, because the renderer does', () => {
    expect(markDescription({ type: 'boolean_yes_no' }).mark).toBe(
      markDescription({ type: 'check_cross' }).mark,
    );
  });

  it('names the ring, and what decides between ring and tick', () => {
    const d = markDescription({ type: 'radio', options: ['True', 'False'] });

    expect(d.mark).toContain('✓');
    // The correction that motivated the whole file.
    expect(d.detail).toMatch(/ring/i);
    expect(d.detail).toMatch(/answer key/i);
    expect(d.detail).toMatch(/green/i);
    expect(d.detail).toMatch(/red/i);
  });

  it('says only the answer given is marked', () => {
    // Otherwise a reviewer expects the correct answer to be indicated too, and
    // reads its absence as a bug in the export.
    const d = markDescription({ type: 'checkbox_group', options: ['a', 'b'] });

    expect(d.detail).toMatch(/only the answer given|never the correct/i);
  });

  it('describes a value-printing choice as text, with no ✓ promised', () => {
    // printSelectedValue routes to the scalar text path — no per-option marks.
    const d = markDescription({ type: 'dropdown', options: ['A', 'B'], printSelectedValue: true });

    expect(d.mark).toMatch(/as text/);
    expect(d.mark).not.toContain('✓');
  });

  it('describes a choice with no options as text rather than per-option marks', () => {
    // Nothing to place a per-option box against, so the renderer falls through.
    expect(markDescription({ type: 'radio', options: [] }).mark).toMatch(/as text/);
  });

  it('describes a table as marking the answered column', () => {
    const d = markDescription({ type: 'repeating_group' });

    expect(d.mark).toMatch(/answered column/);
  });

  /*
    THIS PAIR HAS NOW BEEN REWRITTEN TWICE, in opposite directions, and both
    times the copy followed the renderer rather than the other way round.

    It first promised "the signature" when the exporter had no image path at
    all. That was corrected to a warning telling reviewers to leave the box
    unplaced. round-trip.ts now embeds the PNG, so the promise is keepable again
    — and the warning had to go in the same change, because copy telling a
    reviewer to skip the box would leave the signature block empty on every
    certificate.
  */
  it('promises the signature, now that the exporter draws one', () => {
    const d = markDescription({ type: 'signature' });

    expect(d.mark).toMatch(/signature/);
    expect(d.mark).not.toMatch(/nothing usable/i);
  });

  it('no longer tells a reviewer to leave the box unplaced', () => {
    // The actionable half, inverted: the signature block needs that box.
    expect(markSentence({ type: 'signature' })).not.toMatch(/leave it unplaced/i);
  });

  it('says the signature keeps its proportions', () => {
    // A reviewer who does not know this redraws the box when a wide one leaves
    // space around a small signature.
    expect(markDescription({ type: 'signature' }).detail).toMatch(/distort|proportion|scaled/i);
  });

  it('falls back to text for an ordinary field', () => {
    for (const type of ['text', 'date', 'number', 'textarea'] as const) {
      expect(markDescription({ type }).mark).toBe('the value, as text');
    }
  });

  it('never promises a ✓ where the renderer draws text', () => {
    // The class of error this exists to prevent, checked across every type that
    // reaches the scalar text path.
    for (const type of ['text', 'date', 'number', 'textarea'] as const) {
      expect(markDescription({ type }).mark).not.toContain('✓');
    }
  });
});

describe('markSentence', () => {
  it('reads as one sentence plus its condition', () => {
    expect(markSentence({ type: 'text' })).toBe('This box draws the value, as text.');
  });

  it('carries the caveat when there is one', () => {
    const s = markSentence({ type: 'radio', options: ['True', 'False'] });

    expect(s.startsWith('This box draws')).toBe(true);
    expect(s).toMatch(/ring/i);
  });
});
