import { describe, expect, it, vi } from 'vitest';
import { deletePrefix, downloadPdf, getSupabaseClient, type SupabaseStorageClient, uploadPdf } from './supabase.js';

describe('getSupabaseClient', () => {
  it('returns null when SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are unset', () => {
    // No Supabase env vars are configured in the test environment.
    expect(getSupabaseClient()).toBeNull();
  });
});

function mockClient(overrides: {
  upload?: ReturnType<typeof vi.fn>;
  download?: ReturnType<typeof vi.fn>;
}): SupabaseStorageClient {
  const from = vi.fn(() => ({
    upload: overrides.upload ?? vi.fn().mockResolvedValue({ error: null }),
    download: overrides.download ?? vi.fn().mockResolvedValue({ data: null, error: null }),
  }));
  return { storage: { from } } as unknown as SupabaseStorageClient;
}

describe('uploadPdf', () => {
  it('uploads bytes under an org-prefixed key and returns that key as the asset id', async () => {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const client = mockClient({ upload });

    const assetId = await uploadPdf(client, 'org-1', new Uint8Array([1, 2, 3]));

    expect(assetId.startsWith('org-1/')).toBe(true);
    expect(assetId.endsWith('.pdf')).toBe(true);
    expect(upload).toHaveBeenCalledWith(
      assetId,
      expect.anything(),
      expect.objectContaining({ contentType: 'application/pdf' }),
    );
  });

  it('throws when the upload errors', async () => {
    const client = mockClient({ upload: vi.fn().mockResolvedValue({ error: { message: 'bucket missing' } }) });

    await expect(uploadPdf(client, 'org-1', new Uint8Array())).rejects.toThrow('storage_upload_failed');
  });
});

describe('downloadPdf', () => {
  it('round-trips the same bytes for a matching orgId', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const download = vi.fn().mockResolvedValue({ data: new Blob([bytes]), error: null });
    const client = mockClient({ download });

    const result = await downloadPdf(client, 'org-1', 'org-1/some-asset.pdf');

    expect(result).not.toBeNull();
    expect(Array.from(result!)).toEqual(Array.from(bytes));
  });

  it('returns null for a wrong orgId prefix without calling storage (tenant isolation)', async () => {
    const download = vi.fn();
    const client = mockClient({ download });

    const result = await downloadPdf(client, 'org-2', 'org-1/some-asset.pdf');

    expect(result).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });

  it('returns null when the object is missing', async () => {
    const download = vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } });
    const client = mockClient({ download });

    const result = await downloadPdf(client, 'org-1', 'org-1/missing.pdf');

    expect(result).toBeNull();
  });
});

describe('deletePrefix', () => {
  function prefixClient(overrides: { list?: ReturnType<typeof vi.fn>; remove?: ReturnType<typeof vi.fn> }) {
    const list = overrides.list ?? vi.fn().mockResolvedValue({ data: [], error: null });
    const remove = overrides.remove ?? vi.fn().mockResolvedValue({ data: null, error: null });
    const from = vi.fn(() => ({ list, remove }));
    return { client: { storage: { from } } as unknown as SupabaseStorageClient, list, remove };
  }

  it('lists the org folder and removes every object in it', async () => {
    const { client, list, remove } = prefixClient({
      list: vi
        .fn()
        .mockResolvedValueOnce({ data: [{ name: 'a.pdf' }, { name: 'b.pdf' }], error: null }),
    });

    await deletePrefix(client, 'org-1');

    expect(list).toHaveBeenCalledWith('org-1', expect.anything());
    expect(remove).toHaveBeenCalledWith(['org-1/a.pdf', 'org-1/b.pdf']);
  });

  it('removes nothing when the folder is empty', async () => {
    const { client, remove } = prefixClient({});

    await deletePrefix(client, 'org-1');

    expect(remove).not.toHaveBeenCalled();
  });

  it('throws when listing fails', async () => {
    const { client } = prefixClient({
      list: vi.fn().mockResolvedValue({ data: null, error: { message: 'list blew up' } }),
    });

    await expect(deletePrefix(client, 'org-1')).rejects.toThrow('storage_delete_prefix_failed');
  });

  it('throws when removal fails', async () => {
    const { client } = prefixClient({
      list: vi.fn().mockResolvedValue({ data: [{ name: 'a.pdf' }], error: null }),
      remove: vi.fn().mockResolvedValue({ data: null, error: { message: 'remove blew up' } }),
    });

    await expect(deletePrefix(client, 'org-1')).rejects.toThrow('storage_delete_prefix_failed');
  });
});
