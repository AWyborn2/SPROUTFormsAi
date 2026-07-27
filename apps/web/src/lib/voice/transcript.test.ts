/**
 * Transcript accumulation — the partial-replaces / final-appends rule, and the
 * spacing that comes out of it.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_TRANSCRIPT,
  displayText,
  transcriptReducer,
  type TranscriptAction,
  type TranscriptState,
} from './transcript.js';

function run(actions: TranscriptAction[], from: TranscriptState = EMPTY_TRANSCRIPT): TranscriptState {
  return actions.reduce(transcriptReducer, from);
}

describe('transcriptReducer', () => {
  it('replaces the partial rather than appending re-decoded words', () => {
    const state = run([
      { type: 'partial', text: 'the guard' },
      { type: 'partial', text: 'the guard was' },
      { type: 'partial', text: 'the guard was missing' },
    ]);
    expect(state).toEqual({ committed: '', partial: 'the guard was missing' });
  });

  it('commits a final result and clears the partial', () => {
    const state = run([
      { type: 'partial', text: 'the guard was' },
      { type: 'final', text: 'the guard was missing' },
    ]);
    expect(state).toEqual({ committed: 'the guard was missing', partial: '' });
  });

  it('appends a second dictation with exactly one space instead of clobbering', () => {
    const state = run([
      { type: 'final', text: 'the guard was missing' },
      { type: 'partial', text: 'tagged' },
      { type: 'final', text: 'tagged out at ten' },
    ]);
    expect(state.committed).toBe('the guard was missing tagged out at ten');
    expect(state.partial).toBe('');
  });

  it('never leaves doubled or leading spaces when results arrive padded', () => {
    const state = run([
      { type: 'final', text: '  first  ' },
      { type: 'final', text: '  second  ' },
    ]);
    expect(state.committed).toBe('first second');
  });

  it('ignores an empty final so silence does not pad the text', () => {
    const state = run([
      { type: 'final', text: 'checked' },
      { type: 'partial', text: 'um' },
      { type: 'final', text: '   ' },
    ]);
    expect(state).toEqual({ committed: 'checked', partial: '' });
  });

  it('lets an empty partial clear the live tail', () => {
    const state = run([{ type: 'partial', text: 'um' }, { type: 'partial', text: '' }]);
    expect(state.partial).toBe('');
  });

  it('resets to empty from any state', () => {
    const state = run([{ type: 'reset' }], { committed: 'a b', partial: 'c' });
    expect(state).toEqual(EMPTY_TRANSCRIPT);
  });

  it('leaves the previous state untouched', () => {
    const before: TranscriptState = { committed: 'one', partial: 'two' };
    transcriptReducer(before, { type: 'final', text: 'three' });
    expect(before).toEqual({ committed: 'one', partial: 'two' });
  });
});

describe('displayText', () => {
  it('joins committed and partial with a single space', () => {
    expect(displayText({ committed: 'the guard', partial: 'was missing' })).toBe(
      'the guard was missing',
    );
  });

  it('omits the separator when either side is empty', () => {
    expect(displayText({ committed: 'the guard', partial: '' })).toBe('the guard');
    expect(displayText({ committed: '', partial: 'the guard' })).toBe('the guard');
    expect(displayText(EMPTY_TRANSCRIPT)).toBe('');
  });
});
