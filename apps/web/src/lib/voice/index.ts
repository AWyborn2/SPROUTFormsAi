/**
 * Voice-to-text — the free, on-device dictation engine plus the pure logic that
 * turns what was heard into a typed answer. No AI key, no audio upload: the
 * model runs in this tab, and only text ever leaves it.
 */
export { coerceSpokenValue, isDictatable } from './coerce.js';
export {
  EMPTY_TRANSCRIPT,
  displayText,
  transcriptReducer,
  type TranscriptAction,
  type TranscriptState,
} from './transcript.js';
export {
  DEFAULT_VOSK_MODEL_URL,
  createRecognizer,
  isVoiceSupported,
  voskModelUrl,
  type CreateRecognizerOptions,
  type Recognizer,
  type VoiceError,
  type VoiceErrorCode,
  type VoiceResult,
} from './vosk-engine.js';
export { useDictation, type Dictation, type DictationStatus, type UseDictationOptions } from './useDictation.js';
