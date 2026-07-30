import { ApiError } from './data/api-client.js';

/**
 * What went wrong when an evidence export failed, in words a training officer
 * can act on.
 *
 * The export can fail six distinct ways, and each one needs a DIFFERENT next
 * step: place geometry, pass a part, fix the manifest, ask an admin, or wait.
 * A single "export failed" toast would leave someone with no idea which — and
 * this is the artefact they need for an audit, so being stuck on it matters.
 *
 * Separated from the screen so the mapping is testable. Each message names the
 * cause AND the remedy, because the remedy is the part that is not guessable
 * from a status code.
 */
export interface CaseExportProblem {
  /** One sentence: what happened. */
  message: string;
  /** What to do about it. Empty when there is nothing the reader can do. */
  remedy: string;
  /**
   * Specific offending items the server named — an incomplete manifest reports
   * which parts are wrong. Shown as a list, never summarised away: "3 problems"
   * tells a reader nothing they can fix.
   */
  problems: string[];
}

interface ExportErrorBody {
  error?: string;
  problems?: string[];
}

export function caseExportProblem(err: unknown): CaseExportProblem {
  if (!(err instanceof ApiError)) {
    return {
      message: "Couldn't reach the server to build the document.",
      remedy: 'Check your connection and try again.',
      problems: [],
    };
  }

  const body = (err.body ?? {}) as ExportErrorBody;
  const problems = Array.isArray(body.problems) ? body.problems : [];

  switch (body.error) {
    /**
     * The template was never imported from a PDF, or its source was lost. There
     * is no original document to overlay onto, so this is the one failure that
     * is not about the case at all.
     */
    case 'no_source_pdf':
      return {
        message: 'This assessment has no original PDF to fill in.',
        remedy:
          'The form was built rather than imported, so there is no document to overlay. Import the printed assessment as a PDF to export evidence from it.',
        problems,
      };

    /**
     * The manifest disagrees with the template version the case is pinned to —
     * usually a part anchor pointing at a field that a re-import renamed.
     * Exporting anyway would place answers by a broken map.
     */
    case 'case_export_invalid_manifest':
      return {
        message: "This assessment tool's part layout no longer matches its form.",
        remedy:
          'Re-run the tool authoring step against the current version, then export again. Nothing is drawn until the layout is valid, so no wrong marks have been recorded.',
        problems,
      };

    case 'case_export_unknown_part':
      return {
        message: 'This case has answers against a part the tool no longer declares.',
        remedy:
          'The tool was re-authored after the case started. Re-check the manifest covers every part this case has attempts for.',
        problems,
      };

    case 'tool_missing':
      return {
        message: 'The assessment tool behind this case has been removed.',
        remedy: 'Nothing can be exported until the tool exists again. Ask an administrator.',
        problems,
      };

    case 'storage_unavailable':
    case 'asset_not_found':
      return {
        message: "The original PDF couldn't be read from storage.",
        remedy: 'This is a configuration problem rather than one with the case. Try again, then report it.',
        problems,
      };
  }

  // No recognised code — fall back on the status, which still distinguishes
  // "you may not" from "it is not there" from "we broke".
  if (err.status === 403) {
    return {
      message: "You don't have permission to export assessment evidence.",
      remedy: 'Ask an administrator for the export permission on assessments.',
      problems,
    };
  }
  if (err.status === 404) {
    return {
      message: 'This case is no longer available.',
      remedy: '',
      problems,
    };
  }

  return {
    message: "Couldn't build the evidence document.",
    remedy: 'Try again. If it keeps failing, report it with the case reference.',
    problems,
  };
}

/**
 * A filename that says what the document is without needing the case open.
 *
 * These get emailed and filed, so a bare `export.pdf` is a document nobody can
 * identify later. Punctuation is stripped because this lands on Windows shares
 * where a colon or slash makes the file unsaveable.
 */
export function caseExportFilename(toolName: string, candidateName: string, date = new Date()): string {
  const safe = (s: string) =>
    s
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  const stamp = date.toISOString().slice(0, 10);
  const parts = [safe(toolName), safe(candidateName), stamp].filter(Boolean);
  return `${parts.join('_') || 'assessment'}.pdf`;
}
