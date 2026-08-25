import { schema } from '@formai/db';
import type { DocumentType, ExtractionResult } from '@formai/shared';

/**
 * Persist the raw output of an extraction, so a later human-gated step can learn
 * from how the reviewer corrected it. See `extraction_captures` for why.
 *
 * BEST-EFFORT, ALWAYS. Capturing training signal must never make an import fail
 * or slow: this function swallows every error and returns, and no-ops when there
 * is no database. The extraction result reaches the reviewer whether or not the
 * capture lands. That is the whole contract — a caller awaits it only so the row
 * is written before the response returns, not because it can fail the request.
 *
 * Returns the new capture's id on success, or null on every best-effort exit (no
 * database, or a swallowed failure). The caller hands that id back to the client
 * so a later correction record can link precisely to the raw extraction it
 * corrects — and a null simply means no link, never an error.
 */

/**
 * The sliver of the drizzle client this needs — narrow so tests inject a stub.
 * `returning` is typed loosely (rows of unknown columns) so the real drizzle
 * insert builder is assignable to it; the id is narrowed at the read site.
 */
export interface CaptureDb {
  insert(table: unknown): {
    values(row: unknown): { returning(columns: unknown): Promise<Array<Record<string, unknown>>> };
  };
}

export interface CaptureParams {
  orgId: string;
  /** Storage id of the source PDF, when one exists (absent on the base64 path). */
  assetId?: string | undefined;
  fileName: string;
  documentType?: DocumentType | undefined;
  /** The user who ran the extraction, when known. */
  extractedByUserId?: string | undefined;
  /** The extraction model, for the AI path; absent for the AcroForm path. */
  model?: string | undefined;
  /** The extraction result, stored verbatim as the BEFORE the loop diffs against. */
  result: ExtractionResult;
}

/**
 * Write one capture row. Never throws; never no-ops loudly. `path`, `pageCount`
 * and `fieldCount` are read straight off the result so the row is self-describing
 * without opening the stored jsonb.
 */
export async function captureExtraction(
  db: CaptureDb | null | undefined,
  params: CaptureParams,
): Promise<string | null> {
  if (!db) return null;
  try {
    const [row] = await db
      .insert(schema.extractionCaptures)
      .values({
        orgId: params.orgId,
        assetId: params.assetId ?? null,
        fileName: params.fileName,
        documentType: params.documentType ?? null,
        path: params.result.path,
        pageCount: params.result.pageCount,
        model: params.model ?? null,
        result: params.result,
        fieldCount: params.result.fields.length,
        extractedByUserId: params.extractedByUserId ?? null,
      })
      .returning({ id: schema.extractionCaptures.id });
    return typeof row?.id === 'string' ? row.id : null;
  } catch (err) {
    // Telemetry, not operational state: a failed capture is logged and dropped,
    // never surfaced to the caller, so an import cannot fail on it.
    console.warn(
      `extraction capture failed for "${params.fileName}" (${params.result.path} path): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
