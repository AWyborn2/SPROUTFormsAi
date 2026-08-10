/**
 * Reading a client's colours off their own document.
 *
 * Two properties. The first is that BLACK AND GREY DO NOT WIN: text, rules and
 * the page itself are the three most frequent colours in nearly every document
 * and none of them is a brand, so a proposal led by `#000000` would be
 * technically correct and useless. The second is that a document yielding
 * nothing says so — inventing a brand colour for a monochrome form would be
 * worse than offering none.
 *
 * The fixtures are REAL PDFs built by pdf-lib, not hand-written content
 * streams, so the parsing is exercised against bytes a generator actually
 * emits — including the Flate encoding, which a string fixture would skip.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, rgb, cmyk, StandardFonts } from 'pdf-lib';
import { colorsInContentStream, readBrandColors } from './brand-colors.js';

/** A one-page document drawing each colour as a filled rectangle. */
async function pdfWith(
  colors: { color: ReturnType<typeof rgb> | ReturnType<typeof cmyk>; times?: number }[],
  pages = 1,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let p = 0; p < pages; p += 1) {
    const page = doc.addPage([600, 800]);
    for (const { color, times = 1 } of colors) {
      for (let i = 0; i < times; i += 1) {
        page.drawRectangle({ x: 20 + i, y: 700, width: 40, height: 20, color });
      }
    }
  }
  return doc.save();
}

describe('colorsInContentStream', () => {
  it('reads an RGB fill', () => {
    expect(colorsInContentStream('0 0.266 0.8 rg')).toEqual(['#0044cc']);
  });

  it('reads a stroke colour as well as a fill', () => {
    // A client's rule colour is as much their brand as their heading fill, and
    // some documents set only one of the two.
    expect(colorsInContentStream('0 0.266 0.8 RG')).toEqual(['#0044cc']);
  });

  it('converts CMYK, which is what a print-origin document carries', () => {
    // Almost every form that started life at a printer is CMYK. Reading only
    // RGB would return nothing for exactly the documents this feature is for.
    expect(colorsInContentStream('1 0.734 0 0.2 k')).toEqual(['#0036cc']);
  });

  it('DROPS BLACK, WHITE AND GREY', () => {
    /*
      The property that makes the proposal usable. Text is black, rules are
      grey, the page is white — they are the most frequent colours in nearly
      every document and none of them is a brand.
    */
    expect(colorsInContentStream('0 0 0 rg 1 1 1 rg 0.5 0.5 0.5 rg 0.52 0.5 0.5 rg')).toEqual([]);
  });

  it('keeps a colour that is merely dark', () => {
    // A navy letterhead is dark AND coloured. Dropping by lightness rather
    // than by saturation would lose the most common corporate primary there is.
    expect(colorsInContentStream('0.05 0.1 0.35 rg')).toEqual(['#0d1a59']);
  });

  it('reads a three-operand scn as RGB and a four-operand one as CMYK', () => {
    expect(colorsInContentStream('0 0.266 0.8 scn')).toEqual(['#0044cc']);
    expect(colorsInContentStream('1 0.734 0 0.2 scn')).toEqual(['#0036cc']);
  });

  it('ignores a one-operand scn, whose meaning depends on a colour space', () => {
    /*
      With one operand the space is almost always greyscale or a separation
      tint, and resolving it needs a colour space dictionary this does not read.
      Guessing would produce confident nonsense — a spot colour reported as a
      grey it is not.
    */
    expect(colorsInContentStream('0.8 scn')).toEqual([]);
  });

  it('does not match an operator that merely ends in the same letters', () => {
    // `rg` inside a longer token is a different operator, not a fill.
    expect(colorsInContentStream('0 0.266 0.8 rgx')).toEqual([]);
  });

  it('keeps duplicates, because the caller counts them', () => {
    expect(colorsInContentStream('0 0.266 0.8 rg 0 0.266 0.8 rg')).toHaveLength(2);
  });
});

describe('readBrandColors', () => {
  it('finds the colour a real document draws with', async () => {
    const bytes = await pdfWith([{ color: rgb(0, 0.266, 0.8) }]);
    expect((await readBrandColors(bytes)).colors).toContain('#0044cc');
  });

  it('orders by how often a colour is set', async () => {
    const bytes = await pdfWith([
      { color: rgb(0.8, 0.1, 0.1), times: 1 },
      { color: rgb(0, 0.266, 0.8), times: 4 },
    ]);
    expect((await readBrandColors(bytes)).colors[0]).toBe('#0044cc');
  });

  it('reads past the first page', async () => {
    // A letterhead is usually on page one, but a client's colour may first
    // appear on a continuation sheet.
    const bytes = await pdfWith([{ color: rgb(0, 0.266, 0.8) }], 2);
    expect((await readBrandColors(bytes)).colors).toContain('#0044cc');
  });

  it('SAYS SO when the document has no colour at all', async () => {
    // A monochrome form is a normal outcome, not a failure. Reported as one so
    // the author knows to pick the colours themselves rather than waiting.
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    page.drawText('SITE ACCESS PERMIT', {
      x: 40,
      y: 750,
      font: await doc.embedFont(StandardFonts.Helvetica),
      color: rgb(0, 0, 0),
    });
    const result = await readBrandColors(await doc.save());
    expect(result.colors).toEqual([]);
    expect(result.notes.join(' ')).toMatch(/black and white/i);
  });

  it('says how many pages it read when it stopped early', async () => {
    // "We looked at three pages" is a different statement from "this document
    // has these colours", and the author is entitled to the difference.
    const bytes = await pdfWith([{ color: rgb(0, 0.266, 0.8) }], 6);
    expect((await readBrandColors(bytes)).notes.join(' ')).toMatch(/first 3 of 6 pages/i);
  });

  it('reports an unreadable file rather than throwing', async () => {
    // A client's document is a real-world file and some of them are strange.
    // A scan that throws takes down the request that asked for a suggestion.
    const result = await readBrandColors(Buffer.from('not a pdf'));
    expect(result.colors).toEqual([]);
    expect(result.notes.join(' ')).toMatch(/could not be read/i);
  });
});
