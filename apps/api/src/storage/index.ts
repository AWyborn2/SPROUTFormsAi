import { env } from '../env.js';
import {
  deleteObject as deleteObjectReplit,
  deletePrefix as deletePrefixReplit,
  downloadPdf as downloadReplit,
  getReplitClient,
  uploadImage as uploadImageReplit,
  uploadPdf as uploadReplit,
} from './replit.js';
import {
  deleteObject as deleteObjectSupabase,
  deletePrefix as deletePrefixSupabase,
  downloadPdf as downloadSupabase,
  getSupabaseClient,
  uploadImage as uploadImageSupabase,
  uploadPdf as uploadSupabase,
} from './supabase.js';

/** Provider-agnostic object storage handle — callers don't need to know which backend is active. */
export interface StorageClient {
  upload(orgId: string, bytes: Uint8Array): Promise<string>;
  /**
   * Uploads an image under the org's flat `logo-` namespace and returns the
   * object key. `contentType` is recorded where the backend supports it;
   * `ext` is authoritative, since serving re-derives the type from the key.
   */
  uploadImage(orgId: string, bytes: Uint8Array, contentType: string, ext: string): Promise<string>;
  download(orgId: string, assetId: string): Promise<Buffer | null>;
  /** Deletes one object, scoped to the org's prefix — superseded-logo cleanup. */
  deleteObject(orgId: string, key: string): Promise<void>;
  /** Deletes every stored object under the org's prefix — org-deletion cleanup. */
  deletePrefix(orgId: string): Promise<void>;
}

/**
 * Selects the active PDF storage backend from `env.STORAGE_PROVIDER`
 * (defaults to `'replit'`). Both backends (`./replit.ts`, `./supabase.ts`)
 * are fully wired and independently fail-soft — this only decides which one
 * `pdf.ts` talks to. There's no silent fallback to the other provider if the
 * selected one is unconfigured (returns null instead), so switching later —
 * once Supabase credentials are filled in, say — is a one-line env change
 * you make deliberately, not something that happens by accident.
 */
export function getStorageClient(): StorageClient | null {
  if (env.STORAGE_PROVIDER === 'supabase') {
    const client = getSupabaseClient();
    if (!client) return null;
    return {
      upload: (orgId, bytes) => uploadSupabase(client, orgId, bytes),
      uploadImage: (orgId, bytes, contentType, ext) =>
        uploadImageSupabase(client, orgId, bytes, contentType, ext),
      download: (orgId, assetId) => downloadSupabase(client, orgId, assetId),
      deleteObject: (orgId, key) => deleteObjectSupabase(client, orgId, key),
      deletePrefix: (orgId) => deletePrefixSupabase(client, orgId),
    };
  }
  const client = getReplitClient();
  if (!client) return null;
  return {
    upload: (orgId, bytes) => uploadReplit(client, orgId, bytes),
    uploadImage: (orgId, bytes, contentType, ext) =>
      uploadImageReplit(client, orgId, bytes, contentType, ext),
    download: (orgId, assetId) => downloadReplit(client, orgId, assetId),
    deleteObject: (orgId, key) => deleteObjectReplit(client, orgId, key),
    deletePrefix: (orgId) => deletePrefixReplit(client, orgId),
  };
}
