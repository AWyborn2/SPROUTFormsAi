import { randomUUID } from 'node:crypto';
import { Client } from '@replit/object-storage';

export type ReplitStorageClient = Client;

let cachedClient: ReplitStorageClient | null = null;

/**
 * Lazily construct the Replit Object Storage client. Returns null outside a
 * real Replit deployment. Detection uses `REPLIT_CLUSTER`, which Replit always
 * injects but is never present in local/CI environments.
 *
 * The SDK does NOT use `REPLIT_DEFAULT_BUCKET_URL` as an env var — it resolves
 * the default bucket by calling the local sidecar at http://127.0.0.1:1106,
 * which is only available when running inside Replit. No `bucketId` is passed
 * to `Client` so it reads the bucket from the sidecar automatically.
 */
export function getReplitClient(): ReplitStorageClient | null {
  if (!process.env.REPLIT_CLUSTER) return null;
  if (!cachedClient) cachedClient = new Client();
  return cachedClient;
}

/**
 * Uploads PDF bytes and returns a generated asset id — the object key
 * itself, prefixed by `orgId` for tenant isolation at the storage layer too,
 * not just via `formTemplateVersions.orgId` in Postgres. Takes the client as
 * an explicit argument rather than calling `getReplitClient()` internally,
 * matching `db.ts`'s `checkDbConnection` pattern, so tests don't need a
 * real Replit environment.
 */
export async function uploadPdf(client: ReplitStorageClient, orgId: string, bytes: Uint8Array): Promise<string> {
  const assetId = `${orgId}/${randomUUID()}.pdf`;
  const result = await client.uploadFromBytes(assetId, Buffer.from(bytes));
  if (!result.ok) throw new Error(`storage_upload_failed: ${result.error.message}`);
  return assetId;
}

/**
 * Downloads PDF bytes by asset id, scoped to `orgId`. Returns null both when
 * the object is missing AND when `assetId` doesn't belong to `orgId` — a
 * cross-tenant lookup is indistinguishable from a missing one, by design.
 */
export async function downloadPdf(client: ReplitStorageClient, orgId: string, assetId: string): Promise<Buffer | null> {
  if (!assetId.startsWith(`${orgId}/`)) return null;
  const result = await client.downloadAsBytes(assetId);
  if (!result.ok) return null;
  return result.value[0];
}

/**
 * Deletes every object stored under an org's prefix — called when the org
 * itself is deleted so its PDFs don't linger as unreachable orphans. Throws
 * on the first failure; the caller (`DELETE /account`) treats cleanup as
 * best-effort and logs rather than failing the request, since the org row
 * is already gone by the time this runs.
 */
export async function deletePrefix(client: ReplitStorageClient, orgId: string): Promise<void> {
  const listed = await client.list({ prefix: `${orgId}/` });
  if (!listed.ok) throw new Error(`storage_delete_prefix_failed: ${listed.error.message}`);
  for (const object of listed.value) {
    const result = await client.delete(object.name, { ignoreNotFound: true });
    if (!result.ok) throw new Error(`storage_delete_prefix_failed: ${result.error.message}`);
  }
}
