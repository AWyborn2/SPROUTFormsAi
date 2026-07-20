import { afterEach, describe, expect, it, vi } from 'vitest';

const mockEnv: { STORAGE_PROVIDER: 'replit' | 'supabase' } = { STORAGE_PROVIDER: 'replit' };
vi.mock('../env.js', () => ({ env: mockEnv }));

const mockGetReplitClient = vi.fn();
const mockUploadReplit = vi.fn();
const mockDownloadReplit = vi.fn();
const mockDeletePrefixReplit = vi.fn();
vi.mock('./replit.js', () => ({
  getReplitClient: () => mockGetReplitClient(),
  uploadPdf: (...args: unknown[]) => mockUploadReplit(...args),
  downloadPdf: (...args: unknown[]) => mockDownloadReplit(...args),
  deletePrefix: (...args: unknown[]) => mockDeletePrefixReplit(...args),
}));

const mockGetSupabaseClient = vi.fn();
const mockUploadSupabase = vi.fn();
const mockDownloadSupabase = vi.fn();
const mockDeletePrefixSupabase = vi.fn();
vi.mock('./supabase.js', () => ({
  getSupabaseClient: () => mockGetSupabaseClient(),
  uploadPdf: (...args: unknown[]) => mockUploadSupabase(...args),
  downloadPdf: (...args: unknown[]) => mockDownloadSupabase(...args),
  deletePrefix: (...args: unknown[]) => mockDeletePrefixSupabase(...args),
}));

const { getStorageClient } = await import('./index.js');

afterEach(() => {
  vi.clearAllMocks();
  mockEnv.STORAGE_PROVIDER = 'replit';
});

describe('getStorageClient', () => {
  it('defaults to the replit provider and returns null when it is unconfigured, without falling back to supabase', () => {
    mockGetReplitClient.mockReturnValue(null);

    expect(getStorageClient()).toBeNull();
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it('wires upload/download/deletePrefix to the replit backend when configured', async () => {
    const fakeClient = {};
    mockGetReplitClient.mockReturnValue(fakeClient);
    mockUploadReplit.mockResolvedValue('org-1/a.pdf');
    mockDownloadReplit.mockResolvedValue(Buffer.from('bytes'));

    const client = getStorageClient();
    expect(client).not.toBeNull();

    await client!.upload('org-1', new Uint8Array([1]));
    expect(mockUploadReplit).toHaveBeenCalledWith(fakeClient, 'org-1', expect.any(Uint8Array));

    await client!.download('org-1', 'org-1/a.pdf');
    expect(mockDownloadReplit).toHaveBeenCalledWith(fakeClient, 'org-1', 'org-1/a.pdf');

    await client!.deletePrefix('org-1');
    expect(mockDeletePrefixReplit).toHaveBeenCalledWith(fakeClient, 'org-1');

    expect(mockGetSupabaseClient).not.toHaveBeenCalled();
  });

  it('selects supabase when STORAGE_PROVIDER=supabase, with no fallback to replit', () => {
    mockEnv.STORAGE_PROVIDER = 'supabase';
    mockGetSupabaseClient.mockReturnValue(null);

    expect(getStorageClient()).toBeNull();
    expect(mockGetReplitClient).not.toHaveBeenCalled();
  });

  it('wires upload/download/deletePrefix to the supabase backend when selected and configured', async () => {
    mockEnv.STORAGE_PROVIDER = 'supabase';
    const fakeClient = {};
    mockGetSupabaseClient.mockReturnValue(fakeClient);
    mockUploadSupabase.mockResolvedValue('org-1/b.pdf');

    const client = getStorageClient();
    expect(client).not.toBeNull();

    await client!.upload('org-1', new Uint8Array([1]));
    expect(mockUploadSupabase).toHaveBeenCalledWith(fakeClient, 'org-1', expect.any(Uint8Array));

    await client!.deletePrefix('org-1');
    expect(mockDeletePrefixSupabase).toHaveBeenCalledWith(fakeClient, 'org-1');
  });
});
