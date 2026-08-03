// @vitest-environment jsdom
/**
 * Component-level checks for U2/KTD3 (batched "Place all N") and U3
 * (select-to-propose with auto-tiering).
 *
 * The primary regression coverage for the batching fix lives at the
 * pure-function level in `inspector/geometry-actions.test.ts`
 * (`applyFieldChanges`), which is the part the plan calls out as
 * non-optional. This file is the "does the wiring actually route through it"
 * check: `PdfViewer` (heavy pdf.js canvas rendering) and the derivation
 * functions are stubbed so the test exercises only `GeometryEditorScreen`'s
 * own state management, not PDF parsing.
 */
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// `PdfViewer` does real pdf.js canvas rendering — irrelevant here and
// impractical to run under jsdom. Stubbed to a component that feeds
// `onTextLayer` one page. Both `selectField` and the panel's own proposal
// `useMemo` bail out while `textPages` is empty, so a non-empty pages array
// is required for either to run at all — an empty `items` list is enough,
// since the derivation function itself is stubbed below.
vi.mock('./PdfViewer.js', () => ({
  PdfViewer: ({ onTextLayer }: { onTextLayer: (pages: unknown[]) => void }) => {
    useEffect(() => {
      onTextLayer([{ width: 595, height: 842, items: [] }]);
    }, [onTextLayer]);
    return null;
  },
}));

/**
 * `deriveOptionCellsAcrossPages` is the only derivation function stubbed —
 * `applyFieldChanges`, `classifyProposalTier`, and everything else in the
 * module stays real, so a test still exercises the actual tiering and
 * batching logic, not a mock of it. A `vi.fn()` rather than a fixed stub so
 * each test can drive a different tier by controlling the returned
 * confidence; hoisted because `vi.mock` factories run before the rest of the
 * module body executes.
 */
const { deriveOptionCellsAcrossPagesMock } = vi.hoisted(() => ({
  deriveOptionCellsAcrossPagesMock: vi.fn(),
}));

vi.mock('./inspector/geometry-actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./inspector/geometry-actions.js')>();
  return { ...actual, deriveOptionCellsAcrossPages: deriveOptionCellsAcrossPagesMock };
});

const { GeometryEditorScreen } = await import('./GeometryEditorScreen.js');

function choiceField(
  id: string,
  label: string,
  options: string[],
  geometry?: FormField['geometry'],
): FormField {
  return { id, type: 'checkbox_group', label, required: false, source: 'imported', options, geometry };
}

/**
 * A 3-segment proposal at a given confidence, standing in for what
 * `deriveOptionCellsAcrossPages` would derive from a real PDF text layer.
 */
function proposal(confidence: number): FieldProposal {
  return {
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
    confidence,
    notes: [],
  };
}

function renderWithField(field: FormField) {
  version.data = {
    id: 'v1',
    templateId: 'form1',
    label: 'Draft v1',
    state: 'draft',
    isCurrent: false,
    fields: [field],
    container: DEFAULT_CONTAINER,
    sourcePdfAssetId: 'asset-1',
  };
  render(<GeometryEditorScreen />);
}

beforeEach(() => {
  // A clean, fully-confident match by default — individual tests override
  // this to drive the needs-review / no-match tiers.
  deriveOptionCellsAcrossPagesMock.mockReturnValue(proposal(1));
});

afterEach(() => {
  vi.clearAllMocks();
  version.data = undefined;
  version.isLoading = false;
});

describe('GeometryEditorScreen — batched "Place all N" (U2/KTD3)', () => {
  it('places every proposed option box, not just the last, in one click', () => {
    // One option already placed ("Yes") so selecting the field does not
    // itself auto-confirm the rest (U3's `geometrySegments(f).length === 0`
    // eligibility check no longer applies) — this test is specifically about
    // the "Place all N" button's own click handler, which loops over
    // `onSetOptionBox` once per segment.
    renderWithField(
      choiceField('f1', 'Multi-option field', ['Yes', 'No', 'Maybe'], {
        segments: [
          { page: 0, x: 0, y: 0, width: 10, height: 10, pageWidth: 595, pageHeight: 842, optionKey: 'Yes' },
        ],
      }),
    );

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

describe('GeometryEditorScreen — select-to-propose with auto-tiering (U3)', () => {
  it('AE1: auto-confirms a clear multi-option match on selection alone, with no extra click', () => {
    renderWithField(choiceField('f1', 'Multi-option field', ['Yes', 'No', 'Maybe']));

    fireEvent.click(screen.getByText('Multi-option field'));

    // No "Place all N" click anywhere in this test — selecting the field is
    // the ONLY action taken. All 3 options must land from that alone. Had
    // `selectField`'s auto-confirm path looped individual `mutate()` calls
    // instead of routing through `mutateMany` (the exact KTD3 batching bug
    // U2 fixed for the button), only the last option ("Maybe") would have
    // survived and this would read "1/3 placed".
    expect(screen.getByText(/3\/3 placed/)).toBeDefined();
  });

  it('AE2: a plausible-but-ambiguous match tiers needs-review and leaves edited untouched', () => {
    renderWithField(choiceField('f1', 'Ambiguous field', ['Yes', 'No', 'Maybe']));
    deriveOptionCellsAcrossPagesMock.mockReturnValue(proposal(0.6));

    fireEvent.click(screen.getByText('Ambiguous field'));

    // Nothing auto-applied — the placed count stays at zero.
    expect(screen.getByText(/0\/3 placed/)).toBeDefined();
    // The proposal is still surfaced (parked for preview) so the reviewer
    // can apply it themselves.
    expect(screen.getByText('Place all 3')).toBeDefined();
  });

  it('AE3: no match falls back to the empty Draw state, unchanged', () => {
    renderWithField(choiceField('f1', 'Unmatched field', ['Yes', 'No', 'Maybe']));
    deriveOptionCellsAcrossPagesMock.mockReturnValue(null);

    fireEvent.click(screen.getByText('Unmatched field'));

    expect(screen.getByText(/0\/3 placed/)).toBeDefined();
    expect(screen.queryByText(/Place all/)).toBeNull();

    // The manual Draw path is untouched by this unit: arming a Draw button
    // still works exactly as before.
    const drawButtons = screen.getAllByText('Draw');
    fireEvent.click(drawButtons[0]!);
    expect(screen.getByText('Drawing…')).toBeDefined();
  });

  it('R4: selecting an already-placed field does not re-derive or re-tier it', () => {
    renderWithField(
      choiceField('f1', 'Already placed field', ['Yes', 'No', 'Maybe'], {
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
      }),
    );
    deriveOptionCellsAcrossPagesMock.mockClear();

    fireEvent.click(screen.getByText('Already placed field'));

    // `PlacementPanel`'s own preview `useMemo` (pre-existing, unit-scoped
    // elsewhere) still calls the derivation once to render its own proposal
    // box — that call is not this unit's concern. What R4 guards is that
    // `selectField` itself does not ALSO call it: a second call here would
    // mean selection re-derived and re-tiered an already-placed field.
    expect(deriveOptionCellsAcrossPagesMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/3\/3 placed/)).toBeDefined();
  });
});
