/**
 * Thin wrapper over `vosk-browser` — the on-device speech engine behind free
 * per-field dictation and behind Smart Fill's transcript.
 *
 * Audio never leaves the device: the acoustic model runs in a Web Worker in
 * this tab and only text ever escapes this module. That is the property the
 * whole feature is sold on, so nothing here may grow a network call carrying
 * samples.
 *
 * Kept deliberately small — start/stop/dispose plus a handful of callbacks — so
 * a different engine can be dropped in behind the same shape without touching
 * the hook or the coercion rules. Nothing in here is unit-tested; it is all
 * browser API plumbing, and every decision lives in `coerce.ts`/`transcript.ts`.
 */
import type { KaldiRecognizer, Model } from 'vosk-browser';

/**
 * Official small English model (~40 MB). Override per deployment with
 * `VITE_VOSK_MODEL_URL` — self-hosting it beside the app avoids a third-party
 * dependency at fill time and sidesteps CORS, which a Worker `fetch` enforces
 * just as strictly as the page does. Never commit a model to the repo.
 */
export const DEFAULT_VOSK_MODEL_URL =
  'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.tar.gz';

/** Versioned so a model swap cannot serve stale bytes from a previous release. */
const MODEL_CACHE_NAME = 'formai-vosk-model-v1';

/** Small enough to keep latency low, large enough that the main thread is not spammed. */
const CAPTURE_BUFFER_SIZE = 4096;

/** How long `stop()` waits for the tail of the last utterance before tearing the graph down. */
const FINAL_FLUSH_TIMEOUT_MS = 1500;

export type VoiceErrorCode =
  | 'unsupported'
  | 'model-load-failed'
  | 'permission-denied'
  | 'audio-failed'
  | 'no-speech'
  | 'recognition-failed';

export interface VoiceError {
  code: VoiceErrorCode;
  /** Safe to show a respondent — no stack traces, no model URLs. */
  message: string;
}

/**
 * Everything that can go wrong here is expected (no mic, denied permission,
 * offline mid-download), so failures are values rather than rejections — an
 * unhandled rejection in a fill flow is a dead mic button with no explanation.
 */
export type VoiceResult<T> = { ok: true; value: T } | { ok: false; error: VoiceError };

export interface Recognizer {
  /** Opens the mic and begins streaming audio to the model. */
  start: () => Promise<VoiceResult<void>>;
  /** Closes the mic and flushes the final result. The recogniser can be started again. */
  stop: () => Promise<void>;
  /** Releases the mic, the recogniser and the model worker. Not restartable. */
  dispose: () => Promise<void>;
  /** Replaces the live-partial listener. */
  onPartial: (listener: (text: string) => void) => void;
  /** Replaces the finalised-utterance listener. */
  onFinal: (listener: (text: string) => void) => void;
  /** Replaces the mid-recognition error listener. */
  onError: (listener: (error: VoiceError) => void) => void;
  /**
   * Fires once a capturing session has ended and its final result is in —
   * including when another field's mic took over. Without it, the mic button
   * that lost the stream would sit there claiming to still be listening.
   */
  onStopped: (listener: () => void) => void;
}

export interface CreateRecognizerOptions {
  /**
   * Rate the mic is REQUESTED at. The recogniser is configured from the rate the
   * browser actually grants, not this one — a 16 kHz recogniser fed 48 kHz audio
   * transcribes gibberish, and Safari ignores the request routinely.
   */
  sampleRate?: number;
  /** Overrides the env/default model URL. Mostly a seam for a self-hosted model. */
  modelUrl?: string;
}

declare global {
  interface Window {
    /** Safari before 14.1 only exposes the prefixed constructor. */
    webkitAudioContext?: typeof AudioContext;
  }
}

export function voskModelUrl(): string {
  const configured: unknown = import.meta.env.VITE_VOSK_MODEL_URL;
  return typeof configured === 'string' && configured !== '' ? configured : DEFAULT_VOSK_MODEL_URL;
}

/**
 * Whether this browser can run on-device dictation at all. Callers hide the mic
 * entirely when false — voice is an enhancement, so an unsupported browser
 * should look like a form that never offered it, not one with a broken button.
 */
