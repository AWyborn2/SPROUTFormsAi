// @vitest-environment jsdom
/**
 * The lighter-weight component-level check for U2/KTD3 — the "Place all N"
 * button already loops `onSetOptionBox` once per proposed segment (see the
 * loop in `PlacementPanel` below), and that loop is EXACTLY the shape that
 * broke under the old `mutate()`: every synchronous call recomputed
 * `fields.map(...)` off the same pre-click snapshot, so only the last
 * segment's box survived.
 *
 * The primary regression coverage lives at the pure-function level in
 * `inspector/geometry-actions.test.ts` (`applyFieldChanges`), which is the
 * part the plan calls out as non-optional. This file is the "does the wiring
 * actually route through it" check: `PdfViewer` (heavy pdf.js canvas
 * rendering) and the derivation functions are stubbed so the test exercises
 * only `GeometryEditorScreen`'s own state management, not PDF parsing.
 */
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_CONTAINER, type FormField, type PageBox } from '@formai/shared';
import type { FormVersionDetail } from '../../lib/data/types.js';
import type { FieldProposal } from '../../lib/pdf-geometry.js';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useParams: () => ({ id: 'form1', versionId: 'v1' }),
}));

const version: { data: FormVersionDetail | undefined; isLoading: boolean } = {
  data: undefined,
  isLoading: false,
};
const saveMutate = vi.fn();
const publishMutate = vi.fn();

vi.mock('../../lib/data/hooks.js', () => ({
  useFormVersion: () => version,
  useSaveVersionFields: () => ({ mutate: saveMutate, isPending: false }),
  usePublishFormVersion: () => ({ mutate: publishMutate, isPending: false }),
}));

const toast = vi.fn();
vi.mock('@formai/ui', async () => {
  const actual = await vi.importActual<typeof import('@formai/ui')>('@formai/ui');
  return { ...actual, useToast: () => ({ toast }) };
});

// `PdfViewer` does real pdf.js canvas rendering — irrelevant to the batching
// bug and impractical to run under jsdom. Stubbed to a component that feeds
// `onTextLayer` one empty page (so the panel's proposal `useMemo` runs) and
// renders nothing else.
vi.mock('./PdfViewer.js', () => ({
  PdfViewer: ({ onTextLayer }: { onTextLayer: (pages: unknown[]) => void }) => {
    useEffect(() => {
      onTextLayer([{ width: 595, height: 842, items: [] }]);
    }, [onTextLayer]);
    return null;
  },
}));

/**
 * A fixed 3-segment proposal, standing in for what `deriveOptionCellsAcrossPages`
 * would derive from a real PDF text layer. Only this ONE function is stubbed —
 * `applyFieldChanges` and everything else in the module stays real, so the test
 * still exercises the actual batching fix, not a mock of it.
 */
const PROPOSAL: FieldProposal = {
  segments: (['Yes', 'No', 'Maybe'] as const).map(
    (optionKey, i): PageBox => ({
      page: 0,
      x: i * 20,
      y: 0,
      width: 10,
      height: 10,
      pageWidth: 595,
      pageHeight: 842,
      optionKey,
    }),
  ),
  confidence: 1,
  notes: [],
};

vi.mock('./inspector/geometry-actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./inspector/geometry-actions.js')>();
  return { ...actual, deriveOptionCellsAcrossPages: () => PROPOSAL };
});

const { GeometryEditorScreen } = await import('./GeometryEditorScreen.js');

function choiceField(id: string, label: string, options: string[]): FormField {
  return { id, type: 'checkbox_group', label, required: false, source: 'imported', options };
}

afterEach(() => {
  vi.clearAllMocks();
  version.data = undefined;
  version.isLoading = false;
});

describe('GeometryEditorScreen — batched "Place all N" (U2/KTD3)', () => {
  it('places every proposed option box, not just the last, in one click', () => {
    version.data = {
      id: 'v1',
      templateId: 'form1',
      label: 'Draft v1',
      state: 'draft',
      isCurrent: false,
      fields: [choiceField('f1', 'Multi-option field', ['Yes', 'No', 'Maybe'])],
      container: DEFAULT_CONTAINER,
      sourcePdfAssetId: 'asset-1',
    };

    render(<GeometryEditorScreen />);

    // Select the field so its panel — and the "Place all N" button — renders.
    fireEvent.click(screen.getByText('Multi-option field'));

    const placeAll = screen.getByText('Place all 3');
    fireEvent.click(placeAll);

    // Before U2 this loop's synchronous onSetOptionBox('Yes'/'No'/'Maybe')
    // calls each recomputed from the same pre-click snapshot, so only the
    // LAST call ('Maybe') survived and the row read "1/3 placed". All three
    // landing is the regression this test is for.
    expect(screen.getByText(/3\/3 placed/)).toBeDefined();
  });
});
