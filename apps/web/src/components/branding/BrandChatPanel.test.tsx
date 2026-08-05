// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { BrandEditProposal } from '../../lib/data/types.js';

/**
 * Changing a brand by describing the change.
 *
 * APPLY IS A SEPARATE CLICK, and that is the property these tests exist to
 * pin. Not caution for its own sake — the model is guessing at intent from one
 * sentence, and a guess that applied itself would leave the author reversing a
 * change they never asked for, in a settings panel with no undo.
 *
 * The second property is that the panel shows the VALUES, not just the summary
 * sentence. A summary can sound right over a patch that is not, and a swatch is
 * the only part of this an author can check at a glance.
 */

let result: BrandEditProposal | { status: number } = { patch: {}, summary: '', notes: [] };
const editMutate = vi.fn(
  (
    _input: unknown,
    opts: { onSuccess: (r: BrandEditProposal) => void; onError: (e: unknown) => void },
  ) => {
    if ('status' in result) opts.onError(new ApiErrorStub(result.status));
    else opts.onSuccess(result);
  },
);

/** Matches the shape `ApiError` is recognised by — status plus the prototype. */
class ApiErrorStub extends Error {
  status: number;
  constructor(status: number) {
    super('api');
    this.status = status;
  }
}

vi.mock('../../lib/data/api-client.js', () => ({ ApiError: ApiErrorStub }));
vi.mock('../../lib/data/hooks.js', () => ({
  useEditFormBrandByChat: () => ({ mutate: editMutate, isPending: false }),
}));

const { BrandChatPanel } = await import('./BrandChatPanel.js');

function ask(text: string) {
  fireEvent.change(screen.getByLabelText('Describe a change to this brand'), {
    target: { value: text },
  });
  fireEvent.click(screen.getByText('Suggest'));
}

beforeEach(() => {
  result = { patch: {}, summary: '', notes: [] };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('BrandChatPanel', () => {
  it('APPLIES NOTHING UNTIL APPLY IS CLICKED', async () => {
    const onApply = vi.fn();
    result = { patch: { primaryColor: '#0d1a59' }, summary: 'Navy primary.', notes: [] };
    render(<BrandChatPanel brandId="b-1" onApply={onApply} />);
    ask('make it navy');

    expect(await screen.findByText('Navy primary.')).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Apply'));
    expect(onApply).toHaveBeenCalledWith({ primaryColor: '#0d1a59' });
  });

  it('SHOWS THE ACTUAL VALUES, not only the sentence', async () => {
    // A summary can sound right over a patch that is not.
    result = { patch: { primaryColor: '#0d1a59' }, summary: 'Navy primary.', notes: [] };
    render(<BrandChatPanel brandId="b-1" onApply={vi.fn()} />);
    ask('navy');
    expect(await screen.findByText(/primaryColor: #0d1a59/)).toBeTruthy();
  });

  it('flattens a nested theme patch so every value is visible', async () => {
    result = { patch: { theme: { radius: 20 } }, summary: 'Rounder.', notes: [] };
    render(<BrandChatPanel brandId="b-1" onApply={vi.fn()} />);
    ask('rounder');
    expect(await screen.findByText(/theme.radius: 20/)).toBeTruthy();
  });

  it('offers no Apply when nothing survived validation', async () => {
    /*
      The failure this prevents: the author reads a confident summary, clicks
      Apply, sees nothing move, and concludes the preview is broken rather than
      that the request did not land.
    */
    result = { patch: {}, summary: 'Navy headings.', notes: ['#zzz is not a colour.'] };
    render(<BrandChatPanel brandId="b-1" onApply={vi.fn()} />);
    ask('navy');
    expect(await screen.findByText(/Nothing to apply/i)).toBeTruthy();
    expect(screen.queryByText('Apply')).toBeNull();
  });

  it('shows what was refused or could not be done', async () => {
    // "I cannot change the logo" is the most useful thing it can say, and it
    // is the thing this cannot do.
    result = { patch: {}, summary: '', notes: ['I cannot change the logo — upload one instead.'] };
    render(<BrandChatPanel brandId="b-1" onApply={vi.fn()} />);
    ask('use their logo');
    expect(await screen.findByText(/cannot change the logo/i)).toBeTruthy();
  });

  it('clears the proposal after applying, so it cannot be applied twice', async () => {
    const onApply = vi.fn();
    result = { patch: { primaryColor: '#0d1a59' }, summary: 'Navy.', notes: [] };
    render(<BrandChatPanel brandId="b-1" onApply={onApply} />);
    ask('navy');
    fireEvent.click(await screen.findByText('Apply'));
    expect(screen.queryByText('Apply')).toBeNull();
  });

  it('points back at the controls when the feature is not configured', async () => {
    // 422 is a missing API key. The panel is a shortcut, so its absence has to
    // leave the author with the path they already had.
    result = { status: 422 };
    render(<BrandChatPanel brandId="b-1" onApply={vi.fn()} />);
    ask('navy');
    expect((await screen.findByRole('alert')).textContent).toMatch(/controls below still work/i);
  });

  it('does not send an empty instruction', async () => {
    render(<BrandChatPanel brandId="b-1" onApply={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Describe a change to this brand'), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByText('Suggest'));
    expect(editMutate).not.toHaveBeenCalled();
  });
});
