/**
 * The engine is browser plumbing and stays deliberately untested as such — but
 * its two LIFECYCLE invariants are decisions, not plumbing, and both fail
 * silently and expensively:
 *
 *  - exactly one recogniser may hold the mic, or one field's dictation ends up
 *    written into another field's answer;
 *  - a recogniser disposed mid-start must give the mic back, or the browser's
 *    recording indicator stays lit on a screen the respondent has left.
 *
 * Everything below the engine's own logic is faked: this asserts what the
 * module does with streams and handles, never what Vosk or WebAudio do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeTrack {
  stopped: boolean;
  stop: () => void;
}

interface FakeStream {
  track: FakeTrack;
  media: MediaStream;
}

function fakeStream(): FakeStream {
  const track: FakeTrack = {
    stopped: false,
    stop() {
      track.stopped = true;
    },
  };
  return { track, media: { getTracks: () => [track] } as unknown as MediaStream };
}

class FakeAudioContext {
  state = 'running';
  sampleRate = 16000;
  destination = {};
  createScriptProcessor() {
    return { connect() {}, disconnect() {}, onaudioprocess: null };
  }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

/** Flushes its final result synchronously so `stop()` never waits out the 1.5s timeout. */
class FakeKaldiRecognizer {
  private handlers = new Map<string, (message: unknown) => void>();
  on(event: string, handler: (message: unknown) => void) {
    this.handlers.set(event, handler);
  }
  acceptWaveform() {}
  retrieveFinalResult() {
    this.handlers.get('result')?.({ result: { text: '' } });
  }
  remove() {}
}

/** `terminate` is a no-op: every test below keeps a second reference, so the model stays live. */
const fakeModel = { KaldiRecognizer: FakeKaldiRecognizer, terminate: vi.fn() };

vi.mock('vosk-browser', () => ({ createModel: vi.fn(() => Promise.resolve(fakeModel)) }));

const { createRecognizer } = await import('./vosk-engine.js');

let getUserMedia: ReturnType<typeof vi.fn>;
let opened: FakeStream[];

/** Drains the microtask queue — a macrotask tick is past every pending `await`. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  opened = [];
  getUserMedia = vi.fn(() => {
    const stream = fakeStream();
    opened.push(stream);
    return Promise.resolve(stream.media);
  });
  vi.stubGlobal('window', { AudioContext: FakeAudioContext });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Streams whose tracks are still running — one per lit recording indicator. */
function liveStreams(): FakeStream[] {
  return opened.filter((s) => !s.track.stopped);
}

async function recognizer(modelUrl: string) {
  const created = await createRecognizer({ modelUrl });
  if (!created.ok) throw new Error(`createRecognizer failed: ${created.error.code}`);
  return created.value;
}

describe('createRecognizer — only one recogniser holds the mic', () => {
  /**
   * The respondent presses one field's mic, sees the spinner while the ~40 MB
   * model loads, and presses another's. Both resume from the same shared model
   * promise in one microtask drain, so both used to read the mic slot as free.
   */
  it('does not open a second stream when two mics are pressed together', async () => {
    const url = 'model://two-presses';
    const [first, second] = await Promise.all([recognizer(url), recognizer(url)]);

    const results = await Promise.all([first!.start(), second!.start()]);
    expect(results.every((r) => r.ok)).toBe(true);

    // Two streams were requested — the second press legitimately takes over —
    // but only the winner's may still be running.
    expect(liveStreams()).toHaveLength(1);

    await second!.dispose();
    await first!.dispose();
    expect(liveStreams()).toHaveLength(0);
  });

  /**
   * The loser has to be told, not just muted. Without the handover its button
   * goes on claiming to listen while its recogniser accumulates the words meant
   * for the other field — which the next stop then delivers to the wrong one.
   */
  it('tells the recogniser that lost the mic that its session ended', async () => {
    const url = 'model://takeover';
    const [first, second] = await Promise.all([recognizer(url), recognizer(url)]);
    const firstStopped = vi.fn();
    first!.onStopped(firstStopped);

    await Promise.all([first!.start(), second!.start()]);
    expect(firstStopped).toHaveBeenCalledTimes(1);

    await second!.dispose();
    await first!.dispose();
  });
});

describe('createRecognizer — a start disposed mid-flight gives the mic back', () => {
  /**
   * Another field is still holding the shared model (refs >= 2), so it is not
   * terminated and nothing downstream throws — the disposed start has to undo
   * its own work, because the caller's follow-up `dispose()` is a no-op.
   */
  it('stops the stream it opened when dispose lands while getUserMedia is pending', async () => {
    const url = 'model://orphan';
    const holder = await recognizer(url);
    const orphan = await recognizer(url);

    let release: (() => void) | null = null;
    getUserMedia.mockImplementationOnce(
      () =>
        new Promise<MediaStream>((resolve) => {
          release = () => {
            const stream = fakeStream();
            opened.push(stream);
            resolve(stream.media);
          };
        }),
    );

    const starting = orphan.start();
    await settle();
    expect(release).not.toBeNull();

    // The component goes while the permission prompt is still up.
    const disposing = orphan.dispose();
    release!();
    const started = await starting;
    await disposing;

    expect(started.ok).toBe(false);
    expect(opened).toHaveLength(1);
    expect(liveStreams()).toHaveLength(0);

    await holder.dispose();
  });
});
