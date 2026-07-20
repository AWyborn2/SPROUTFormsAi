import { randomUUID } from 'node:crypto';
import { Client } from '@replit/object-storage';

export type ReplitStorageClient = Client;

let cachedClient: ReplitStorageClient | null = null;

/**
 * Renders an SDK error for inclusion in a thrown error's message. The
 * `@replit/object-storage` SDK types its errors as `RequestError`
 * (`{ message, statusCode }`), but reading `.message` alone has previously
 * hidden the real diagnosis — in production the SDK surfaces only the
 * generic "Error code undefined" via `.message` while `statusCode` (and any
 * other field the SDK adds in a future version) went unread. Serializing
 * the whole object, rather than just `.message`, means nothing is silently
 * dropped. Falls back to `String()` if the object doesn't serialize
 * cleanly (circular refs, BigInt, etc.), so this can never itself throw.
 */
function describeStorageError(error: unknown): string {
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

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
  if (!result.ok) {
    throw new Error(`storage_upload_failed: ${describeStorageError(result.error)}`, { cause: result.error });
  }
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
 * Uploads image bytes (an org logo) and returns the object key. Keys are
 * FLAT — `${orgId}/logo-${uuid}.${ext}` — to stay inside the org prefix that
 * `deletePrefix` sweeps at org deletion, and so the `logo-` infix can act as
 * the namespace the public serving route restricts itself to. Replit's SDK
 * has no content-type argument on `uploadFromBytes`; the type is carried by
 * the extension and re-derived when serving.
 */
export async function uploadImage(
  client: ReplitStorageClient,
  orgId: string,
  bytes: Uint8Array,
  _contentType: string,
  ext: string,
): Promise<string> {
  const key = `${orgId}/logo-${randomUUID()}.${ext}`;
  // Already a Buffer on the upload path; re-wrapping would memcpy up to 2 MB.
  const result = await client.uploadFromBytes(key, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  if (!result.ok) {
    throw new Error(`storage_upload_failed: ${describeStorageError(result.error)}`, { cause: result.error });
  }
  return key;
}

/**
 * Deletes a single object, scoped to `orgId` — used to reap a superseded
 * logo when branding changes. A key outside the org's prefix is ignored
 * rather than acted on, matching `downloadPdf`'s tenant check.
 */
export async function deleteObject(
  client: ReplitStorageClient,
  orgId: string,
  key: string,
): Promise<void> {
  if (!key.startsWith(`${orgId}/`)) return;
  const result = await client.delete(key, { ignoreNotFound: true });
  if (!result.ok) {
    throw new Error(`storage_delete_failed: ${describeStorageError(result.error)}`, { cause: result.error });
  }
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
  if (!listed.ok) {
    throw new Error(`storage_delete_prefix_failed: ${describeStorageError(listed.error)}`, { cause: listed.error });
  }
  for (const object of listed.value) {
    const result = await client.delete(object.name, { ignoreNotFound: true });
    if (!result.ok) {
      throw new Error(`storage_delete_prefix_failed: ${describeStorageError(result.error)}`, { cause: result.error });
    }
  }
}
