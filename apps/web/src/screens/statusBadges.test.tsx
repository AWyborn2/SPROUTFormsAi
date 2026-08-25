// @vitest-environment jsdom
/**
 * The case list's Status cell.
 *
 * Beyond "passed or not", an assessor scanning the list needs two things the
 * bare state badge never showed: which part a case is on, and whether it is
 * their turn. These defend both, and that the "needs assessor" flag is not
 * repeated when the badge already says the case is awaiting sign-off.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CaseStatusCell } from './statusBadges.js';

describe('CaseStatusCell', () => {
  it('names the current stage while a case is in progress', () => {
    render(
      <CaseStatusCell
        state="open"
        awaitingAssessor={false}
        currentPartLabel="Direct Observation Log"
        currentPartIndex={3}
        requiredPartCount={6}
      />,
    );
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.getByText('Part 3 of 6 · Direct Observation Log')).toBeTruthy();
    expect(screen.queryByText('Needs assessor')).toBeNull();
  });

  it('flags a case waiting on the assessor to mark a handed-in part', () => {
    render(
      <CaseStatusCell
        state="open"
        awaitingAssessor={true}
        currentPartLabel="Part 2 - Practical demonstration"
        currentPartIndex={2}
        requiredPartCount={6}
      />,
    );
    expect(screen.getByText('Needs assessor')).toBeTruthy();
    expect(screen.getByText('Part 2 of 6 · Part 2 - Practical demonstration')).toBeTruthy();
  });

  it('does not repeat the flag when the badge already says awaiting sign-off', () => {
    render(
      <CaseStatusCell
        state="awaiting_sign_off"
        awaitingAssessor={true}
        currentPartLabel={null}
        currentPartIndex={null}
        requiredPartCount={6}
      />,
    );
    expect(screen.getByText('Awaiting assessor sign-off')).toBeTruthy();
    expect(screen.queryByText('Needs assessor')).toBeNull();
  });

  it('shows no stage line for a finished case', () => {
    render(
      <CaseStatusCell
        state="competent"
        awaitingAssessor={false}
        currentPartLabel={null}
        currentPartIndex={null}
        requiredPartCount={6}
      />,
    );
    expect(screen.getByText('Competent')).toBeTruthy();
    expect(screen.queryByText(/Part \d/)).toBeNull();
  });
});