export function isVoiceSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof WebAssembly === 'object' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    (typeof window.AudioContext === 'function' || typeof window.webkitAudioContext === 'function')
  );
}

function voiceError(code: VoiceErrorCode, message: string): VoiceError {
  return { code, message };
}

/**
 * Only one recogniser may hold the mic. A form has a mic button per field, and
 * a second live stream means two browser recording indicators plus two engines
 * decoding the same voice — so starting one stops whichever was running.
 */
let activeRecognizer: Recognizer | null = null;

function audioContextCtor(): typeof AudioContext {
  return window.AudioContext ?? (window.webkitAudioContext as typeof AudioContext);
}

/**
 * Resolve the model to a URL the worker can fetch, preferring a cached copy.
 *
 * The download is tens of megabytes and `vosk-browser` fetches it fresh inside
 * its worker every time, so without this a respondent pays it on every visit.
 * The Cache API copy is handed over as a blob URL because a worker `fetch` does
 * not consult the cache on its own.
 */
async function resolveModelSource(url: string): Promise<{ src: string; release: () => void }> {
  if (typeof caches === 'undefined') return { src: url, release: () => {} };
  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    let hit = await cache.match(url);
    if (!hit) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`model request failed (${response.status})`);
      await cache.put(url, response.clone());
      hit = response;
    }
    const objectUrl = URL.createObjectURL(await hit.blob());
    return { src: objectUrl, release: () => URL.revokeObjectURL(objectUrl) };
  } catch {
    // A cross-origin model, a full disk or private-mode storage limits all land
    // here. Falling back to the plain URL keeps dictation working, just slower.
    return { src: url, release: () => {} };
  }
}

/**
 * The `vosk-browser` import is dynamic so its multi-megabyte WASM bundle stays
 * out of the initial page chunk — a form must render instantly for someone who
 * never presses the mic.
 */
async function loadModel(url: string): Promise<Model> {
  const vosk = await import('vosk-browser');
  const source = await resolveModelSource(url);
  try {
    return await vosk.createModel(source.src);
  } finally {
    source.release();
  }
}

interface ModelEntry {
  refs: number;
  model: Promise<Model>;
}

/**
 * One loaded model per URL, shared by every field's mic and reference-counted.
 *
 * A form has a mic button per field; giving each its own model would mean a
 * worker and a decoded acoustic model apiece, on the phone of someone standing
 * in a yard. Sharing also makes the second field instant — the cost is paid
 * once. The last release terminates the worker, so leaving the fill screen
 * gives the memory back.
 */
const loadedModels = new Map<string, ModelEntry>();

async function acquireModel(url: string): Promise<Model> {
  let entry = loadedModels.get(url);
  if (!entry) {
    entry = { refs: 0, model: loadModel(url) };
    loadedModels.set(url, entry);
  }
  entry.refs++;
  try {
    return await entry.model;
  } catch (error) {
    // A failed load must not be cached as a permanent failure — the next mic
    // press should be free to retry after the connection comes back.
    releaseModel(url);
    throw error;
  }
}

function releaseModel(url: string): void {
  const entry = loadedModels.get(url);
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0) return;
  loadedModels.delete(url);
  void entry.model.then((model) => model.terminate()).catch(() => {});
}

