import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Dialog } from './Dialog.js';

/**
 * Wrapper that mirrors the real-world bug trigger (e.g. `AccountMenu`,
 * `TeamScreen`): `onClose` is a fresh arrow function on every render because
 * it isn't memoized by the caller. Typing into the dialog's child `<input>`
 * drives a parent state update, which re-renders this wrapper and hands the
 * `Dialog` a brand-new `onClose` reference — without touching `open`.
 */
function UnmemoizedOnCloseHarness() {
  const [text, setText] = useState('');
  const [closeCount, setCloseCount] = useState(0);

  return (
    <Dialog
      open
      onClose={() => setCloseCount((n) => n + 1)}
      title="Edit name"
    >
      <input
        aria-label="Name"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <output data-testid="close-count">{closeCount}</output>
    </Dialog>
  );
}

describe('Dialog', () => {
  it('does not steal focus from an input when an unmemoized onClose is recreated on re-render', () => {
    render(<UnmemoizedOnCloseHarness />);

    const input = screen.getByLabelText('Name') as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);

    // Triggers a parent re-render, which creates a new `onClose` reference.
    fireEvent.change(input, { target: { value: 'a' } });

    expect(document.activeElement).toBe(input);
  });

  it('focuses the first focusable element when it opens', () => {
    render(
      <Dialog open onClose={() => {}} title="Welcome">
        <input aria-label="First field" />
      </Dialog>,
    );

    // The header's close ("X") button renders before `children` in the DOM,
    // so it is the first focusable element.
    expect(document.activeElement).toBe(screen.getByLabelText('Close dialog'));
  });

  it('calls the latest onClose reference on Escape, not a stale closure', () => {
    function Harness() {
      const [text, setText] = useState('');
      const [closed, setClosed] = useState<string | null>(null);

      return (
        <Dialog open onClose={() => setClosed(text)} title="Edit">
          <input
            aria-label="Value"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <output data-testid="closed-with">{closed ?? ''}</output>
        </Dialog>
      );
    }

    render(<Harness />);

    const input = screen.getByLabelText('Value');
    fireEvent.change(input, { target: { value: 'latest-value' } });

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.getByTestId('closed-with').textContent).toBe('latest-value');
  });

  it('restores focus to the previously-focused element when the dialog closes', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open dialog</button>
          <Dialog open={open} onClose={() => setOpen(false)} title="Modal">
            <input aria-label="Field" />
          </Dialog>
        </>
      );
    }

    render(<Harness />);

    const trigger = screen.getByText('Open dialog');
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    expect(document.activeElement).not.toBe(trigger);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(document.activeElement).toBe(trigger);
  });

  it('traps Tab focus between the first and last focusable elements', () => {
    render(
      <Dialog open onClose={() => {}} title="Trap">
        <input aria-label="Only field" />
      </Dialog>,
    );

    const closeButton = screen.getByLabelText('Close dialog');
    const field = screen.getByLabelText('Only field');

    // Last focusable element is the input; Tab from it should wrap to first
    // (the close button).
    field.focus();
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(closeButton);

    // Shift+Tab from the first focusable element should wrap to the last.
    closeButton.focus();
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(field);
  });
});
