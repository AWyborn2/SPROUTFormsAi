/**
 * Voice-to-text — the shared shapes for Smart Fill, where one spoken utterance
 * about the whole form is mapped onto many fields at once.
 *
 * Audio NEVER crosses the wire. The transcript is produced on-device by the
 * in-browser Vosk engine (the same engine that powers free per-field
 * dictation); only that text is posted to the API, which is the sole input the
 * model sees. Nothing here should ever grow an audio-bearing field.
 */

import type { SubmissionValue } from './submission.js';

/**
 * One proposed answer. Always a PROPOSAL: mappings are staged for the filler to
 * review and accept, never written straight into a submission, because a
 * mis-heard word on a compliance form is a wrong answer with a signature on it.
 */
export interface SmartFillMapping {
  /** Id of the `FormField` this answer targets. */
  fieldId: string;
  /** Typed per the target field, exactly as a submission would store it. */
  value: SubmissionValue;
  /** [0,1] — same scale as extraction confidence, so the review UI can reuse its thresholds. */
  confidence: number;
}

export interface SmartFillResult {
  mappings: SmartFillMapping[];
  /**
   * Fragments of the transcript the model could not place on any field. Surfaced
   * in the review UI so a filler can see what was heard-but-dropped and enter it
   * by hand, rather than silently losing part of what they said.
   */
  unmapped?: string[];
}

/**
 * The request body. Deliberately transcript-only: the form identity comes from
 * the route (link token or template id), never the body, so a caller cannot
 * supply arbitrary field definitions for the model to answer against.
 */
export interface SmartFillRequest {
  transcript: string;
}
