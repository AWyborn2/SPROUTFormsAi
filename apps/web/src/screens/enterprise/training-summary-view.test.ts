import { describe, expect, it } from 'vitest';
import type {
  TrainingSummaryTrendPoint,
  TrainingSummaryWeek,
} from '../../lib/data/types.js';
import {
  DONUT_CIRCUMFERENCE,
  MIN_BAR_PCT,
  compliancePct,
  donutDash,
  gapDeltaChip,
  groupBand,
  groupBars,
  scopeLabel,
  signOffDeltaChip,
  topGapsBars,
  trendGeometry,
  weeklyBars,
} from './training-summary-view.js';

const point = (
  capturedOn: string,
  over: Partial<TrainingSummaryTrendPoint> = {},
): TrainingSummaryTrendPoint => ({
  capturedOn,
  compliantCount: 60,
  memberCount: 80,
  requiredGapCount: 20,
  ...over,
});

describe('compliancePct', () => {
  it('reads 0/0 as 0%, never NaN', () => {
    expect(compliancePct(0, 0)).toBe(0);
    expect(Number.isNaN(compliancePct(0, 0))).toBe(false);
  });

  it('rounds an ordinary ratio', () => {
    expect(compliancePct(76, 87)).toBe(87);
    expect(compliancePct(87, 87)).toBe(100);
  });
});

describe('donutDash', () => {
  it('fills nothing at 0%', () => {
    expect(donutDash(0)).toBe(`0.00 ${DONUT_CIRCUMFERENCE.toFixed(2)}`);
  });

  it('fills 87% of the circumference at 87%', () => {
    const filled = (87 / 100) * DONUT_CIRCUMFERENCE;
    expect(donutDash(87)).toBe(`${filled.toFixed(2)} ${DONUT_CIRCUMFERENCE.toFixed(2)}`);
  });

  it('fills the whole ring at 100%', () => {
    expect(donutDash(100)).toBe(
      `${DONUT_CIRCUMFERENCE.toFixed(2)} ${DONUT_CIRCUMFERENCE.toFixed(2)}`,
    );
  });

  it('renders a 0-member scope (pct 0) as an empty ring, not NaN', () => {
    expect(donutDash(compliancePct(0, 0))).toBe(`0.00 ${DONUT_CIRCUMFERENCE.toFixed(2)}`);
  });
});

describe('trendGeometry', () => {
  it('flags an empty snapshot record rather than drawing a chart of nothing', () => {
    expect(trendGeometry([], 560, 160)).toEqual({ empty: true });
  });

  it('yields a dot and no paths for a single snapshot', () => {
    const geo = trendGeometry([point('2026-08-19', { compliantCount: 40, memberCount: 80 })], 560, 160);
    expect(geo.empty).toBe(false);
    if (geo.empty) return;
    expect(geo.line).toBe('');
    expect(geo.area).toBe('');
    // 50% compliance sits at half height; the dot sits at the "today" edge.
    expect(geo.dot).toEqual({ x: 560, y: 80 });
    expect(geo.latestPct).toBe(50);
  });

  it('draws a line spanning the full width, positioned by capture date', () => {
    const geo = trendGeometry(
      [
        point('2026-08-01', { compliantCount: 0, memberCount: 80 }),
        point('2026-08-11', { compliantCount: 40, memberCount: 80 }),
        point('2026-08-21', { compliantCount: 80, memberCount: 80 }),
      ],
      100,
      100,
    );
    expect(geo.empty).toBe(false);
    if (geo.empty) return;
    // 0% → bottom-left, 50% mid, 100% → top-right; equal date spacing.
    expect(geo.line).toBe('M0 100 L50 50 L100 0');
    expect(geo.area).toBe('M0 100 L50 50 L100 0 L100 100 L0 100 Z');
    expect(geo.dot).toEqual({ x: 100, y: 0 });
    expect(geo.latestPct).toBe(100);
  });

  it('stretches x over a gap in the record instead of pretending the days exist', () => {
    const geo = trendGeometry(
      [
        point('2026-08-01'),
        point('2026-08-02'),
        // eight missed days
        point('2026-08-11'),
      ],
      100,
      100,
    );
    expect(geo.empty).toBe(false);
    if (geo.empty) return;
    // Day 2 of 10 sits at 10% of the width, not a third of it.
    expect(geo.line.startsWith('M0 ')).toBe(true);
    expect(geo.line).toContain('L10 ');
    expect(geo.line).toContain('L100 ');
  });
});

