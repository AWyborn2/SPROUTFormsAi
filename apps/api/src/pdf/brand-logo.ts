/**
 * Pulling a client's logo out of their own document.
 *
 * A logo placed in a PDF is an image XObject, and for the two encodings that
 * cover almost every real document the bytes can be recovered exactly:
 *
 *   DCTDecode  — the stream IS a JPEG. Nothing to do but hand it over.
 *   FlateDecode with DeviceRGB/DeviceGray at 8 bits — raw samples, wrapped
 *                into a PNG here (Node's zlib does the compression and the
 *                CRCs, so this is a header format, not an image codec).
 *
 * EVERYTHING ELSE IS SKIPPED, DELIBERATELY. Indexed and CMYK spaces, JPX,
 * CCITT, 1-bit masks and images carrying an SMask all need real decoding, and a
 * half-decoded logo is worse than none — it renders as a coloured smear on a
 * client's form and looks like a product fault rather than a skipped guess. The
 * author uploads one instead, which they could always do.
 *
 * CANDIDATES, NEVER A DECISION. A document's images are its logo, its signature
 * blocks, its hazard pictograms and its site photographs. Ranking puts the
 * plausible ones first; the author says which is the logo.
 */
import { deflateSync, crc32 } from 'node:zlib';
import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib';

/** Below this an image is an icon or a rule, not a logo. */
const MIN_EDGE = 24;
/**
 * Above this it is a scanned page or a photograph. A logo is a small graphic;
 * a 2000px-wide image in a form is the form itself, scanned.
 */
const MAX_EDGE = 2400;
/** Candidates returned. The author is choosing from swatches, not browsing. */
const MAX_CANDIDATES = 6;
/** Pages searched. A letterhead is on the first page or nowhere. */
const MAX_PAGES = 2;
/** Refuses a decompression bomb: a logo is not eight megabytes of samples. */
const MAX_RAW_BYTES = 8 * 1024 * 1024;

export interface LogoCandidate {
  /** Ready to upload through the existing logo door. */
  bytes: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

function pngChunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([len, typed, crc]);
}

/**
 * Wrap raw 8-bit samples in a PNG container.
 *
 * Every scanline is prefixed with filter byte 0 ("none"), which is what the
 * format requires and is why this cannot be a straight zlib of the sample
 * buffer. No filtering is attempted: the file is a few kilobytes larger and
 * this stays a header format rather than becoming an image codec.
 */
export function encodePng(
  samples: Buffer,
  width: number,
  height: number,
  channels: 1 | 3,
): Buffer {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    samples.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 1 ? 0 : 2; // greyscale | truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The `/Filter` entry, normalised — it may be a name or a one-entry array. */
function filterNames(dict: PDFDict): string[] {
  const filter = dict.get(PDFName.of('Filter'));
  if (!filter) return [];
  if (filter instanceof PDFName) return [filter.asString()];
  if ('asArray' in (filter as object)) {
    return (filter as never as { asArray(): unknown[] })
      .asArray()
      .filter((f): f is PDFName => f instanceof PDFName)
      .map((f) => f.asString());
  }
  return [];
}

function numberOf(dict: PDFDict, key: string): number | null {
  const value = dict.get(PDFName.of(key));
  return value instanceof PDFNumber ? value.asNumber() : null;
}

function nameOf(dict: PDFDict, key: string): string | null {
  const value = dict.get(PDFName.of(key));
  return value instanceof PDFName ? value.asString() : null;
}

/** One image XObject → a candidate, or null when it needs decoding we don't do. */
function toCandidate(stream: PDFRawStream): LogoCandidate | null {
  const dict = stream.dict;
  if (nameOf(dict, 'Subtype') !== '/Image') return null;

  const width = numberOf(dict, 'Width');
  const height = numberOf(dict, 'Height');
  if (!width || !height) return null;
  const maxEdge = Math.max(width, height);
  const minEdge = Math.min(width, height);
  if (minEdge < MIN_EDGE || maxEdge > MAX_EDGE) return null;

  /*
    An image with a soft mask is transparent, and dropping the mask fills that
    transparency with whatever the raw samples happen to hold — usually black.
    A logo delivered as a black box is worse than no logo at all.
  */
  if (dict.get(PDFName.of('SMask')) || dict.get(PDFName.of('Mask'))) return null;

  const filters = filterNames(dict);
  if (filters.includes('/DCTDecode')) {
    // Already a JPEG. Only a lone DCTDecode qualifies — a preceding filter
    // means the stream is wrapped in something else first.
    if (filters.length !== 1) return null;
    return { bytes: Buffer.from(stream.contents), mimeType: 'image/jpeg', width, height };
  }

  if (!filters.includes('/FlateDecode') || filters.length !== 1) return null;
  if (numberOf(dict, 'BitsPerComponent') !== 8) return null;
  const space = nameOf(dict, 'ColorSpace');
  const channels = space === '/DeviceRGB' ? 3 : space === '/DeviceGray' ? 1 : null;
  if (!channels) return null;
  if (width * height * channels > MAX_RAW_BYTES) return null;

  let samples: Buffer;
  try {
    // `getContents()` returns the stream STILL COMPRESSED — on a PDFRawStream
    // it is the raw bytes, which for a Flate image is a few dozen of them.
    // Decoding is what turns those into samples.
    samples = Buffer.from(decodePDFRawStream(stream).decode());
  } catch {
    return null;
  }
  // A truncated stream would produce a torn image; skip rather than ship it.
  if (samples.length < width * height * channels) return null;

  return {
    bytes: encodePng(samples, width, height, channels as 1 | 3),
    mimeType: 'image/png',
    width,
    height,
  };
}

/**
 * Logo candidates from a client's document, most plausible first.
 *
 * Ranked by area, SMALLEST first. A logo is a small graphic among larger ones —
 * the site photograph and the scanned signature block are both bigger than the
 * letterhead mark, so ordering by prominence would put exactly the wrong thing
 * at the front.
 */
export async function readLogoCandidates(pdfBytes: Uint8Array): Promise<LogoCandidate[]> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return [];
  }

  const found: LogoCandidate[] = [];
  const seen = new Set<string>();
  const pages = Math.min(doc.getPageCount(), MAX_PAGES);

  for (let i = 0; i < pages; i += 1) {
    let xobjects: PDFDict | undefined;
    try {
      const resources = doc.getPage(i).node.Resources();
      const xo = resources?.get(PDFName.of('XObject'));
      xobjects = xo instanceof PDFDict ? xo : undefined;
    } catch {
      continue;
    }
    if (!xobjects) continue;

    for (const [, ref] of xobjects.entries()) {
      let stream: unknown;
      try {
        stream = doc.context.lookup(ref as never);
      } catch {
        continue;
      }
      if (!(stream instanceof PDFRawStream)) continue;

      let candidate: LogoCandidate | null = null;
      try {
        candidate = toCandidate(stream);
      } catch {
        // A malformed XObject is one image with no signal, not a failed scan.
        continue;
      }
      if (!candidate) continue;

      // The same logo appears on every page of a letterhead, and often twice on
      // page one. Deduped so the author is not asked to choose between three
      // copies of one image.
      const key = `${candidate.mimeType}:${candidate.width}x${candidate.height}:${candidate.bytes.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(candidate);
    }
  }

  return found
    .sort((a, b) => a.width * a.height - b.width * b.height)
    .slice(0, MAX_CANDIDATES);
}
