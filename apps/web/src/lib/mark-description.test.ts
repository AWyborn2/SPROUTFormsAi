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
    THIS TEST USED TO ASSERT THE OPPOSITE — that a signature box "draws the
    signature". It does not, and cannot: round-trip.ts has no signature branch,
    apps/api/src/pdf contains no image-embedding call at all, and the value is a
    base64 PNG data URL. The renderer falls through to String(value) and stamps
    the raw data URL across the page as one unbreakable line.

    A module whose whole purpose is to stop the panel promising marks the
    exporter does not draw cannot itself promise the one it cannot keep.
  */
  it('refuses to promise a signature the exporter cannot draw', () => {
    const d = markDescription({ type: 'signature' });

    expect(d.mark).not.toBe('the signature');
    expect(d.detail).toMatch(/cannot be drawn|raw image data/i);
  });

  it('warns a reviewer off placing a signature box at all', () => {
    // The actionable half. Without it a reviewer places 5 boxes that each
    // deface a page of the record.
    expect(markSentence({ type: 'signature' })).toMatch(/leave it unplaced/i);
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
