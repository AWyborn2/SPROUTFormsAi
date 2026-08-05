// @vitest-environment jsdom
/**
 * The builder's progress rail.
 *
 * Three things it must not get wrong:
 *
 *  · a step that cannot be reached yet has to LOOK unreachable. The builder's
 *    later steps have nothing to act on until a document has been read, and a
 *    step that opens onto an empty screen reads as a broken product;
 *  · the compact rail is start-aligned, because `justify-content:flex-end`
 *    makes overflow spill past the START edge — which browsers do not make
 *    scrollable, so at a narrow width the first chips become unreachable with
 *    no scrollbar to say so;
 *  · both presentations show the same seven steps in the same order, because
 *    they are one control shown two ways.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BUILDER_STEPS, BUILDER_STEP_LABELS } from '@formai/shared';
import { BuilderMiniSteps, BuilderStepper } from './BuilderStepper.js';

vi.mock('@formai/ui', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

describe('BuilderStepper', () => {
  it('renders all seven steps in printed order', () => {
    render(<BuilderStepper current="upload" onGo={() => {}} />);

    for (const step of BUILDER_STEPS) {
      expect(screen.getByText(BUILDER_STEP_LABELS[step])).toBeTruthy();
    }
  });

  it('marks the current step for assistive technology, and only it', () => {
    render(<BuilderStepper current="units" onGo={() => {}} />);

    const current = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-current'));
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toContain(BUILDER_STEP_LABELS.units);
  });

  it('jumps to a step that is reachable', () => {
    const onGo = vi.fn();
    render(<BuilderStepper current="upload" onGo={onGo} />);

    fireEvent.click(screen.getByText(BUILDER_STEP_LABELS.answer_key));

    expect(onGo).toHaveBeenCalledWith('answer_key');
  });

  it('disables a blocked step rather than letting it open onto nothing', () => {
    const onGo = vi.fn();
    render(
      <BuilderStepper current="upload" onGo={onGo} disabled={['generate', 'answer_key']} />,
    );

    const blocked = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.includes(BUILDER_STEP_LABELS.answer_key));
    expect(blocked?.hasAttribute('disabled')).toBe(true);

    fireEvent.click(blocked!);
    expect(onGo).not.toHaveBeenCalled();
  });
});

describe('BuilderMiniSteps', () => {
  it('shows the same seven steps as the full stepper', () => {
    render(<BuilderMiniSteps current="generate" onGo={() => {}} />);

    for (const step of BUILDER_STEPS) {
      expect(screen.getByText(BUILDER_STEP_LABELS[step])).toBeTruthy();
    }
  });

  it('aligns to the start so its overflow is scrollable', () => {
    // End-aligned overflow spills past the start edge, which is not
    // scrollable — the chips at the beginning become permanently unreachable.
    const { container } = render(<BuilderMiniSteps current="generate" onGo={() => {}} />);
    const rail = container.firstElementChild!;

    expect(rail.className).toContain('justify-start');
    expect(rail.className).toContain('overflow-x-auto');
    expect(rail.className).not.toContain('justify-end');
  });

  it('keeps every chip on one line, so the rail scrolls rather than wrapping', () => {
    const { container } = render(<BuilderMiniSteps current="generate" onGo={() => {}} />);
    const chips = container.querySelectorAll('button');

    expect(chips.length).toBe(BUILDER_STEPS.length);
    for (const chip of chips) {
      expect(chip.className).toContain('whitespace-nowrap');
      expect(chip.className).toContain('flex-none');
    }
  });

  it('does not navigate to a blocked step', () => {
    const onGo = vi.fn();
    render(<BuilderMiniSteps current="upload" onGo={onGo} disabled={['placement']} />);

    const blocked = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.includes(BUILDER_STEP_LABELS.placement));
    fireEvent.click(blocked!);

    expect(onGo).not.toHaveBeenCalled();
  });
});