/** Load (or join) the shared model and hand back a recogniser bound to it. */
export async function createRecognizer(
  options: CreateRecognizerOptions = {},
): Promise<VoiceResult<Recognizer>> {
  if (!isVoiceSupported()) {
    return { ok: false, error: voiceError('unsupported', 'This browser cannot run on-device dictation.') };
  }

  const requestedRate = options.sampleRate ?? 16000;
  const url = options.modelUrl ?? voskModelUrl();

  let model: Model;
  try {
    model = await acquireModel(url);
  } catch {
    return {
      ok: false,
      error: voiceError('model-load-failed', 'Could not load the speech model. Check your connection and try again.'),
    };
  }

  let partialListener: (text: string) => void = () => {};
  let finalListener: (text: string) => void = () => {};
  let errorListener: (error: VoiceError) => void = () => {};
  let stoppedListener: () => void = () => {};

  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let recognizer: KaldiRecognizer | null = null;
  let awaitFinal: (() => void) | null = null;
  let disposed = false;

  function teardownAudio(): void {
    processor?.disconnect();
    source?.disconnect();
    processor = null;
    source = null;
    // Every track must be stopped explicitly: closing the context alone leaves
    // the browser's recording indicator lit, which reads as "still listening".
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    void context?.close().catch(() => {});
    context = null;
  }

  const handle: Recognizer = {
    onPartial(listener) {
      partialListener = listener;
    },
    onFinal(listener) {
      finalListener = listener;
    },
    onError(listener) {
      errorListener = listener;
    },
    onStopped(listener) {
      stoppedListener = listener;
    },

    async start() {
      if (disposed) {
        return { ok: false, error: voiceError('recognition-failed', 'This recogniser has been closed.') };
      }
      if (activeRecognizer && activeRecognizer !== handle) await activeRecognizer.stop();
      if (stream) return { ok: true, value: undefined };

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            channelCount: 1,
            sampleRate: requestedRate,
          },
          video: false,
        });
      } catch {
        return {
          ok: false,
          error: voiceError('permission-denied', 'Microphone access was blocked. Allow it in your browser to dictate.'),
        };
      }

      try {
        const AudioCtor = audioContextCtor();
        // Firefox throws rather than resampling for rates it dislikes, and the
        // recogniser is built from whatever rate we end up with anyway.
        try {
          context = new AudioCtor({ sampleRate: requestedRate });
        } catch {
          context = new AudioCtor();
        }
        // iOS hands back a suspended context even inside a click handler, and a
        // suspended context never fires `onaudioprocess` — a silently dead mic.
        if (context.state === 'suspended') await context.resume();

        // Recreated per session against the rate actually granted, so a device
        // that refused 16 kHz still decodes correctly.
        recognizer = new model.KaldiRecognizer(context.sampleRate);
        recognizer.on('partialresult', (message) => {
          if ('result' in message && 'partial' in message.result) partialListener(message.result.partial);
        });
        recognizer.on('result', (message) => {
          if ('result' in message && 'text' in message.result) finalListener(message.result.text);
          awaitFinal?.();
        });
        recognizer.on('error', () => {
          errorListener(voiceError('recognition-failed', 'Dictation stopped unexpectedly. Try again.'));
          awaitFinal?.();
        });

        // ScriptProcessor is deprecated but it is the node `acceptWaveform`
        // takes an AudioBuffer from; an AudioWorklet would need its own module
        // file in the bundle for no gain at one 4096-frame callback per field.
        processor = context.createScriptProcessor(CAPTURE_BUFFER_SIZE, 1, 1);
        processor.onaudioprocess = (event) => {
          try {
            recognizer?.acceptWaveform(event.inputBuffer);
          } catch {
            // A dropped buffer is a lost syllable, not a broken session — the
            // worker recovers on the next callback, so never surface it.
          }
        };
        source = context.createMediaStreamSource(stream);
        source.connect(processor);
        // Chrome will not run a ScriptProcessor that reaches no destination.
        processor.connect(context.destination);
      } catch {
        teardownAudio();
        recognizer?.remove();
        recognizer = null;
        return { ok: false, error: voiceError('audio-failed', 'Could not start recording on this device.') };
      }

      activeRecognizer = handle;
      return { ok: true, value: undefined };
    },

    async stop() {
      if (activeRecognizer === handle) activeRecognizer = null;
      const pending = recognizer;
      if (!pending) {
        teardownAudio();
        return;
      }
      recognizer = null;

      // Ask for the tail of the last utterance BEFORE unhooking the graph:
      // tearing down first drops whatever was said in the final second.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, FINAL_FLUSH_TIMEOUT_MS);
        awaitFinal = () => {
          clearTimeout(timer);
          resolve();
        };
        try {
          pending.retrieveFinalResult();
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });

      awaitFinal = null;
      teardownAudio();
      pending.remove();
      stoppedListener();
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      // Silenced before the flush: a component that is going away has nothing
      // to do with a last partial, and `onStopped` would drive a dead UI.
      partialListener = () => {};
      finalListener = () => {};
      errorListener = () => {};
      stoppedListener = () => {};
      await handle.stop();
      releaseModel(url);
    },
  };

  return { ok: true, value: handle };
}
