// @vitest-environment jsdom
/**
 * The one screen where expiry is SET.
 *
 * Everything else about expiry is derived — how long a competency stays valid
 * is the single stored fact the whole feature rests on, and it applies to every
 * grant of that competency at once. So the two things worth pinning here are
 * that blank means perpetual (not zero, not "expires today"), and that a
 * competency with no validity says so plainly rather than showing nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Competency } from '../../lib/data/types.js';

const competencies: { data: Competency[] } = { data: [] };
const setValidityMutate = vi.fn();

vi.mock('../../lib/data/hooks.js', () => ({
  useForms: () => ({ data: [] }),
  useCompetencies: () => competencies,
  useCompetencyRules: () => ({ data: [] }),
  useAddRule: () => ({ mutate: vi.fn() }),
  useToggleRule: () => ({ mutate: vi.fn() }),
  useRemoveRule: () => ({ mutate: vi.fn() }),
  useSetCompetencyValidity: () => ({ mutate: setValidityMutate, isPending: false }),
}));

const toast = vi.fn();
vi.mock('@formai/ui', async () => {
  const actual = await vi.importActual<typeof import('@formai/ui')>('@formai/ui');
  return { ...actual, useToast: () => ({ toast }) };
});

const { CompetencyScreen } = await import('./CompetencyScreen.js');

const TRACK_DOZER: Competency = {
  id: 'c1',
  name: 'ATO - Track Dozer',
  code: 'Q34666893',
  holders: 12,
  validForMonths: null,
  gracePeriodDays: null,
  color: 'var(--accent)',
};

/** Open the inline validity editor for the first competency in the list. */
function openEditor(name = TRACK_DOZER.name) {
  fireEvent.click(screen.getByLabelText(`Set how long ${name} stays valid`));
}

afterEach(() => {
  vi.clearAllMocks();
  competencies.data = [];
});

describe('CompetencyScreen validity', () => {
  it('says a competency with no validity never expires', () => {
    competencies.data = [TRACK_DOZER];
    render(<CompetencyScreen />);

    expect(screen.getByText('Never expires')).toBeDefined();
  });

  it('shows a set validity in years, with its grace period', () => {
    competencies.data = [{ ...TRACK_DOZER, validForMonths: 36, gracePeriodDays: 90 }];
    render(<CompetencyScreen />);

    expect(screen.getByText('3 years · 90 day grace')).toBeDefined();
  });

  it('saves years as months', () => {
    // The column is months; the industry says years. The conversion belongs
    // here rather than in anyone's head.
    competencies.data = [TRACK_DOZER];
    render(<CompetencyScreen />);
    openEditor();

    fireEvent.change(screen.getByLabelText('Valid for (years)'), { target: { value: '3' } });
    fireEvent.click(screen.getByText('Save'));

    expect(setValidityMutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', validForMonths: 36 }),
      expect.anything(),
    );
  });

  it('treats a blank period as perpetual, not as zero', () => {
    // Clearing the field is how an admin says "this stops expiring". Reading it
    // as 0 would lapse every holder at once.
    competencies.data = [{ ...TRACK_DOZER, validForMonths: 36, gracePeriodDays: 90 }];
    render(<CompetencyScreen />);
    openEditor();

    fireEvent.change(screen.getByLabelText('Valid for (years)'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));

    expect(setValidityMutate).toHaveBeenCalledWith(
      expect.objectContaining({ validForMonths: null, gracePeriodDays: null }),
      expect.anything(),
    );
  });

  it('refuses a period that is not a whole number of years', () => {
    competencies.data = [TRACK_DOZER];
    render(<CompetencyScreen />);
    openEditor();

    fireEvent.change(screen.getByLabelText('Valid for (years)'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByText('Save'));

    expect(setValidityMutate).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'warning' }));
  });

  it('warns before saving that this reaches everyone who already holds it', () => {
    // Expiry counts from each person's own grant date, so setting a validity is
    // retroactive by design. An admin has to see that before pressing save.
    competencies.data = [TRACK_DOZER];
    render(<CompetencyScreen />);
    openEditor();

    expect(screen.getByText(/already holds it/)).toBeDefined();
  });
});
