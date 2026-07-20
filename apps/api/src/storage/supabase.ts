import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../env.js';

export type SupabaseStorageClient = SupabaseClient;

let cachedClient: SupabaseStorageClient | null = null;

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
  if (error) throw new Error(`storage_upload_failed: ${error.message}`);
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
    if (error) throw new Error(`storage_delete_prefix_failed: ${error.message}`);
    if (!data || data.length === 0) return;
    const { error: removeError } = await bucket.remove(data.map((f) => `${orgId}/${f.name}`));
    if (removeError) throw new Error(`storage_delete_prefix_failed: ${removeError.message}`);
    if (data.length < pageSize) return;
  }
}
