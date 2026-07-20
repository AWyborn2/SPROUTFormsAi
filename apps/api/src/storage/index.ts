import { env } from '../env.js';
import {
  deletePrefix as deletePrefixReplit,
  downloadPdf as downloadReplit,
  getReplitClient,
  uploadPdf as uploadReplit,
} from './replit.js';
import {
  deletePrefix as deletePrefixSupabase,
  downloadPdf as downloadSupabase,
  getSupabaseClient,
  uploadPdf as uploadSupabase,
} from './supabase.js';

/** Provider-agnostic PDF storage handle — callers don't need to know which backend is active. */
export interface StorageClient {
  upload(orgId: string, bytes: Uint8Array): Promise<string>;
  download(orgId: string, assetId: string): Promise<Buffer | null>;
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
      download: (orgId, assetId) => downloadSupabase(client, orgId, assetId),
      deletePrefix: (orgId) => deletePrefixSupabase(client, orgId),
    };
  }
  const client = getReplitClient();
  if (!client) return null;
  return {
    upload: (orgId, bytes) => uploadReplit(client, orgId, bytes),
    download: (orgId, assetId) => downloadReplit(client, orgId, assetId),
    deletePrefix: (orgId) => deletePrefixReplit(client, orgId),
  };
}
