// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BrandPdfScan } from '../../lib/data/types.js';

/**
 * Reading a client's brand off their own PDF.
 *
 * THE REVIEW STEP IS THE FEATURE. A document's most-used colour may be its
 * table borders rather than its letterhead, and its images are its logo, its
 * hazard pictograms and its site photographs alike — so nothing here may apply
 * itself. These tests pin that nothing reaches the brand until a person clicks
 * the specific thing they want, and that a thin result reads as a fact about
 * the document rather than a failure of the product.
 */

let scanResult: BrandPdfScan | Error = { colors: [], logos: [], notes: [] };
const scanMutate = vi.fn(
  (_input: unknown, opts: { onSuccess: (r: BrandPdfScan) => void; onError: (e: unknown) => void }) => {
    if (scanResult instanceof Error) opts.onError(scanResult);
    else opts.onSuccess(scanResult);
  },
);
const uploadMutateAsync = vi.fn(async () => ({ url: '/api/assets/logo/org-1/logo-new.png' }));

vi.mock('../../lib/data/hooks.js', () => ({
  useScanBrandFromPdf: () => ({ mutate: scanMutate, isPending: false }),
  useUploadOrgLogo: () => ({ mutateAsync: uploadMutateAsync, isPending: false }),
}));

const { BrandPdfScanPanel } = await import('./BrandPdfScanPanel.js');

/** A file whose `arrayBuffer()` resolves — jsdom's File does not implement it. */
function pdfFile(bytes = 8, name = 'bbm-permit.pdf'): File {
  const file = new File(['x'], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'size', { value: bytes });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new Uint8Array(Math.min(bytes, 8)).buffer,
  });
  return file;
}

function pick(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

beforeEach(() => {
  scanResult = { colors: [], logos: [], notes: [] };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('BrandPdfScanPanel', () => {
  it('APPLIES NOTHING on its own', async () => {
    /*
      The property the whole panel rests on. A scan that applied its guesses
      would put a table-border colour on a client's brand, and the author would
      have to work out which of four changes was the bad one.
    */
    const onApply = vi.fn();
    scanResult = { colors: ['#0044cc', '#cc0000'], logos: [], notes: [] };
    render(<BrandPdfScanPanel onApply={onApply} />);
    pick(pdfFile());
    await screen.findByTitle('#0044cc');
    expect(onApply).not.toHaveBeenCalled();
  });

  it('applies one colour to one role when that role is clicked', async () => {
    // Which swatch is "the" primary is exactly the judgement the author is
    // here to make, so it is one click per role rather than one per colour.
    const onApply = vi.fn();
    scanResult = { colors: ['#0044cc'], logos: [], notes: [] };
    render(<BrandPdfScanPanel onApply={onApply} />);
    pick(pdfFile());
    fireEvent.click(await screen.findByText('Accent'));
    expect(onApply).toHaveBeenCalledWith({ accentColor: '#0044cc' });
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('UPLOADS A LOGO ONLY WHEN IT IS CHOSEN, then applies the URL', async () => {
    /*
      The scan hands logos back as base64 precisely so declining one leaves
      nothing behind. Uploading every candidate up front would orphan an object
      for each image in the document that was never a logo.
    */
    const onApply = vi.fn();
    scanResult = {
      colors: [],
      logos: [{ imageBase64: 'aGk=', mimeType: 'image/png', width: 120, height: 60 }],
      notes: [],
    };
    render(<BrandPdfScanPanel onApply={onApply} />);
    pick(pdfFile());

    const button = await screen.findByLabelText('Use this 120 by 60 image as the logo');
    expect(uploadMutateAsync).not.toHaveBeenCalled();

    fireEvent.click(button);
    await waitFor(() => expect(onApply).toHaveBeenCalledWith({
      logoAssetUrl: '/api/assets/logo/org-1/logo-new.png',
    }));
    // `usage: 'brand'` so the audit line says whose logo it was.
    expect(uploadMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ imageBase64: 'aGk=', usage: 'brand' }),
    );
  });

  it('says the document had nothing usable, rather than looking broken', async () => {
    // Plenty of real forms are black and white, or carry their letterhead as a
    // flattened scan. That is a fact about the document, not a failure.
    render(<BrandPdfScanPanel onApply={vi.fn()} />);
    pick(pdfFile());
    expect(await screen.findByText(/set the colours and logo yourself/i)).toBeTruthy();
  });

  it('shows the scan’s own notes', async () => {
    scanResult = { colors: ['#0044cc'], logos: [], notes: ['Read the first 3 of 9 pages.'] };
    render(<BrandPdfScanPanel onApply={vi.fn()} />);
    pick(pdfFile());
    expect(await screen.findByText('Read the first 3 of 9 pages.')).toBeTruthy();
  });

  it('refuses an oversized file before sending it', async () => {
    // A 40 MB upload that 413s several seconds later tells the author nothing
    // they could not have been told immediately.
    render(<BrandPdfScanPanel onApply={vi.fn()} />);
    pick(pdfFile(30 * 1024 * 1024));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(scanMutate).not.toHaveBeenCalled();
  });

  it('points at setting the colours by hand when the read fails', async () => {
    // The panel is a shortcut. Its failure has to leave the author with the
    // path they already had, not a dead end.
    scanResult = new Error('boom');
    render(<BrandPdfScanPanel onApply={vi.fn()} />);
    pick(pdfFile());
    expect((await screen.findByRole('alert')).textContent).toMatch(/by hand/i);
  });
});
