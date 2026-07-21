/**
 * Field inspector behaviour (import review, step 2).
 *
 * `apps/web` has no component-test setup — vitest runs in the `node`
 * environment, only picks up `src/**\/*.test.ts`, and `@testing-library/react`
 * is not a dependency. So these are logic-level tests against the
 * import-session action wrappers the inspector dispatches, plus the pure
 * `inspectorMode` helper that decides which of the three panel states
 * (prompt / section-header / full) renders. Every assertion that matters
 * ("survives to the publish payload") is made through `reviewedToFields`,
 * which is the real publish boundary.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractionResult } from '@formai/shared';

vi.mock('../../../lib/data/api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/data/api-client.js')>();
  return { ...actual, apiClient: { ...actual.apiClient, post: vi.fn() } };
});

import { apiClient } from '../../../lib/data/api-client.js';
import {
  addField,
  addFieldOption,
  addFixedRowItem,
  changeFieldType,
  deleteField,
  getImportSession,
  moveField,
  removeFieldOption,
  removeFixedRowItem,
  renameField,
  renameFixedRowItem,
  reorderFields,
  resetImportSession,
  reviewedToFields,
  setFieldOption,
  startExtraction,
  undoFieldEdit,
} from '../../../lib/data/import-session.js';
import { inspectorMode } from './FieldInspector.js';

const postMock = vi.mocked(apiClient.post);

const EXTRACTION: ExtractionResult = {
  sourceType: 'pdf_import',
  path: 'acroform',
  fileName: 'site-safety-audit.pdf',
  pageCount: 2,
  fields: [
    { id: 'f1', label: 'Auditor name', type: 'text', confidence: 0.98 },
    { id: 'f2', label: 'Site', type: 'text', confidence: 0.9 },
    {
      id: 'f3',
      label: 'Daily checks',
      type: 'repeating_group',
      confidence: 0.6,
      columns: [{ key: 'c1', label: 'Check', type: 'text' }],
      fixedRows: ['Extinguishers', 'Exits'],
    },
    { id: 'f4', label: 'Sign-off', type: 'section_header', confidence: 1 },
  ],
  designNotes: [],
};

/** The published payload — the only thing that actually reaches the form. */
function published() {
  return reviewedToFields(getImportSession().fields);
}

function labels() {
  return published().map((f) => f.label);
}

function byId(id: string) {
  return published().find((f) => f.id === id);
}

async function seed() {
  postMock.mockReset();
  postMock.mockResolvedValueOnce({ assetId: 'a1' } as never);
  postMock.mockResolvedValueOnce(EXTRACTION as never);
  await startExtraction(
    new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'site-safety-audit.pdf', {
      type: 'application/pdf',
    }),
  );
}

beforeEach(async () => {
  resetImportSession();
  await seed();
});

describe('inspector edits reach the publish payload', () => {
  it('renames a field in the review row and in the publish payload', () => {
    renameField('f1', 'Lead auditor');
    expect(getImportSession().fields.find((f) => f.id === 'f1')?.label).toBe('Lead auditor');
    expect(byId('f1')?.label).toBe('Lead auditor');
  });

  it('seeds default options when the type changes to dropdown', () => {
    changeFieldType('f2', 'dropdown');
    expect(byId('f2')?.type).toBe('dropdown');
    expect(byId('f2')?.options).toEqual(['Option 1', 'Option 2']);
  });

  it('edits, adds and removes options', () => {
    changeFieldType('f2', 'dropdown');
    setFieldOption('f2', 0, 'Depot A');
    addFieldOption('f2');
    expect(byId('f2')?.options).toEqual(['Depot A', 'Option 2', 'New option']);
    removeFieldOption('f2', 1);
    expect(byId('f2')?.options).toEqual(['Depot A', 'New option']);
  });

  it('deletes a field out of the publish payload', () => {
    deleteField('f2');
    expect(labels()).toEqual(['Auditor name', 'Daily checks', 'Sign-off']);
  });

  it('reorders fields into the published order', () => {
    reorderFields(0, 2);
    expect(labels()).toEqual(['Site', 'Daily checks', 'Auditor name', 'Sign-off']);
    moveField('f1', -1);
    expect(labels()).toEqual(['Site', 'Auditor name', 'Daily checks', 'Sign-off']);
  });

  it('inserts an added section header directly after the selected field', () => {
    const id = addField('section_header', 'f1');
    expect(id).toBeTruthy();
    expect(labels()).toEqual(['Auditor name', 'New section', 'Site', 'Daily checks', 'Sign-off']);
    expect(published()[1]!.type).toBe('section_header');
  });
});

describe('fixed-row checklist editing still works', () => {
  it('renames, adds and removes captured items', () => {
    renameFixedRowItem('f3', 0, 'Fire extinguishers');
    addFixedRowItem('f3', 'First aid kit');
    expect(byId('f3')?.fixedRows).toEqual(['Fire extinguishers', 'Exits', 'First aid kit']);
    removeFixedRowItem('f3', 1);
    expect(byId('f3')?.fixedRows).toEqual(['Fire extinguishers', 'First aid kit']);
  });
});

describe('undo', () => {
  it('reverses a label edit', () => {
    renameField('f1', 'Lead auditor');
    undoFieldEdit();
    expect(byId('f1')?.label).toBe('Auditor name');
  });

  it('reverses a delete', () => {
    deleteField('f2');
    expect(labels()).not.toContain('Site');
    undoFieldEdit();
    expect(labels()).toEqual(['Auditor name', 'Site', 'Daily checks', 'Sign-off']);
  });
});

describe('inspectorMode — the three non-happy-path states', () => {
  it('prompts when nothing is selected', () => {
    expect(inspectorMode(undefined)).toBe('prompt');
    expect(inspectorMode(null)).toBe('prompt');
  });

  it('falls back to the prompt when the selected field has been deleted', () => {
    const before = getImportSession().fields.find((f) => f.id === 'f2');
    expect(inspectorMode(before)).toBe('full');
    deleteField('f2');
    expect(inspectorMode(getImportSession().fields.find((f) => f.id === 'f2'))).toBe('prompt');
  });

  it('renders label + delete only for a section header', () => {
    expect(inspectorMode(getImportSession().fields.find((f) => f.id === 'f4'))).toBe('section');
  });
});
