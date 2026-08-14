// @vitest-environment jsdom
/**
 * The candidate's live hours readout. The arithmetic lives in @formai/shared
 * (and is tested there); what these pin is that the panel SHOWS every target —
 * overall and per task — with a task never started visible at zero, and that it
 * stays out of the way entirely when there is nothing to meter.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LogbookProgress } from './LogbookProgress.js';

const TASK_MINIMUMS = {
  columnKey: 'task',
  targets: [
    { value: 'Topsoil', minimumHours: 10 },
    { value: 'Gravel', minimumHours: 10 },
    { value: 'Rehabilitation', minimumHours: 10 },
  ],
};

describe('LogbookProgress', () => {
  it('shows the overall total and every task, including one never started', () => {
    const rows = [
      { task: 'Topsoil', duration: 10 },
      { task: 'Gravel', duration: 4 },
    ];
    render(
      <LogbookProgress
        rows={rows}
        taskMinimums={TASK_MINIMUMS}
        durationColumnKey="duration"
        minimumHours={50}
      />,
    );

    // Anchored: "0 / 10 hrs" is a substring of "10 / 10 hrs", so an unanchored
    // matcher would match two rows and throw.
    expect(screen.getByText('Overall')).toBeTruthy();
    expect(screen.getByText(/^14 \/ 50 hrs$/)).toBeTruthy(); // 10 + 4
    expect(screen.getByText(/^10 \/ 10 hrs$/)).toBeTruthy(); // Topsoil
    expect(screen.getByText(/^4 \/ 10 hrs$/)).toBeTruthy(); // Gravel
    // Rehabilitation was never logged — it must still appear, at zero, so the
    // candidate knows to go find that work.
    expect(screen.getByText('Rehabilitation')).toBeTruthy();
    expect(screen.getByText(/^0 \/ 10 hrs$/)).toBeTruthy();
  });

  it('marks only the tasks that have reached their minimum', () => {
    const rows = [
      { task: 'Topsoil', duration: 12 },
      { task: 'Gravel', duration: 4 },
    ];
    render(
      <LogbookProgress
        rows={rows}
        taskMinimums={TASK_MINIMUMS}
        durationColumnKey="duration"
        minimumHours={50}
      />,
    );

    // Topsoil met (12 ≥ 10); Gravel and Rehabilitation not, and overall 16 < 50.
    expect(screen.getAllByLabelText('minimum reached')).toHaveLength(1);
  });

  it('shows overall alone when the part has no per-task targets', () => {
    render(
      <LogbookProgress
        rows={[{ duration: 20 }]}
        taskMinimums={null}
        durationColumnKey="duration"
        minimumHours={50}
      />,
    );

    expect(screen.getByText('Overall')).toBeTruthy();
    expect(screen.getByText(/20 \/ 50 hrs/)).toBeTruthy();
  });

  it('renders nothing without a duration column — it is not a logbook to meter', () => {
    const { container } = render(
      <LogbookProgress rows={[]} taskMinimums={null} durationColumnKey={null} minimumHours={50} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when there is neither an overall nor a per-task target', () => {
    const { container } = render(
      <LogbookProgress
        rows={[{ duration: 5 }]}
        taskMinimums={null}
        durationColumnKey="duration"
        minimumHours={null}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
