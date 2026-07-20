import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../env.js';

export type SupabaseStorageClient = SupabaseClient;

let cachedClient: SupabaseStorageClient | null = null;

/**
 * Renders an SDK error for inclusion in a thrown error's message. Supabase's
 * `StorageError` carries `.status`/`.statusCode` (and `StorageUnknownError`
 * an `.originalError`) alongside `.message` — reading `.message` alone, as
 * this file previously did, silently drops that detail. `StorageError`
 * defines `toJSON()`, so `JSON.stringify` already serializes the whole
 * shape; the try/catch is only a defensive fallback for the odd case where
 * an error object doesn't serialize cleanly (circular refs, BigInt, etc.),
 * so this can never itself throw.
 */
function describeStorageError(error: unknown): string {
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Lazily construct the Supabase Storage client. Returns null when no
 * credentials are configured, mirroring `getAnthropic()`/`getWorkOS()` —
 * `storage/index.ts` falls back to whatever `STORAGE_PROVIDER` selects
 * (or to the base64-in-request path) rather than crashing at boot.
 */
export function getSupabaseClient(): SupabaseStorageClient | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!cachedClient) cachedClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  return cachedClient;
}

/**
 * Uploads PDF bytes and returns a generated asset id. The id is the object
 * key itself, prefixed by `orgId` — this gives tenant isolation at the
 * storage layer too, not just via `formTemplateVersions.orgId` in Postgres.
 * Takes the client as an explicit argument (rather than calling
 * `getSupabaseClient()` internally) so callers — including tests — can
 * exercise this without an env-injection trick, matching `checkDbConnection`'s
 * pattern in `db.ts`.
 */
export async function uploadPdf(client: SupabaseStorageClient, orgId: string, bytes: Uint8Array): Promise<string> {
  const assetId = `${orgId}/${randomUUID()}.pdf`;
  const { error } = await client.storage
    .from(env.SUPABASE_STORAGE_BUCKET_PDFS)
    .upload(assetId, bytes, { contentType: 'application/pdf' });
  if (error) throw new Error(`storage_upload_failed: ${describeStorageError(error)}`, { cause: error });
  return assetId;
}

/**
 * Downloads PDF bytes by asset id, scoped to `orgId`. Returns null both when
 * the object is missing AND when `assetId` doesn't belong to `orgId` — a
 * cross-tenant lookup is indistinguishable from a missing one, by design.
 */
export async function downloadPdf(client: SupabaseStorageClient, orgId: string, assetId: string): Promise<Buffer | null> {
  if (!assetId.startsWith(`${orgId}/`)) return null;
  const { data, error } = await client.storage.from(env.SUPABASE_STORAGE_BUCKET_PDFS).download(assetId);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

/**
 * Uploads image bytes (an org logo) and returns the object key. Keys are
 * FLAT — `${orgId}/logo-${uuid}.${ext}` — deliberately: `deletePrefix` below
 * does a single-level `list(orgId)`, so a nested `logo/` folder would be
 * listed as one entry whose `remove` is a no-op, silently orphaning every
 * logo at org deletion. The `logo-` infix is what the public serving route's
 * namespace check keys off, so a PDF asset id can never be replayed through it.
 */
export async function uploadImage(
  client: SupabaseStorageClient,
  orgId: string,
  bytes: Uint8Array,
  contentType: string,
  ext: string,
): Promise<string> {
  const key = `${orgId}/logo-${randomUUID()}.${ext}`;
  const { error } = await client.storage
    .from(env.SUPABASE_STORAGE_BUCKET_PDFS)
    .upload(key, bytes, { contentType });
  if (error) throw new Error(`storage_upload_failed: ${describeStorageError(error)}`, { cause: error });
  return key;
}

/**
 * Deletes a single object, scoped to `orgId` — used to reap a superseded
 * logo when branding changes. A key outside the org's prefix is ignored
 * rather than acted on, matching `downloadPdf`'s tenant check.
 */
export async function deleteObject(
  client: SupabaseStorageClient,
  orgId: string,
  key: string,
): Promise<void> {
  if (!key.startsWith(`${orgId}/`)) return;
  const { error } = await client.storage.from(env.SUPABASE_STORAGE_BUCKET_PDFS).remove([key]);
  if (error) throw new Error(`storage_delete_failed: ${describeStorageError(error)}`, { cause: error });
}

/**
 * Deletes every object stored under an org's prefix — called when the org
 * itself is deleted so its PDFs don't linger as unreachable orphans. Objects
 * are keyed `${orgId}/${uuid}.pdf` (flat, no nesting), so listing the org
 * "folder" enumerates all of them; `list` pages (default 100), so re-list
 * after each removal round until the folder comes back empty or short.
 * Throws on the first failure; the caller (`DELETE /account`) treats cleanup
 * as best-effort and logs rather than failing the request.
 */
export async function deletePrefix(client: SupabaseStorageClient, orgId: string): Promise<void> {
  const bucket = client.storage.from(env.SUPABASE_STORAGE_BUCKET_PDFS);
  const pageSize = 100;
  for (;;) {
    const { data, error } = await bucket.list(orgId, { limit: pageSize });
    if (error) throw new Error(`storage_delete_prefix_failed: ${describeStorageError(error)}`, { cause: error });
    if (!data || data.length === 0) return;
    const { error: removeError } = await bucket.remove(data.map((f) => `${orgId}/${f.name}`));
    if (removeError) {
      throw new Error(`storage_delete_prefix_failed: ${describeStorageError(removeError)}`, { cause: removeError });
    }
    if (data.length < pageSize) return;
  }
}
