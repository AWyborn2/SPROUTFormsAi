/**
 * Binds the Vosk engine to the transcript reducer for one field's mic button.
 *
 * Deliberately thin: the reducer decides what the text IS and `coerce.ts`
 * decides what it MEANS, so all this adds is lifecycle — and the lifecycle is
 * the part that can hurt someone. A recogniser that outlives its component
 * leaves the browser's recording indicator lit on a form the respondent thinks
 * they closed, which is a trust problem long before it is a memory leak.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EMPTY_TRANSCRIPT,
  displayText,
  transcriptReducer,
  type TranscriptAction,
  type TranscriptState,
} from './transcript.js';
import {
  createRecognizer,
  isVoiceSupported,
  type Recognizer,
  type VoiceError,
} from './vosk-engine.js';

export type DictationStatus = 'idle' | 'loading' | 'listening' | 'error';

export interface UseDictationOptions {
  /**
   * Called on each stop with EVERYTHING heard since the last `reset` — dictating
   * twice into one field appends, so the caller can treat this as the field's
   * new value rather than diffing sessions. Dictation never writes a field or
   * submits on its own; the caller decides.
   */
  onResult?: (text: string) => void;
  /** Requested mic sample rate; the engine reconciles it with what the device grants. */
  sampleRate?: number;
}

export interface Dictation {
  /** False without WASM, getUserMedia or AudioContext — hide the mic entirely rather than showing a dead one. */
  supported: boolean;
  status: DictationStatus;
  /** Committed text plus the live partial, for showing what is being heard. */
  text: string;
  error: VoiceError | null;
  start: () => void;
  stop: () => void;
  reset: () => void;
}

export function useDictation(options: UseDictationOptions = {}): Dictation {
  const { onResult, sampleRate } = options;

  const [transcript, setTranscript] = useState<TranscriptState>(EMPTY_TRANSCRIPT);
  const [status, setStatus] = useState<DictationStatus>('idle');
  const [error, setError] = useState<VoiceError | null>(null);

  const recognizerRef = useRef<Recognizer | null>(null);
  const startingRef = useRef(false);
  const listeningRef = useRef(false);
  const unmountedRef = useRef(false);
  /**
   * Mirrors `transcript` so callbacks can read it without waiting for a render:
   * `stop` has to know whether anything was heard the moment the engine flushes,
   * and a stale closure would report silence every time.
   */
  const transcriptRef = useRef<TranscriptState>(EMPTY_TRANSCRIPT);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const supported = useMemo(() => isVoiceSupported(), []);

  const apply = useCallback((action: TranscriptAction) => {
    transcriptRef.current = transcriptReducer(transcriptRef.current, action);
    if (!unmountedRef.current) setTranscript(transcriptRef.current);
  }, []);

  /**
   * The single end-of-session path, driven by the engine rather than by `stop`
   * — a session also ends when another field's mic takes the stream, and that
   * has to leave this button looking stopped and report what it heard.
   */
  const finishSession = useCallback(() => {
    if (!listeningRef.current) return;
    listeningRef.current = false;
    if (unmountedRef.current) return;

    const heard = displayText(transcriptRef.current).trim();
    if (heard === '') {
      setError({
        code: 'no-speech',
        message: 'Nothing was picked up. Try again, closer to the microphone.',
      });
      setStatus('error');
      return;
    }
    setStatus('idle');
    onResultRef.current?.(heard);
  }, []);

  useEffect(
    () => () => {
      unmountedRef.current = true;
      listeningRef.current = false;
      const recognizer = recognizerRef.current;
      recognizerRef.current = null;
      void recognizer?.dispose();
    },
    [],
  );

  const start = useCallback(() => {
    if (!supported || startingRef.current || listeningRef.current) return;
    startingRef.current = true;
    setError(null);
    setStatus('loading');

    void (async () => {
      let recognizer = recognizerRef.current;

      if (recognizer === null) {
        const created = await createRecognizer({ sampleRate });
        if (!created.ok) {
          startingRef.current = false;
          if (!unmountedRef.current) {
            setError(created.error);
            setStatus('error');
          }
          return;
        }
        recognizer = created.value;
        // The component may have gone while the model downloaded; releasing
        // here is what stops an orphaned worker outliving the screen.
        if (unmountedRef.current) {
          startingRef.current = false;
          void recognizer.dispose();
          return;
        }
        const engine = recognizer;
        engine.onPartial((text) => apply({ type: 'partial', text }));
        engine.onFinal((text) => apply({ type: 'final', text }));
        engine.onStopped(finishSession);
        engine.onError((engineError) => {
          listeningRef.current = false;
          // Release the mic on the way out: an error that leaves the stream
          // open keeps the browser's recording indicator lit for nothing.
          void engine.stop();
          if (unmountedRef.current) return;
          setError(engineError);
          setStatus('error');
        });
        recognizerRef.current = engine;
      }

      const started = await recognizer.start();
      startingRef.current = false;

      if (unmountedRef.current) {
        recognizerRef.current = null;
        void recognizer.dispose();
        return;
      }
      if (!started.ok) {
        setError(started.error);
        setStatus('error');
        return;
      }

      listeningRef.current = true;
      setStatus('listening');
    })();
  }, [apply, finishSession, sampleRate, supported]);

  /**
   * The engine is stopped but kept: the model behind it is shared and
   * refcounted, so holding the recogniser makes a second dictation into this
   * same field start instantly. `finishSession` runs off the engine's callback.
   */
  const stop = useCallback(() => {
    if (!listeningRef.current) return;
    // `finishSession` is idempotent, so calling it again here costs nothing and
    // rescues the case where the engine had already been stopped from under us.
    void recognizerRef.current?.stop().then(finishSession);
  }, [finishSession]);

  const reset = useCallback(() => {
    apply({ type: 'reset' });
    setError(null);
    if (!listeningRef.current) setStatus('idle');
  }, [apply]);

  return { supported, status, text: displayText(transcript), error, start, stop, reset };
}
