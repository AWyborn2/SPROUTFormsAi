import { describe, expect, it } from 'vitest';
import {
  MAX_UPLOAD_BYTES,
  formatFileSize,
  validateUploadFile,
} from './upload-validation.js';

describe('validateUploadFile', () => {
  it('accepts a PDF under the limit', () => {
    expect(
      validateUploadFile({ name: 'audit.pdf', type: 'application/pdf', size: 1_200_000 }),
    ).toBeNull();
  });

  it('accepts a PDF exactly at the 25 MB limit', () => {
    expect(
      validateUploadFile({ name: 'audit.pdf', type: 'application/pdf', size: MAX_UPLOAD_BYTES }),
    ).toBeNull();
  });

  it('recognises a dropped PDF with no MIME type by extension', () => {
    expect(validateUploadFile({ name: 'Site Audit.PDF', type: '', size: 1024 })).toBeNull();
  });

  it('rejects a non-PDF file', () => {
    const err = validateUploadFile({ name: 'photo.png', type: 'image/png', size: 1024 });
    expect(err).toMatch(/isn’t a PDF/);
  });

  it('rejects a file claiming .pdf extension but a non-PDF MIME type', () => {
    const err = validateUploadFile({ name: 'sneaky.pdf', type: 'image/png', size: 1024 });
    expect(err).toMatch(/isn’t a PDF/);
  });

  it('rejects a PDF over 25 MB with the limit in the message', () => {
    const err = validateUploadFile({
      name: 'huge.pdf',
      type: 'application/pdf',
      size: MAX_UPLOAD_BYTES + 1,
    });
    expect(err).toMatch(/limit is 25 MB/);
  });
});

describe('formatFileSize', () => {
  it('formats bytes', () => {
    expect(formatFileSize(512)).toBe('512 B');
  });

  it('formats kilobytes', () => {
    expect(formatFileSize(824 * 1024)).toBe('824 KB');
  });

  it('formats megabytes with one decimal under 10 MB', () => {
    expect(formatFileSize(1.2 * 1024 * 1024)).toBe('1.2 MB');
  });

  it('formats megabytes with no decimals at 10 MB and above', () => {
    expect(formatFileSize(24.6 * 1024 * 1024)).toBe('25 MB');
  });
});
