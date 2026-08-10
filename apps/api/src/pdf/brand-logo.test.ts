/**
 * Pulling a client's logo out of their own document.
 *
 * The property these tests exist to pin is that a HALF-DECODED IMAGE IS NEVER
 * RETURNED. An indexed-palette image read as raw RGB, or a transparent one with
 * its mask dropped, renders as a coloured smear or a black box on a client's
 * form — which looks like a product fault rather than the skipped guess it is.
 * Every encoding this cannot recover exactly is refused, and the author uploads
 * a logo instead, which they could always do.
 *
 * The fixtures are real PDFs with real embedded images, so the XObject
 * traversal is exercised against bytes pdf-lib actually writes.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import { encodePng, readLogoCandidates } from './brand-logo.js';

/** A PNG the embedder will accept, of the given size and flat colour. */
function solidPng(width: number, height: number, rgbTriple: [number, number, number]): Buffer {
  const samples = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    samples[i * 3] = rgbTriple[0];
    samples[i * 3 + 1] = rgbTriple[1];
    samples[i * 3 + 2] = rgbTriple[2];
  }
  return encodePng(samples, width, height, 3);
}

/** A one-page PDF with each image drawn on it. */
async function pdfWithImages(
  images: { png: Buffer; width: number; height: number }[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  for (const [i, img] of images.entries()) {
    const embedded = await doc.embedPng(img.png);
    page.drawImage(embedded, { x: 20, y: 700 - i * 100, width: img.width, height: img.height });
  }
  return doc.save();
}

/**
 * Reaches into a saved PDF and sets an entry on its first image XObject.
 *
 * The point is to reproduce shapes pdf-lib will not author — an SMask, an
 * indexed colour space — because those are precisely the shapes that must be
 * refused, and a fixture that cannot express them would test nothing.
 */
async function withImageDictEntry(
  bytes: Uint8Array,
  key: string,
  value: PDFName | PDFNumber,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
      obj.dict.set(PDFName.of(key), value);
      break;
    }
  }
  return doc.save();
}

describe('encodePng', () => {
  it('writes a signature, an IHDR and an IEND', () => {
    const png = encodePng(Buffer.alloc(3 * 4), 2, 2, 3);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.includes(Buffer.from('IHDR'))).toBe(true);
    expect(png.includes(Buffer.from('IEND'))).toBe(true);
  });

  it('records the dimensions and colour type in the header', () => {
    const png = encodePng(Buffer.alloc(3 * 6), 3, 2, 3);
    const ihdr = png.indexOf(Buffer.from('IHDR')) + 4;
    expect(png.readUInt32BE(ihdr)).toBe(3);
    expect(png.readUInt32BE(ihdr + 4)).toBe(2);
    expect(png[ihdr + 9]).toBe(2); // truecolour
    expect(encodePng(Buffer.alloc(6), 3, 2, 1)[ihdr + 9]).toBe(0); // greyscale
  });

  it('round-trips through pdf-lib’s own PNG reader', async () => {
    // The only check that matters: something else has to be able to read it.
    // Byte assertions can all pass on a file no decoder accepts.
    const doc = await PDFDocument.create();
    const embedded = await doc.embedPng(solidPng(40, 40, [0, 68, 204]));
    expect(embedded.width).toBe(40);
    expect(embedded.height).toBe(40);
  });
});

