import { describe, expect, it } from 'vitest';
import {
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  anchoredScrollOffset,
  clampZoom,
  fitWidthZoom,
  formatZoomPercent,
  stepZoom,
} from './pdf-zoom.js';

describe('clampZoom', () => {
  it('passes through in-range values', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(2.5)).toBe(2.5);
  });

  it('clamps to the min/max bounds', () => {
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
    expect(clampZoom(99)).toBe(ZOOM_MAX);
  });

  it('recovers to 1 on invalid input', () => {
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(Infinity)).toBe(1);
    expect(clampZoom(0)).toBe(1);
    expect(clampZoom(-2)).toBe(1);
  });
});

describe('stepZoom', () => {
  it('multiplies by the step when zooming in', () => {
    expect(stepZoom(1, 1)).toBeCloseTo(ZOOM_STEP);
  });

  it('divides by the step when zooming out', () => {
    expect(stepZoom(ZOOM_STEP, -1)).toBeCloseTo(1);
  });

  it('saturates at the bounds', () => {
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
  });

  it('round-trips in/out back to the starting zoom', () => {
    expect(stepZoom(stepZoom(1, 1), -1)).toBeCloseTo(1);
  });
});

describe('fitWidthZoom', () => {
  it('scales the page to exactly fill the container', () => {
    // 612pt US-letter page in a 306px container -> 50%.
    expect(fitWidthZoom(306, 612)).toBeCloseTo(0.5);
  });

  it('clamps extreme fits to the zoom bounds', () => {
    expect(fitWidthZoom(10, 612)).toBe(ZOOM_MIN);
    expect(fitWidthZoom(10_000, 612)).toBe(ZOOM_MAX);
  });

  it('falls back to 1 before measurements exist', () => {
    expect(fitWidthZoom(0, 612)).toBe(1);
    expect(fitWidthZoom(500, 0)).toBe(1);
    expect(fitWidthZoom(NaN, 612)).toBe(1);
  });
});

describe('anchoredScrollOffset', () => {
  it('keeps the anchored content point stationary across a zoom change', () => {
    // Content point at scroll 100 + anchor 50 = 150px. Doubling zoom moves
    // it to 300px; scroll must become 250 so it stays 50px into the viewport.
    expect(anchoredScrollOffset(100, 50, 2)).toBe(250);
  });

  it('is identity at ratio 1', () => {
    expect(anchoredScrollOffset(120, 40, 1)).toBe(120);
  });

  it('never returns a negative offset', () => {
    expect(anchoredScrollOffset(0, 100, 0.5)).toBe(0);
  });
});

describe('formatZoomPercent', () => {
  it('renders a rounded percentage', () => {
    expect(formatZoomPercent(1)).toBe('100%');
    expect(formatZoomPercent(0.666)).toBe('67%');
    expect(formatZoomPercent(1.2 * 1.2)).toBe('144%');
  });
});
