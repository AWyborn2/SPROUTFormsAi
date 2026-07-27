/**
 * Accumulates what the recogniser has heard.
 *
 * Vosk streams a PARTIAL result that is rewritten in place as the utterance
 * firms up, then one FINAL result that closes the utterance. Keeping the two
 * apart is the whole job: a partial must replace the previous partial (it is
 * the same words re-decoded, not new ones), while a final must be appended to
 * everything already committed — a respondent who stops to think and dictates
 * again into the same field is adding a sentence, not starting over.
 */

export interface TranscriptState {
  /** Utterances the recogniser has finalised. Never rewritten. */
  committed: string;
  /** The utterance in flight, replaced wholesale on every partial. */
  partial: string;
}

export type TranscriptAction =
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'reset' };

export const EMPTY_TRANSCRIPT: TranscriptState = { committed: '', partial: '' };

export function transcriptReducer(
  state: TranscriptState,
  action: TranscriptAction,
): TranscriptState {
  switch (action.type) {
    case 'partial':
      return { committed: state.committed, partial: action.text.trim() };
    case 'final': {
      const text = action.text.trim();
      // Silence finalises as an empty result. Appending it would leave a
      // trailing space that then shows up in the coerced value.
      if (text === '') return { committed: state.committed, partial: '' };
      return {
        committed: state.committed === '' ? text : `${state.committed} ${text}`,
        partial: '',
      };
    }
    case 'reset':
      return EMPTY_TRANSCRIPT;
  }
}

/** What the field should show right now — settled words plus the live tail. */
export function displayText(state: TranscriptState): string {
  if (state.partial === '') return state.committed;
  if (state.committed === '') return state.partial;
  return `${state.committed} ${state.partial}`;
}