describe('weeklyBars', () => {
  // The recurring fixture: 8 ISO weeks, quiet start, busy middle, week-to-date last.
  const weeks: TrainingSummaryWeek[] = [
    { weekStart: '2026-06-29', count: 2 },
    { weekStart: '2026-07-06', count: 0 },
    { weekStart: '2026-07-13', count: 8 },
    { weekStart: '2026-07-20', count: 5 },
    { weekStart: '2026-07-27', count: 4 },
    { weekStart: '2026-08-03', count: 6 },
    { weekStart: '2026-08-10', count: 4 },
    { weekStart: '2026-08-17', count: 1, currentWeek: true },
  ];

  it('labels W1..W7 in order and the current week as "now"', () => {
    expect(weeklyBars(weeks).map((b) => b.label)).toEqual([
      'W1',
      'W2',
      'W3',
      'W4',
      'W5',
      'W6',
      'W7',
      'now',
    ]);
  });

  it('normalises heights to the busiest week and floors a zero week', () => {
    const bars = weeklyBars(weeks);
    expect(bars[2]!.heightPct).toBe(100); // count 8 = max
    expect(bars[3]!.heightPct).toBe(63); // 5/8
    expect(bars[1]!.heightPct).toBe(MIN_BAR_PCT); // 0 still draws a sliver
    expect(bars[7]!.current).toBe(true);
  });

  it('floors every bar when all weeks are zero', () => {
    const flat = weeks.map((w) => ({ ...w, count: 0 }));
    for (const bar of weeklyBars(flat)) expect(bar.heightPct).toBe(MIN_BAR_PCT);
  });

  it('signs the week-over-week delta from the fixture (1 now vs 4 last week)', () => {
    const current = weeks[7]!.count;
    const prior = weeks[6]!.count;
    expect(signOffDeltaChip(current, prior)).toEqual({ text: '▼ 3 vs last wk', tone: 'danger' });
    expect(signOffDeltaChip(prior, current)).toEqual({ text: '▲ 3 vs last wk', tone: 'success' });
    expect(signOffDeltaChip(4, 4)).toBeNull();
  });
});

describe('gapDeltaChip', () => {
  it('shows nothing while no month-old snapshot exists', () => {
    expect(gapDeltaChip(null)).toBeNull();
  });

  it('wears success when gaps FELL', () => {
    expect(gapDeltaChip(-7)).toEqual({ text: '▼ 7 vs 30d ago', tone: 'success' });
  });

  it('wears danger when gaps grew', () => {
    expect(gapDeltaChip(3)).toEqual({ text: '▲ 3 vs 30d ago', tone: 'danger' });
  });

  it('shows nothing at zero movement', () => {
    expect(gapDeltaChip(0)).toBeNull();
  });
});

describe('topGapsBars', () => {
  it('takes the top 6 by count with ties stable by name', () => {
    const bars = topGapsBars([
      { competencyId: 'c1', name: 'Working at Heights', count: 9 },
      { competencyId: 'c2', name: 'Confined Space', count: 4 },
      { competencyId: 'c3', name: 'Dozer', count: 4 },
      { competencyId: 'c4', name: 'First Aid', count: 12 },
      { competencyId: 'c5', name: 'Excavator', count: 4 },
      { competencyId: 'c6', name: 'HR Licence', count: 2 },
      { competencyId: 'c7', name: 'White Card', count: 1 },
    ]);
    expect(bars.map((b) => b.name)).toEqual([
      'First Aid',
      'Working at Heights',
      'Confined Space',
      'Dozer',
      'Excavator',
      'HR Licence',
    ]);
    expect(bars[0]!.widthPct).toBe(100);
    expect(bars[1]!.widthPct).toBe(75);
  });

  it('handles an empty list', () => {
    expect(topGapsBars([])).toEqual([]);
  });
});

describe('groupBars and groupBand', () => {
  it('bands ≥90 success, ≥85 warning, else danger', () => {
    expect(groupBand(100)).toBe('success');
    expect(groupBand(90)).toBe('success');
    expect(groupBand(89)).toBe('warning');
    expect(groupBand(85)).toBe('warning');
    expect(groupBand(84)).toBe('danger');
    expect(groupBand(0)).toBe('danger');
  });

  it('derives per-group %, sorts % desc with name ties stable, and 0/0 reads 0%', () => {
    const bars = groupBars([
      { id: 'g1', name: 'Operations', memberCount: 20, compliantCount: 17 }, // 85
      { id: 'g2', name: 'Maintenance', memberCount: 10, compliantCount: 10 }, // 100
      { id: 'g3', name: 'Admin', memberCount: 0, compliantCount: 0 }, // empty group
      { id: 'g4', name: 'Drill & Blast', memberCount: 20, compliantCount: 17 }, // 85, ties with Operations
    ]);
    expect(bars.map((b) => b.name)).toEqual([
      'Maintenance',
      'Drill & Blast',
      'Operations',
      'Admin',
    ]);
    expect(bars.map((b) => b.pct)).toEqual([100, 85, 85, 0]);
    expect(bars.map((b) => b.band)).toEqual(['success', 'warning', 'warning', 'danger']);
  });
});

describe('scopeLabel', () => {
  it('names the scope, and org reads org-wide', () => {
    expect(scopeLabel({ type: 'org' })).toBe('Org-wide');
    expect(scopeLabel({ type: 'location', id: 'l1', name: 'Boddington' })).toBe('Boddington');
  });
});