describe('readLogoCandidates', () => {
  it('recovers an embedded image from a real document', async () => {
    const bytes = await pdfWithImages([{ png: solidPng(120, 60, [0, 68, 204]), width: 120, height: 60 }]);
    const found = await readLogoCandidates(bytes);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ width: 120, height: 60, mimeType: 'image/png' });
  });

  it('produces bytes another decoder will accept', async () => {
    // The recovered image goes straight through the logo upload door, which
    // checks magic bytes and then serves it to respondents. A file only this
    // code can read would fail there, hours later, as "upload failed".
    const bytes = await pdfWithImages([{ png: solidPng(120, 60, [0, 68, 204]), width: 120, height: 60 }]);
    const [candidate] = await readLogoCandidates(bytes);
    const doc = await PDFDocument.create();
    await expect(doc.embedPng(candidate!.bytes)).resolves.toBeTruthy();
  });

  it('RANKS THE SMALLEST FIRST', async () => {
    /*
      A logo is a small graphic among larger ones — the site photograph and the
      scanned signature block are both bigger than the letterhead mark. Ordering
      by prominence would put exactly the wrong image at the front of the list.
    */
    const bytes = await pdfWithImages([
      { png: solidPng(400, 300, [200, 30, 30]), width: 400, height: 300 },
      { png: solidPng(90, 40, [0, 68, 204]), width: 90, height: 40 },
    ]);
    expect((await readLogoCandidates(bytes))[0]).toMatchObject({ width: 90 });
  });

  it('skips an image too small to be a logo', async () => {
    // A 12px graphic is a bullet or a rule.
    const bytes = await pdfWithImages([{ png: solidPng(12, 12, [0, 68, 204]), width: 12, height: 12 }]);
    expect(await readLogoCandidates(bytes)).toEqual([]);
  });

  it('skips a scanned page', async () => {
    // Above the ceiling an image is the form itself, scanned — not its logo.
    const bytes = await pdfWithImages([
      { png: solidPng(2600, 60, [0, 68, 204]), width: 300, height: 60 },
    ]);
    expect(await readLogoCandidates(bytes)).toEqual([]);
  });

  it('REFUSES AN IMAGE WITH A SOFT MASK', async () => {
    /*
      A transparent logo whose mask is dropped fills its transparency with
      whatever the raw samples hold — usually black. A client's logo delivered
      as a black box is worse than offering none.
    */
    const base = await pdfWithImages([
      { png: solidPng(120, 60, [0, 68, 204]), width: 120, height: 60 },
    ]);
    const masked = await withImageDictEntry(base, 'SMask', PDFNumber.of(1));
    expect(await readLogoCandidates(masked)).toEqual([]);
  });

  it('REFUSES AN INDEXED COLOUR SPACE', async () => {
    // Its samples are palette indices. Read as RGB they are a coloured smear
    // that looks like a product fault rather than a skipped guess.
    const base = await pdfWithImages([
      { png: solidPng(120, 60, [0, 68, 204]), width: 120, height: 60 },
    ]);
    const indexed = await withImageDictEntry(base, 'ColorSpace', PDFName.of('Indexed'));
    expect(await readLogoCandidates(indexed)).toEqual([]);
  });

  it('refuses a bit depth it cannot read', async () => {
    const base = await pdfWithImages([
      { png: solidPng(120, 60, [0, 68, 204]), width: 120, height: 60 },
    ]);
    const oneBit = await withImageDictEntry(base, 'BitsPerComponent', PDFNumber.of(1));
    expect(await readLogoCandidates(oneBit)).toEqual([]);
  });

  it('hands a JPEG straight through, since the stream already IS one', async () => {
    /*
      DCTDecode needs no decoding at all — the stream's bytes are the file. The
      fixture rewrites a Flate image's filter to DCTDecode rather than embedding
      a real JPEG, because what is under test is that the raw bytes are passed
      through untouched, and a real JPEG would only prove pdf-lib can embed one.
    */
    const base = await pdfWithImages([
      { png: solidPng(120, 60, [0, 68, 204]), width: 120, height: 60 },
    ]);
    const doc = await PDFDocument.load(base);
    let raw: Buffer | null = null;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
        obj.dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
        raw = Buffer.from(obj.contents);
        break;
      }
    }
    const found = await readLogoCandidates(await doc.save());
    expect(found[0]?.mimeType).toBe('image/jpeg');
    expect(found[0]!.bytes.equals(raw!)).toBe(true);
  });

  it('deduplicates the same logo repeated across pages', async () => {
    // A letterhead mark is on every page. Asking the author to choose between
    // three copies of one image is not a choice.
    const doc = await PDFDocument.create();
    const embedded = await doc.embedPng(solidPng(120, 60, [0, 68, 204]));
    for (let i = 0; i < 2; i += 1) {
      doc.addPage([600, 800]).drawImage(embedded, { x: 20, y: 700, width: 120, height: 60 });
    }
    expect(await readLogoCandidates(await doc.save())).toHaveLength(1);
  });

  it('returns nothing for a document with no images', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    expect(await readLogoCandidates(await doc.save())).toEqual([]);
  });

  it('returns nothing for a file that is not a PDF, rather than throwing', async () => {
    expect(await readLogoCandidates(Buffer.from('not a pdf'))).toEqual([]);
  });
});
