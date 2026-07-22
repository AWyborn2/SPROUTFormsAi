/**
 * Test-only PDF builders. Produce the two golden inputs the pipeline tests
 * exercise: an AcroForm PDF with real fillable fields, and a flat PDF that only
 * carries drawn letterhead text (no form dictionary).
 */
import { PDFDocument, StandardFonts } from 'pdf-lib';

export const LETTERHEAD = 'MERIDIAN OPERATIONS';

/** A PDF with a defined AcroForm (text field, checkbox, dropdown). */
export async function makeAcroFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const form = doc.getForm();

  const name = form.createTextField('full_name');
  name.addToPage(page, { x: 100, y: 700, width: 220, height: 20 });

  const agree = form.createCheckBox('agree_terms');
  agree.addToPage(page, { x: 100, y: 650, width: 16, height: 16 });

  const category = form.createDropdown('category');
  category.addOptions(['Goods supplier', 'Services contractor']);
  category.addToPage(page, { x: 100, y: 600, width: 160, height: 20 });

  return doc.save();
}

/**
 * A four-page AcroForm PDF whose only field sits on page 3 (index 2).
 *
 * Exists to pin the page index an extracted position records. Every other
 * fixture here is single-page, which is exactly why a hardcoded `page: 0`
 * survived unnoticed — a one-page document cannot tell a real page index from
 * a default one. The compliance library is not one page: the dozer assessment
 * is eighteen.
 */
export async function makeMultiPageAcroFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  // Page 2 is LANDSCAPE while the rest are portrait, mirroring the dozer
  // assessment (595x842 and 842x595 in one file). Uniform page sizes would let
  // a "read dimensions from page 0" bug pass this fixture unnoticed.
  doc.addPage([600, 800]);
  doc.addPage([600, 800]);
  doc.addPage([900, 500]);
  doc.addPage([600, 800]);
  const form = doc.getForm();

  const assessor = form.createTextField('assessor_name');
  assessor.addToPage(doc.getPage(2), { x: 120, y: 300, width: 200, height: 18 });

  return doc.save();
}

/** A flat PDF: drawn letterhead + labels only, no AcroForm fields. */
export async function makeFlatPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(LETTERHEAD, { x: 40, y: 750, size: 18, font: bold });
  page.drawText('Facility inspection checklist', { x: 40, y: 720, size: 12, font });
  page.drawText('Site name: ________________', { x: 40, y: 680, size: 11, font });
  page.drawText('Inspector signature: ______', { x: 40, y: 650, size: 11, font });
  return doc.save();
}
