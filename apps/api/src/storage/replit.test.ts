import { describe, expect, it, vi } from 'vitest';
import {
  deleteObject,
  deletePrefix,
  downloadPdf,
  getReplitClient,
  type ReplitStorageClient,
  uploadImage,
  uploadPdf,
} from './replit.js';

describe('getReplitClient', () => {
  it('returns null outside a Replit deployment (REPLIT_CLUSTER unset)', () => {
    // Stub the variable rather than assume it is absent. It genuinely is absent
    // locally and in CI — but it IS set when the suite runs inside Replit, which
    // is the one environment this product deploys to, so assuming its absence
    // failed the suite exactly there.
    vi.stubEnv('REPLIT_CLUSTER', '');
    try {
      expect(getReplitClient()).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

function mockClient(overrides: {
  uploadFromBytes?: ReturnType<typeof vi.fn>;
  downloadAsBytes?: ReturnType<typeof vi.fn>;
  delete?: ReturnType<typeof vi.fn>;
}): ReplitStorageClient {
  return {
    uploadFromBytes: overrides.uploadFromBytes ?? vi.fn().mockResolvedValue({ ok: true, value: null }),
    downloadAsBytes: overrides.downloadAsBytes ?? vi.fn().mockResolvedValue({ ok: false, error: { message: 'not found' } }),
    delete: overrides.delete ?? vi.fn().mockResolvedValue({ ok: true, value: null }),
  } as unknown as ReplitStorageClient;
}

describe('uploadImage', () => {
  it('writes a FLAT logo key directly under the org prefix', async () => {
    const uploadFromBytes = vi.fn().mockResolvedValue({ ok: true, value: null });
    const client = mockClient({ uploadFromBytes });

    const key = await uploadImage(client, 'org-1', new Uint8Array([1, 2, 3]), 'image/png', 'png');

    // Flat is load-bearing: `deletePrefix` sweeps the org prefix, and the
    // `logo-` infix is the namespace the public serving route restricts to.
    expect(key).toMatch(/^org-1\/logo-[^/]+\.png$/);
    expect(uploadFromBytes).toHaveBeenCalledWith(key, expect.any(Buffer));
  });

  it('throws when the upload errors', async () => {
    const client = mockClient({
      uploadFromBytes: vi.fn().mockResolvedValue({ ok: false, error: { message: 'bucket missing' } }),
    });

    await expect(
      uploadImage(client, 'org-1', new Uint8Array(), 'image/png', 'png'),
    ).rejects.toThrow('storage_upload_failed');
  });
});

describe('deleteObject', () => {
  it('deletes a key inside the org prefix', async () => {
    const del = vi.fn().mockResolvedValue({ ok: true, value: null });
    const client = mockClient({ delete: del });

    await deleteObject(client, 'org-1', 'org-1/logo-abc.png');

    expect(del).toHaveBeenCalledWith('org-1/logo-abc.png', { ignoreNotFound: true });
  });

  it('ignores a key belonging to another org', async () => {
    const del = vi.fn().mockResolvedValue({ ok: true, value: null });
    const client = mockClient({ delete: del });

    await deleteObject(client, 'org-1', 'org-2/logo-abc.png');

    expect(del).not.toHaveBeenCalled();
  });
});

describe('uploadPdf', () => {
  it('uploads bytes under an org-prefixed key and returns that key as the asset id', async () => {
    const uploadFromBytes = vi.fn().mockResolvedValue({ ok: true, value: null });
    const client = mockClient({ uploadFromBytes });

    const assetId = await uploadPdf(client, 'org-1', new Uint8Array([1, 2, 3]));

    expect(assetId.startsWith('org-1/')).toBe(true);
    expect(assetId.endsWith('.pdf')).toBe(true);
    expect(uploadFromBytes).toHaveBeenCalledWith(assetId, expect.any(Buffer));
  });

  it('throws when the upload errors', async () => {
    const client = mockClient({
      uploadFromBytes: vi.fn().mockResolvedValue({ ok: false, error: { message: 'bucket missing' } }),
    });

    await expect(uploadPdf(client, 'org-1', new Uint8Array())).rejects.toThrow('storage_upload_failed');
  });
});

describe('downloadPdf', () => {
  it('round-trips the same bytes for a matching orgId', async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const downloadAsBytes = vi.fn().mockResolvedValue({ ok: true, value: [bytes] });
    const client = mockClient({ downloadAsBytes });

    const result = await downloadPdf(client, 'org-1', 'org-1/some-asset.pdf');

    expect(result).toBe(bytes);
  });

  it('returns null for a wrong orgId prefix without calling storage (tenant isolation)', async () => {
    const downloadAsBytes = vi.fn();
    const client = mockClient({ downloadAsBytes });

    const result = await downloadPdf(client, 'org-2', 'org-1/some-asset.pdf');

    expect(result).toBeNull();
    expect(downloadAsBytes).not.toHaveBeenCalled();
  });

  it('returns null when the object is missing', async () => {
    const client = mockClient({
      downloadAsBytes: vi.fn().mockResolvedValue({ ok: false, error: { message: 'not found' } }),
    });

    const result = await downloadPdf(client, 'org-1', 'org-1/missing.pdf');

    expect(result).toBeNull();
  });
});

describe('deletePrefix', () => {
  function prefixClient(overrides: { list?: ReturnType<typeof vi.fn>; delete?: ReturnType<typeof vi.fn> }) {
    const list = overrides.list ?? vi.fn().mockResolvedValue({ ok: true, value: [] });
    const del = overrides.delete ?? vi.fn().mockResolvedValue({ ok: true, value: null });
    return { client: { list, delete: del } as unknown as ReplitStorageClient, list, del };
  }

  it('lists objects under the org prefix and deletes each one', async () => {
    const { client, list, del } = prefixClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: [{ name: 'org-1/a.pdf' }, { name: 'org-1/b.pdf' }] }),
    });

    await deletePrefix(client, 'org-1');

    expect(list).toHaveBeenCalledWith({ prefix: 'org-1/' });
    expect(del.mock.calls.map(([name]) => name)).toEqual(['org-1/a.pdf', 'org-1/b.pdf']);
  });

  it('deletes nothing when the prefix is empty', async () => {
    const { client, del } = prefixClient({});

    await deletePrefix(client, 'org-1');

    expect(del).not.toHaveBeenCalled();
  });

  it('throws when listing fails', async () => {
    const { client } = prefixClient({
      list: vi.fn().mockResolvedValue({ ok: false, error: { message: 'list blew up' } }),
    });

    await expect(deletePrefix(client, 'org-1')).rejects.toThrow('storage_delete_prefix_failed');
  });

  it('throws when a delete fails', async () => {
    const { client } = prefixClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: [{ name: 'org-1/a.pdf' }] }),
      delete: vi.fn().mockResolvedValue({ ok: false, error: { message: 'delete blew up' } }),
    });

    await expect(deletePrefix(client, 'org-1')).rejects.toThrow('storage_delete_prefix_failed');
  });
});
