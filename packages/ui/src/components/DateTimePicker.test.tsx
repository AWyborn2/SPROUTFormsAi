import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTimePicker } from './DateTimePicker.js';

/**
 * Fixed clock, chosen ≠ the old hardcoded anchor. The component previously
 * shipped a literal `2026-07-15` as "today", so the today-highlight and the
 * month an empty picker opened on were wrong on every other day — these tests
 * hold the component to the real clock.
 */
const NOW = new Date('2026-03-10T09:00:00');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function openPicker() {
  fireEvent.click(screen.getByRole('button', { name: /select a date/i }));
}

describe('DateTimePicker', () => {
  it('opens an empty picker on the REAL current month, not a hardcoded anchor', () => {
    render(<DateTimePicker onChange={() => {}} />);
    openPicker();
    expect((screen.getByLabelText('Month') as HTMLSelectElement).value).toBe('2'); // March
    expect((screen.getByLabelText('Year') as HTMLSelectElement).value).toBe('2026');
  });

  it('jumps decades in one interaction via the year select — the DOB case', () => {
    const onChange = vi.fn();
    render(<DateTimePicker onChange={onChange} />);
    openPicker();

    fireEvent.change(screen.getByLabelText('Year'), { target: { value: '1990' } });
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '5' } }); // June
    fireEvent.click(screen.getByRole('button', { name: '14' }));

    expect(onChange).toHaveBeenCalledWith('1990-06-14');
  });

  it('offers years far enough back for any date of birth', () => {
    render(<DateTimePicker onChange={() => {}} />);
    openPicker();
    const years = [...(screen.getByLabelText('Year') as HTMLSelectElement).options].map(
      (o) => o.value,
    );
    expect(years).toContain('1900');
    // …and forward for a licence expiry.
    expect(years).toContain(String(NOW.getFullYear() + 10));
  });

  it('clamps a day focus that does not exist in the jumped-to month', () => {
    // 31 January selected, then jump to February: there is no 31st to keep the
    // roving tabindex on, and no day button beyond 28 may render.
    render(<DateTimePicker value="2026-01-31" onChange={() => {}} />);
    // With a value the trigger shows the date, not the placeholder.
    fireEvent.click(screen.getByRole('button', { name: /31 Jan 2026/i }));
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '1' } }); // February
    expect(screen.queryByRole('button', { name: '31' })).toBeNull();
    expect(screen.getByRole('button', { name: '28' })).toBeTruthy();
  });

  it('keeps the chevrons working alongside the selects', () => {
    render(<DateTimePicker onChange={() => {}} />);
    openPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect((screen.getByLabelText('Month') as HTMLSelectElement).value).toBe('1'); // February
  });
});
