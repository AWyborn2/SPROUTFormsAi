// @vitest-environment jsdom
/**
 * The secondary-extraction panel.
 *
 * The behaviours that make it a safe review aid: it stays out of the way when
 * there is no PDF to re-read, it audits against everything the draft already
 * holds (field, column AND fixed-row labels, so a table's own columns are not
 * re-reported), and a clean result is stated as plainly as a dirty one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { FormField } from '@formai/shared';
import type { BuilderDraftState } from './use-builder-draft.js';

const auditState: {
  mutate: ReturnType<typeof vi.fn>;
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  data: { missedInputs: Array<Record<string, unknown>> } | undefined;
} = { mutate: vi.fn(), isPending: false, isSuccess: false, isError: false, data: undefined };

vi.mock('../../../lib/data/hooks.js', () => ({
  useAuditForm: () => auditState,
}));

const { MissedBoxAudit } = await import('./MissedBoxAudit.js');

const addField = vi.fn();

function draft(over: Partial<BuilderDraftState> = {}): BuilderDraftState {
  return {
    assetId: 'org-1/x.pdf',
    title: 'Scraper',
    fields: [],
    structure: [
      { key: 'sec_cover', label: 'Candidate declaration', cols: 1, fields: [{ id: 'sig' }], cover: true },
      { key: 'sec_p1', label: 'PART 1 — THEORY', cols: 1, fields: [{ id: 'q1' }] },
      { key: 'sec_p2', label: 'PART 2 — PRACTICAL', cols: 1, fields: [] },
    ],
    fieldOps: { add: addField },
    ...over,
  } as unknown as BuilderDraftState;
}

afterEach(() => {
  vi.clearAllMocks();
  auditState.isPending = false;
  auditState.isSuccess = false;
  auditState.isError = false;
  auditState.data = undefined;
});

describe('MissedBoxAudit', () => {
  it('renders nothing without a source PDF to re-read', () => {
    const { container } = render(<MissedBoxAudit draft={draft({ assetId: undefined })} />);
    expect(container.firstChild).toBeNull();
  });

  it('audits against field, column and fixed-row labels', () => {
    const fields: FormField[] = [
      { id: 'f1', type: 'text', label: 'Candidate name', required: false, source: 'imported' },
      {
        id: 'f2',
        type: 'repeating_group',
        label: 'Logbook',
        required: false,
        source: 'imported',
        columns: [
          { key: 'date', label: 'Date', type: 'date' },
          { key: 'hrs', label: 'Hours', type: 'text' },
        ],
        fixedRows: ['Topsoil'],
      },
    ];
    render(<MissedBoxAudit draft={draft({ fields })} />);
    fireEvent.click(screen.getByRole('button'));

    expect(auditState.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: 'org-1/x.pdf',
        documentType: 'assessment',
        knownLabels: ['Candidate name', 'Logbook', 'Date', 'Hours', 'Topsoil'],
      }),
    );
  });

  it('states plainly when nothing was missed', () => {
    auditState.isSuccess = true;
    auditState.data = { missedInputs: [] };
    render(<MissedBoxAudit draft={draft()} />);
    expect(screen.getByText(/No missed boxes/)).toBeDefined();
  });

  it('lists the missed boxes, with page and note', () => {
    auditState.isSuccess = true;
    auditState.data = {
      missedInputs: [
        { label: 'Assessor signature', type: 'text', page: 12, note: 'blank line under declaration' },
      ],
    };
    render(<MissedBoxAudit draft={draft()} />);

    expect(screen.getByText('Assessor signature')).toBeDefined();
    expect(screen.getByText(/blank line under declaration/)).toBeDefined();
    expect(screen.getByText(/1 printed box may have no field/)).toBeDefined();
  });

  it('shows a soft error when the check fails', () => {
    auditState.isError = true;
    render(<MissedBoxAudit draft={draft()} />);
    expect(screen.getByText(/Could not check the document/)).toBeDefined();
  });

  it('adds a missed box as a field at the end of the chosen section, then marks it added', () => {
    auditState.isSuccess = true;
    auditState.data = { missedInputs: [{ label: 'Assessor signature', type: 'signature', page: 12 }] };
    render(<MissedBoxAudit draft={draft()} />);

    // Default target is the first NON-cover section (PART 1), which already
    // holds q1 — so the field is added after it, at the section's end.
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    expect(addField).toHaveBeenCalledWith('sec_p1', 'q1', 'signature', 'Assessor signature');

    // The row flips to "Added" and offers no second add.
    expect(screen.getByText(/Added to PART 1 — THEORY/)).toBeDefined();
    expect(screen.queryByRole('button', { name: /Add/ })).toBeNull();
  });

  it('adds to a different section when one is picked, and never offers a cover section', () => {
    auditState.isSuccess = true;
    auditState.data = { missedInputs: [{ label: 'Second witness', type: 'text' }] };
    render(<MissedBoxAudit draft={draft()} />);

    const select = screen.getByLabelText('Section to add "Second witness" to') as HTMLSelectElement;
    // Cover sections are addressed by the manifest, not added as part fields.
    expect([...select.options].map((o) => o.value)).toEqual(['sec_p1', 'sec_p2']);

    fireEvent.change(select, { target: { value: 'sec_p2' } });
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    // PART 2 is empty, so the field is added first (afterFieldId null).
    expect(addField).toHaveBeenCalledWith('sec_p2', null, 'text', 'Second witness');
  });
});
