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
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_CONTAINER, type FormField, type PageBox } from '@formai/shared';
import type { FormVersionDetail } from '../../lib/data/types.js';
import type { FieldProposal, PositionedText } from '../../lib/pdf-geometry.js';
import type { BandHandle } from './inspector/geometry-actions.js';
import type { PlacementMark } from './PdfViewer.js';

/**
 * The subset of real `PdfViewerProps` this suite exercises through the
 * stubbed `PdfViewer` (U6) — `PdfViewerProps` itself is not exported, and the
 * stub only ever needs these fields, so this stands in for it rather than
 * widening the real component's public surface just for a test.
 */
interface MockPdfViewerProps {
  onTextLayer: (pages: unknown[]) => void;
  bandOverlay?: PageBox | null;
  bandSnapTargets?: readonly number[];
  bandSnapTargetsY?: readonly number[];
  onBandEdge?: (handle: BandHandle, value: number) => void;
  placements?: readonly PlacementMark[];
}

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

/**
 * `PdfViewer` does real pdf.js canvas rendering — irrelevant here and
 * impractical to run under jsdom. Stubbed to a component that feeds
 * `onTextLayer` one page. Both `selectField` and the panel's own proposal
 * `useMemo` bail out while `textPages` is empty, so a non-empty pages array
 * is required for either to run at all — an empty `items` list is enough,
 * since the derivation function itself is stubbed below.
 *
 * `pdfViewerPropsSpy` records every render's props (U6) so a test can inspect
 * what `GeometryEditorScreen` computed for `bandOverlay`/`bandSnapTargets`/
 * `bandSnapTargetsY`/`onBandEdge`/`placements` without needing the real
 * `BandGrid` DOM, which lives entirely inside the stubbed-out `PdfViewer`.
 * `stubTextLayerItems` lets a test drive what the one fed page's `items` are
 * (defaulting to none), so a snap-target test can assert the value fed to
 * `PdfViewer` was actually derived from this page's own text.
 */
const { pdfViewerPropsSpy, stubTextLayerItems } = vi.hoisted(() => ({
  pdfViewerPropsSpy: vi.fn<(props: MockPdfViewerProps) => void>(),
  stubTextLayerItems: { current: [] as { text: string; x: number; y: number; width: number }[] },
}));

