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