vi.mock('./PdfViewer.js', () => ({
  PdfViewer: (props: MockPdfViewerProps) => {
    pdfViewerPropsSpy(props);
    useEffect(() => {
      props.onTextLayer([{ width: 595, height: 842, items: stubTextLayerItems.current }]);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.onTextLayer]);
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
 *
 * `applyFieldChangesSpy` wraps the REAL `applyFieldChanges` (it still calls
 * through to `actual.applyFieldChanges`) purely to count invocations — this is
 * how the U4 bulk tests prove "Auto-place remaining fields" folds every
 * auto-confirm field's changes into ONE `mutateMany`/`applyFieldChanges` call
 * for the whole run, not one call per field (the KTD3-shaped bug U2 already
 * fixed once for the "Place all N" button).
 */
const { deriveOptionCellsAcrossPagesMock, applyFieldChangesSpy } = vi.hoisted(() => ({
  deriveOptionCellsAcrossPagesMock: vi.fn(),
  applyFieldChangesSpy: vi.fn(),
}));

vi.mock('./inspector/geometry-actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./inspector/geometry-actions.js')>();
  return {
    ...actual,
    deriveOptionCellsAcrossPages: deriveOptionCellsAcrossPagesMock,
    applyFieldChanges: (...args: Parameters<typeof actual.applyFieldChanges>) => {
      applyFieldChangesSpy(...args);
      return actual.applyFieldChanges(...args);
    },
  };
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
  renderWithFields([field]);
}

function renderWithFields(fields: FormField[]) {
  version.data = {
    id: 'v1',
    templateId: 'form1',
    label: 'Draft v1',
    state: 'draft',
    isCurrent: false,
    fields,
    container: DEFAULT_CONTAINER,
    sourcePdfAssetId: 'asset-1',
  };
  render(<GeometryEditorScreen />);
}

/**
 * Click "Auto-place remaining fields" and flush the deferred pass.
 *
 * `autoPlaceRemaining` defers its work a frame (via `requestAnimationFrame`)
 * so the "Auto-placing…" busy state has a chance to actually paint before the
 * synchronous loop runs — see `GeometryEditorScreen.tsx`. jsdom's rAF is a
 * real (if approximate) timer, so a click alone does not run the pass; this
 * helper waits for it the same way the browser would.
 */
async function clickAutoPlace() {
  fireEvent.click(screen.getByText('Auto-place remaining fields'));
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

/**
 * A repeating-table field already placed with ONE banded segment (U6) — a
 * non-choice field, so `bandOverlayFor`'s per-option exclusion does not apply
 * and its own existing segment is eligible to become the `bandOverlay`.
 */
function tableFieldWithSegment(id: string, label: string): FormField {
  return {
    id,
    type: 'repeating_group',
    label,
    required: false,
    source: 'imported',
    columns: [{ key: 'item', label: 'Item', type: 'text' }],
    geometry: {
      segments: [
        {
          page: 0,
          x: 10,
          y: 10,
          width: 100,
          height: 50,
          pageWidth: 595,
          pageHeight: 842,
          columnBands: [{ key: 'c1', start: 20, end: 40 }],
          rowBands: [{ key: 'r1', start: 15, end: 25 }],
        },
      ],
    },
  };
}

/** A field whose 3 options are already fully placed — the `expectedBoxes` boundary. */
function fullyPlacedChoiceField(id: string, label: string): FormField {
  return choiceField(id, label, ['Yes', 'No', 'Maybe'], {
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
  });
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
  stubTextLayerItems.current = [];
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

describe('GeometryEditorScreen — bulk "Auto-place remaining fields" (U4)', () => {
  it('Covers AE4: runs the same tiering across every unplaced field, applying auto-confirm fields in one batched update and leaving needs-review/no-match fields untouched', async () => {
    renderWithFields([
      choiceField('f1', 'Auto A', ['Yes', 'No', 'Maybe']),
      choiceField('f2', 'Auto B', ['Yes', 'No', 'Maybe']),
      choiceField('f3', 'Needs review', ['Yes', 'No', 'Maybe']),
      choiceField('f4', 'No match', ['Yes', 'No', 'Maybe']),
    ]);

    // Drive a different tier per field by label, standing in for what real
    // derivation would settle on per field.
    deriveOptionCellsAcrossPagesMock.mockImplementation((field: { label: string }) => {
      if (field.label === 'Needs review') return proposal(0.6);
      if (field.label === 'No match') return null;
      return proposal(1);
    });
    applyFieldChangesSpy.mockClear();

    await clickAutoPlace();

    // The two auto-confirm fields landed all 3 options each...
    expect(screen.getAllByText(/3\/3 placed/)).toHaveLength(2);
    // ...while the needs-review and no-match fields are exactly as before.
    expect(screen.getAllByText(/0\/3 placed/)).toHaveLength(2);
    expect(screen.getByText('2 of 4 answerable fields placed')).toBeDefined();

    // The crux of the fix: every auto-confirm field's changes were folded
    // into ONE `applyFieldChanges` call for the whole run (inside a single
    // `mutateMany`), not one call per field. Two separate per-field calls
    // would still reach the same end state here (each call's functional
    // `setState` updater threads off the previous one), so this call-count
    // assertion — not just the placed-count checks above — is what actually
    // distinguishes one batched call from N separate ones.
    expect(applyFieldChangesSpy).toHaveBeenCalledTimes(1);
  });

  it('Covers AE4: a field already fully placed is excluded from the loop — derivation is never even called for it, and it is left unchanged', async () => {
    renderWithFields([fullyPlacedChoiceField('f-full', 'Full field'), choiceField('f-eligible', 'Eligible field', ['Yes', 'No', 'Maybe'])]);

    deriveOptionCellsAcrossPagesMock.mockClear();
    deriveOptionCellsAcrossPagesMock.mockReturnValue(proposal(1));

    await clickAutoPlace();

    // Only the eligible field was ever handed to derivation — the fully
    // placed field's box count (3 >= expectedBoxes of 3) excluded it before
    // `deriveProposal` was ever reached.
    expect(deriveOptionCellsAcrossPagesMock).toHaveBeenCalledTimes(1);
    expect(deriveOptionCellsAcrossPagesMock.mock.calls[0]![0]).toMatchObject({ label: 'Eligible field' });

    // Both fields read 3/3 now — the already-placed field unchanged, the
    // eligible one freshly auto-confirmed.
    expect(screen.getAllByText(/3\/3 placed/)).toHaveLength(2);
  });

  it('a field with some but not all options placed is still evaluated, and gets its missing options auto-placed', async () => {
    renderWithField(
      choiceField('f1', 'Partial field', ['Yes', 'No', 'Maybe'], {
        segments: [
          { page: 0, x: 0, y: 0, width: 10, height: 10, pageWidth: 595, pageHeight: 842, optionKey: 'Yes' },
        ],
      }),
    );
    deriveOptionCellsAcrossPagesMock.mockReturnValue(proposal(1));

    await clickAutoPlace();

    expect(screen.getByText(/3\/3 placed/)).toBeDefined();
  });

  it('is a no-op when every field is already fully placed — no crash, no state change', async () => {
    renderWithField(fullyPlacedChoiceField('f-full', 'Full field'));
    deriveOptionCellsAcrossPagesMock.mockClear();

    await clickAutoPlace();

    // Fully placed already, so nothing was eligible: derivation never ran...
    expect(deriveOptionCellsAcrossPagesMock).not.toHaveBeenCalled();
    // ...and nothing was staged for save.
    expect(screen.queryByText(/unsaved changes/)).toBeNull();
    expect(screen.getByText(/3\/3 placed/)).toBeDefined();
  });
});

describe('GeometryEditorScreen — needs-review queue: bulk confirm and step-through (U5)', () => {
  function threePendingFields() {
    return [
      choiceField('f1', 'Field A', ['Yes', 'No', 'Maybe']),
      choiceField('f2', 'Field B', ['Yes', 'No', 'Maybe']),
      choiceField('f3', 'Field C', ['Yes', 'No', 'Maybe']),
    ];
  }

  it('Covers AE6: with no pending fields, the review queue section is hidden', () => {
    renderWithField(choiceField('f1', 'Solo field', ['Yes', 'No', 'Maybe']));

    expect(screen.queryByText(/need review/)).toBeNull();
    expect(screen.queryByText('Confirm all proposed')).toBeNull();
  });

  it('Covers AE6: "Confirm all proposed" applies all 3 pending fields in one batched update and empties the review queue', async () => {
    renderWithFields(threePendingFields());
    // Every field tiers needs-review, so the bulk pass parks all 3 rather than
    // auto-confirming any of them.
    deriveOptionCellsAcrossPagesMock.mockReturnValue(proposal(0.6));

    await clickAutoPlace();

    // The queue count reflects the addition from the bulk pass.
    expect(screen.getByText('3 fields need review')).toBeDefined();
    expect(screen.getAllByText(/0\/3 placed/)).toHaveLength(3);

    applyFieldChangesSpy.mockClear();
    fireEvent.click(screen.getByText('Confirm all proposed'));

    // The crux of the batching assertion: every one of the 3 pending fields'
    // changes were folded into ONE `applyFieldChanges` call (inside a single
    // `mutateMany`), not one call per field — three separate per-field calls
    // would still reach the same end state below (each threading off the
    // previous functional `setState` update), so this call-count check is
    // what actually proves single-call batching rather than a loop of calls
    // that merely converges to the right answer.
    expect(applyFieldChangesSpy).toHaveBeenCalledTimes(1);

    // All 3 fields landed all 3 options each, and the queue emptied.
    expect(screen.getAllByText(/3\/3 placed/)).toHaveLength(3);
    expect(screen.queryByText(/need review/)).toBeNull();
    expect(screen.queryByText('Confirm all proposed')).toBeNull();
  });

  it('Covers AE6: opening one needs-review field and rejecting it clears only that field, leaving the other 2 pending', async () => {
    renderWithFields(threePendingFields());
    deriveOptionCellsAcrossPagesMock.mockReturnValue(proposal(0.6));

    await clickAutoPlace();
    expect(screen.getByText('3 fields need review')).toBeDefined();

    // Open Field B from the queue — this should just navigate (select it in
    // the main panel) without touching the parked proposals.
    fireEvent.click(screen.getByLabelText('Review Field B'));
    expect(screen.getByText('3 fields need review')).toBeDefined();

    // Reject it.
    fireEvent.click(screen.getByLabelText('Reject Field B'));

    // Only Field B's proposal cleared — Field A and Field C are still
    // pending, unconfirmed (still 0/3 placed), and still in the queue.
    expect(screen.getByText('2 fields need review')).toBeDefined();
    expect(screen.getByLabelText('Review Field A')).toBeDefined();
    expect(screen.getByLabelText('Review Field C')).toBeDefined();
    expect(screen.queryByLabelText('Review Field B')).toBeNull();
    expect(screen.getAllByText(/0\/3 placed/)).toHaveLength(3);

    // Field B fell back to the plain draw-only state: rejecting only cleared
    // its parked review-queue entry (asserted above), and the manual Draw
    // fallback still works on it — it's still the selected field, having
    // been opened via `openReviewField` (R6).
    const drawButtons = screen.getAllByText('Draw');
    fireEvent.click(drawButtons[0]!);
    expect(screen.getByText('Drawing…')).toBeDefined();
  });

  it('Covers AE6: confirming one field individually applies just that field, scoped to it, leaving the other 2 pending', async () => {
    renderWithFields(threePendingFields());
    deriveOptionCellsAcrossPagesMock.mockReturnValue(proposal(0.6));

    await clickAutoPlace();
    expect(screen.getByText('3 fields need review')).toBeDefined();

    applyFieldChangesSpy.mockClear();
    fireEvent.click(screen.getByLabelText('Confirm Field B'));

    // Scoped to just Field B: one batched call for this single field...
    expect(applyFieldChangesSpy).toHaveBeenCalledTimes(1);
    // ...Field B is now placed, Field A and Field C remain unconfirmed...
    expect(screen.getAllByText(/3\/3 placed/)).toHaveLength(1);
    expect(screen.getAllByText(/0\/3 placed/)).toHaveLength(2);
    // ...and the queue reflects the removal, with only the other 2 left.
    expect(screen.getByText('2 fields need review')).toBeDefined();
    expect(screen.getByLabelText('Review Field A')).toBeDefined();
    expect(screen.getByLabelText('Review Field C')).toBeDefined();
    expect(screen.queryByLabelText('Review Field B')).toBeNull();
  });
});

describe('GeometryEditorScreen — review-fix regressions (P1 findings from code review)', () => {
  it('regression: selecting an unrelated field from the plain sidebar list does not clear other fields\' parked needs-review proposals', async () => {
    renderWithFields([
      choiceField('f1', 'Field A', ['Yes', 'No', 'Maybe']),
      choiceField('f2', 'Field B', ['Yes', 'No', 'Maybe']),
      choiceField('f3', 'Field C', ['Yes', 'No', 'Maybe']),
      choiceField('f4', 'Unrelated field', ['Yes', 'No', 'Maybe']),
    ]);
    deriveOptionCellsAcrossPagesMock.mockImplementation((field: { label: string }) =>
      field.label === 'Unrelated field' ? null : proposal(0.6),
    );

    await clickAutoPlace();
    expect(screen.getByText('3 fields need review')).toBeDefined();

    // Select a field NOT in the queue, via its plain sidebar row — this used
    // to call `setProposalPreviews([])` unconditionally and wipe every
    // OTHER field's parked proposal too.
    fireEvent.click(screen.getByText('Unrelated field'));

    expect(screen.getByText('3 fields need review')).toBeDefined();
    expect(screen.getByLabelText('Review Field A')).toBeDefined();
    expect(screen.getByLabelText('Review Field B')).toBeDefined();
    expect(screen.getByLabelText('Review Field C')).toBeDefined();
  });

  it("regression: bulk auto-place does not overwrite an already-placed option's existing box on a partially-placed field", async () => {
    const existingBox: PageBox = {
      page: 0,
      x: 999,
      y: 999,
      width: 10,
      height: 10,
      pageWidth: 595,
      pageHeight: 842,
      optionKey: 'Yes',
    };
    renderWithField(choiceField('f1', 'Partial field', ['Yes', 'No', 'Maybe'], { segments: [existingBox] }));
    // Fresh derivation always proposes a box for every option (it has no view
    // of what's already placed) — here at x = i*20, so 'Yes' would land at
    // x=0 if the already-placed box were overwritten.
    deriveOptionCellsAcrossPagesMock.mockReturnValue(proposal(1));

    await clickAutoPlace();

    expect(screen.getByText(/3\/3 placed/)).toBeDefined();
    const mark = pdfViewerPropsSpy.mock.calls.at(-1)![0].placements?.find((p) => p.slot === 'f1#Yes');
    expect(mark?.box.x).toBe(999);
  });
});

describe('GeometryEditorScreen — band overlay wiring (U6, R7/R8)', () => {
  it('Covers AE5: a field with no segment/proposal renders no band overlay, and nothing crashes (unchanged manual-draw case)', () => {
    deriveOptionCellsAcrossPagesMock.mockReturnValue(null);
    renderWithField(choiceField('f1', 'Unmatched field', ['Yes', 'No', 'Maybe']));

    fireEvent.click(screen.getByText('Unmatched field'));

    const lastProps = pdfViewerPropsSpy.mock.calls.at(-1)![0];
    expect(lastProps.bandOverlay).toBeNull();
    expect(lastProps.bandSnapTargets).toEqual([]);
    expect(lastProps.bandSnapTargetsY).toEqual([]);

    // Arming Draw on it (the manual fallback) still renders no band overlay
    // and does not throw — a hand-drawn box has no existing segment to
    // band-edit until it is actually drawn.
    fireEvent.click(screen.getAllByText('Draw')[0]!);
    const afterArming = pdfViewerPropsSpy.mock.calls.at(-1)![0];
    expect(afterArming.bandOverlay).toBeNull();
  });

  it('Covers AE5: selecting an already-placed non-choice field shows its own segment as the band overlay, with snap targets from the same page', () => {
    const items: PositionedText[] = [
      { text: 'A', x: 100, y: 50, width: 20 },
      { text: 'B', x: 300, y: 50, width: 15 },
    ];
    stubTextLayerItems.current = items;

    renderWithField(tableFieldWithSegment('f1', 'A grid field'));
    fireEvent.click(screen.getByText('A grid field'));

    const lastProps = pdfViewerPropsSpy.mock.calls.at(-1)![0];
    // The field's own placed segment, not a fresh proposal — it already has
    // geometry, so `selectField` (R4) never re-derives it.
    expect(lastProps.bandOverlay).toMatchObject({
      page: 0,
      columnBands: [{ key: 'c1', start: 20, end: 40 }],
    });
    // Computed from the SAME page's text items the overlay's segment sits on
    // — the printed edges 100/120 and 300/315 (x, x+width) from `items`.
    expect(lastProps.bandSnapTargets).toEqual([100, 120, 300, 315]);
  });

  it('Covers AE5: onBandEdge drags an already-placed field\'s own segment and writes the moved band back into edited', () => {
    renderWithField(tableFieldWithSegment('f1', 'A grid field'));
    fireEvent.click(screen.getByText('A grid field'));

    const propsBefore = pdfViewerPropsSpy.mock.calls.at(-1)![0];
    expect(propsBefore.onBandEdge).toBeTypeOf('function');

    // The right edge of column band `c1` (`columnHandles`' outer-edge shape:
    // `right-c1` names the handle, `left: 'c1'` names the band it owns).
    const handle: BandHandle = { key: 'right-c1', label: 'Drag the right edge of c1', at: 40, axis: 'column', left: 'c1' };
    act(() => propsBefore.onBandEdge!(handle, 45));

    const propsAfter = pdfViewerPropsSpy.mock.calls.at(-1)![0];
    expect(propsAfter.bandOverlay).toMatchObject({
      columnBands: [{ key: 'c1', start: 20, end: 45 }],
    });
    // The overlay's own placements entry reflects the same moved band, and
    // is `confirmed: true` — it is a segment already in `edited`, not a
    // parked proposal.
    const mark = propsAfter.placements?.find((p) => p.slot.startsWith('f1#'));
    expect(mark?.box.columnBands?.find((b) => b.key === 'c1')?.end).toBe(45);
    expect(mark?.confirmed).toBe(true);
  });

  it('an inverted onBandEdge move is refused — the segment is left unchanged', () => {
    renderWithField(tableFieldWithSegment('f1', 'A grid field'));
    fireEvent.click(screen.getByText('A grid field'));

    const propsBefore = pdfViewerPropsSpy.mock.calls.at(-1)![0];
    const handle: BandHandle = { key: 'left-c1', label: 'Drag the left edge of c1', at: 20, axis: 'column', right: 'c1' };
    // Past the band's own end (40) — an inverted move, refused.
    act(() => propsBefore.onBandEdge!(handle, 50));

    const propsAfter = pdfViewerPropsSpy.mock.calls.at(-1)![0];
    expect(propsAfter.bandOverlay).toMatchObject({
      columnBands: [{ key: 'c1', start: 20, end: 40 }],
    });
  });
});

/**
 * The loading → loaded transition, on ONE mounted component.
 *
 * This is the shape every other test in this file skips: they all set
 * `isLoading: false` before the first render, so the component takes the same
 * branch twice and its hook count never changes. The builder's PDF-mapping step
 * cannot do that — it creates the form and version on arrival, so the version is
 * never in cache, the first render ALWAYS takes the `isLoading` return, and the
 * second render is the first one to reach the body.
 *
 * That made "rendered more hooks than during the previous render" a certainty
 * there and a coin flip on the standalone route, where the version is usually
 * already cached from the form page that linked to it.
 */
describe('GeometryEditorScreen — hooks are stable across the loading transition', () => {
  it('does not add hooks between the loading render and the loaded one', () => {
    version.data = undefined;
    version.isLoading = true;
    const { rerender } = render(<GeometryEditorScreen />);
    expect(screen.getByText(/Loading version/i)).toBeTruthy();

    version.isLoading = false;
    version.data = {
      id: 'v1',
      templateId: 'form1',
      label: 'Draft v1',
      state: 'draft',
      isCurrent: false,
      fields: [choiceField('q1', 'Question one', ['Yes', 'No'])],
      container: DEFAULT_CONTAINER,
      sourcePdfAssetId: 'asset-1',
    };

    // Throws "Rendered more hooks than during the previous render" if any hook
    // sits below one of the four early returns.
    expect(() => rerender(<GeometryEditorScreen />)).not.toThrow();
    expect(screen.getByText('Question one')).toBeTruthy();
  });

  it('survives the same transition into the published branch', () => {
    // Each early return is its own opportunity for the bug, and a published
    // version takes a different one.
    version.data = undefined;
    version.isLoading = true;
    const { rerender } = render(<GeometryEditorScreen />);

    version.isLoading = false;
    version.data = {
      id: 'v1',
      templateId: 'form1',
      label: 'Draft v1',
      state: 'published',
      isCurrent: true,
      fields: [],
      container: DEFAULT_CONTAINER,
      sourcePdfAssetId: 'asset-1',
    };
    expect(() => rerender(<GeometryEditorScreen />)).not.toThrow();
    expect(screen.getByText(/is published/i)).toBeTruthy();
  });

  it('survives the transition into a version with no source PDF', () => {
    version.data = undefined;
    version.isLoading = true;
    const { rerender } = render(<GeometryEditorScreen />);

    version.isLoading = false;
    version.data = {
      id: 'v1',
      templateId: 'form1',
      label: 'Draft v1',
      state: 'draft',
      isCurrent: false,
      fields: [],
      container: DEFAULT_CONTAINER,
      sourcePdfAssetId: null,
    };
    expect(() => rerender(<GeometryEditorScreen />)).not.toThrow();
    expect(screen.getByText(/No original PDF/i)).toBeTruthy();
  });
});

/**
 * The EMBEDDED mount — how the assessment builder's PDF-mapping step uses this.
 *
 * `embedded` means "the host supplies the page title", not "the host supplies
 * the tools". Hiding the whole header took Auto-place, Save and the
 * placed/total counter with it, which left that step able to draw boxes and
 * unable to keep a single one: the geometry lived in this component's local
 * state and went with it when the author moved to the next step.
 *
 * The `onSaved` callback exists for the second half of the same failure. The
 * builder keeps its own copy of the field list and publishes THAT, so geometry
 * written only onto the version is overwritten at publish — with the boxes on
 * screen the whole time, which is what made it invisible.
 */
describe('GeometryEditorScreen — embedded in the assessment builder', () => {
  function renderEmbedded(props: { onSaved?: (fields: FormField[]) => void } = {}) {
    version.data = {
      id: 'v1',
      templateId: 'form1',
      label: 'Draft v1',
      state: 'draft',
      isCurrent: false,
      fields: [choiceField('q1', 'Question one', ['Yes', 'No'])],
      container: DEFAULT_CONTAINER,
      sourcePdfAssetId: 'asset-1',
    };
    render(<GeometryEditorScreen embedded {...props} />);
  }

  it('KEEPS AUTO-PLACE, which is the whole point of the step', () => {
    renderEmbedded();
    expect(screen.getByText('Auto-place remaining fields')).toBeTruthy();
  });

  it('KEEPS SAVE — without it nothing placed here can be kept', () => {
    renderEmbedded();
    expect(screen.getByText('Save placement')).toBeTruthy();
  });

  it('keeps the placed/total counter, the only answer to “am I finished”', () => {
    renderEmbedded();
    expect(screen.getByText(/answerable fields placed/)).toBeTruthy();
  });

  it('drops the page title, which the host already shows', () => {
    renderEmbedded();
    expect(screen.queryByText(/^Placement · /)).toBeNull();
  });

  it('drops Publish, because the host publishes at the end of its own flow', () => {
    // Publishing from here would publish the form version mid-builder, before
    // the answer keys and the tool manifest exist.
    renderEmbedded();
    expect(screen.queryByText('Publish version')).toBeNull();
  });

  it('HANDS THE SAVED FIELDS BACK to the host', () => {
    /*
      The builder validates and writes its OWN field list at publish. Geometry
      that reached the version but not the host's copy is overwritten there, so
      handing it back is what makes a placement survive the rest of the wizard.
    */
    const onSaved = vi.fn();
    saveMutate.mockImplementation((_fields: FormField[], opts: { onSuccess: () => void }) =>
      opts.onSuccess(),
    );
    renderEmbedded({ onSaved });
    // Save is disabled until something is dirty, so place a box first —
    // selecting a field auto-applies the confident default proposal.
    fireEvent.click(screen.getByText('Question one'));
    fireEvent.click(screen.getByText('Save placement'));

    const saved = onSaved.mock.calls[0]![0] as FormField[];
    expect(saved.find((f) => f.id === 'q1')?.geometry?.segments.length).toBeGreaterThan(0);
  });

  it('does not call back when the save failed', () => {
    // Telling the host a placement landed when it did not is worse than the
    // bug this callback fixes — the author would then publish believing it had.
    const onSaved = vi.fn();
    saveMutate.mockImplementation((_fields: FormField[], opts: { onError: () => void }) =>
      opts.onError(),
    );
    renderEmbedded({ onSaved });
    fireEvent.click(screen.getByText('Question one'));
    fireEvent.click(screen.getByText('Save placement'));
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('still shows the title and Publish on the standalone route', () => {
    // The embedded split must not have quietly changed the screen it came from.
    version.data = {
      id: 'v1',
      templateId: 'form1',
      label: 'Draft v1',
      state: 'draft',
      isCurrent: false,
      fields: [choiceField('q1', 'Question one', ['Yes', 'No'])],
      container: DEFAULT_CONTAINER,
      sourcePdfAssetId: 'asset-1',
    };
    render(<GeometryEditorScreen />);
    expect(screen.getByText(/^Placement · /)).toBeTruthy();
    expect(screen.getByText('Publish version')).toBeTruthy();
  });
});

/**
 * Choosing what a placed box PRINTS, on the screen that places it.
 *
 * The glyph picker was only ever in the import wizard's review step
 * (`ImportReviewScreen` → `FieldInspector` → `GeometryInspector`). This screen
 * — the standalone placement route AND the assessment builder's PDF mapping
 * step — had no mark-style control at all, so the path an assessment tool is
 * actually built through could not choose one.
 */
describe('GeometryEditorScreen — what a placed box prints', () => {
  function renderWithPlacedBox() {
    version.data = {
      id: 'v1',
      templateId: 'form1',
      label: 'Draft v1',
      state: 'draft',
      isCurrent: false,
      fields: [
        {
          id: 'sig',
          type: 'text',
          label: 'Assessor signature',
          required: false,
          source: 'imported',
          geometry: {
            segments: [
              { page: 0, x: 10, y: 10, width: 80, height: 14, pageWidth: 595, pageHeight: 842 },
            ],
          },
        },
      ],
      container: DEFAULT_CONTAINER,
      sourcePdfAssetId: 'asset-1',
    };
    render(<GeometryEditorScreen />);
    fireEvent.click(screen.getByText('Assessor signature'));
  }

  it('offers the picker once a box exists', () => {
    renderWithPlacedBox();
    expect(screen.getByText('What this box prints')).toBeTruthy();
  });

  it('offers EVERY glyph, because every one now draws', () => {
    // The exporter used to ignore five of the twelve and the import-review
    // picker labelled them as not-yet-drawn. All twelve reach the page now.
    renderWithPlacedBox();
    for (const label of ['Hand ✓', 'PASS', 'N/A', 'Initials', 'Highlight', 'Match line']) {
      expect(screen.getByLabelText(`Print ${label}`)).toBeTruthy();
    }
  });

  it('writes the chosen glyph onto the box', () => {
    renderWithPlacedBox();
    fireEvent.click(screen.getByLabelText('Print PASS'));
    expect(screen.getByLabelText('Print PASS').getAttribute('aria-pressed')).toBe('true');
  });

  it('CLEARS TO NO markStyle rather than an empty one', () => {
    /*
      Absent is what every placement authored before styles existed carries, and
      it is the value the exporter treats as "the field's own mark". An empty
      `markStyle` object is a different value that happens to behave the same
      today.
    */
    renderWithPlacedBox();
    fireEvent.click(screen.getByLabelText('Print PASS'));
    fireEvent.click(screen.getByText('Default'));
    expect(screen.getByText('Default').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('Print PASS').getAttribute('aria-pressed')).toBe('false');
  });

  it('explains what a match line does, since the box IS the connector', () => {
    // A PageBox carries one rectangle and no second endpoint, so the author has
    // to know to span the gap. Left unsaid, the glyph looks broken.
    renderWithPlacedBox();
    fireEvent.click(screen.getByLabelText('Print Match line'));
    expect(screen.getByText(/spanning the gap between the two/)).toBeTruthy();
  });

  it('offers no picker for a field with no box yet', () => {
    // A style with nowhere to print is a choice about nothing, and it would be
    // lost the moment the box is drawn.
    version.data = {
      id: 'v1',
      templateId: 'form1',
      label: 'Draft v1',
      state: 'draft',
      isCurrent: false,
      fields: [
        { id: 'sig', type: 'text', label: 'Unplaced field', required: false, source: 'imported' },
      ],
      container: DEFAULT_CONTAINER,
      sourcePdfAssetId: 'asset-1',
    };
    render(<GeometryEditorScreen />);
    fireEvent.click(screen.getByText('Unplaced field'));
    expect(screen.queryByText('What this box prints')).toBeNull();
  });
});

/*
  A MATCHING QUESTION IS PLACED AS ANCHORS, NOT AS ONE BOX PER PAIRING.

  It is stored as a choice field whose options are every left × every right, so
  the per-option path claimed it and asked for nine boxes on a three-by-three
  question — twenty-five on a five-by-five. Eight of those nine name a
  correspondence the page never printed anywhere, so an author following the
  panel honestly could not place them.

  An anchor sits on something that IS printed: the statement, or the sign. Six
  describe the same question, and the exporter draws each chosen pairing as a
  line between the two anchors it names.
*/
describe('GeometryEditorScreen — matching anchors', () => {
  const PAIRINGS = [
    'Restricted area -> Biosecurity sign',
    'Restricted area -> Traffic hazard sign',
    'Permission to pass -> Biosecurity sign',
    'Permission to pass -> Traffic hazard sign',
  ];

  const matchingField = (geometry?: FormField['geometry']) =>
    choiceField('q7', 'Match the statement to the signage', PAIRINGS, geometry);

  it('LISTS THE PRINTED SIDES, NOT THE PAIRINGS', () => {
    renderWithField(matchingField());

    fireEvent.click(screen.getByText('Match the statement to the signage'));

    expect(screen.getByText('Prompts')).toBeDefined();
    expect(screen.getByText('Answers')).toBeDefined();
    expect(screen.getByText('Restricted area')).toBeDefined();
    expect(screen.getByText('Biosecurity sign')).toBeDefined();
    // The pairing itself is never offered as a thing to place.
    expect(screen.queryByText('Restricted area -> Biosecurity sign')).toBeNull();
  });

  it('counts the ANCHORS, so the header can actually reach complete', () => {
    /*
      This used to count the pairings. The header read "0/4" for a question with
      four placeable things on it, and could never reach complete however
      carefully the author worked.
    */
    renderWithField(matchingField());

    fireEvent.click(screen.getByText('Match the statement to the signage'));

    expect(screen.getByText(/0\/4 placed/)).toBeDefined();
  });

  it('reports how many anchors are down, and why a half-anchored pairing draws nothing', () => {
    renderWithField(
      matchingField({
        segments: [
          { page: 0, x: 40, y: 700, width: 8, height: 8, pageWidth: 595, pageHeight: 842, optionKey: 'l0' },
        ],
      }),
    );

    fireEvent.click(screen.getByText('Match the statement to the signage'));

    expect(screen.getByText(/1 of 4 anchored/)).toBeDefined();
  });

  it('DERIVES NO PROPOSAL FOR A MATCHING QUESTION', () => {
    /*
      `deriveOptionCellsAcrossPages` matches a field's label row and then its
      options within it. A matching question's "options" are pairings that
      appear nowhere on the page, so any hit would be a coincidence placing a
      box against text that does not mean what the key says it means.

      Anchors are drawn by hand for now. Six by hand beats nine guessed.
    */
    renderWithField(matchingField());

    fireEvent.click(screen.getByText('Match the statement to the signage'));

    expect(deriveOptionCellsAcrossPagesMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Place all /)).toBeNull();
  });

  it('offers no glyph picker on an anchor, which prints no mark of its own', () => {
    /*
      An anchor is one END of a connector. A tick or a stamp chosen for it would
      be a choice on screen that reaches the page as nothing.
    */
    renderWithField(
      matchingField({
        segments: [
          { page: 0, x: 40, y: 700, width: 8, height: 8, pageWidth: 595, pageHeight: 842, optionKey: 'l0' },
        ],
      }),
    );

    fireEvent.click(screen.getByText('Match the statement to the signage'));

    expect(screen.queryByText('What this box prints')).toBeNull();
  });

  it('leaves an ordinary choice field on the per-option path', () => {
    // The split keys on the OPTIONS being pairings, not on the type.
    renderWithField(choiceField('f1', 'Ordinary group', ['Yes', 'No', 'Maybe']));

    fireEvent.click(screen.getByText('Ordinary group'));

    expect(screen.queryByText('Prompts')).toBeNull();
    expect(screen.getByText(/3\/3 placed/)).toBeDefined();
  });
});
