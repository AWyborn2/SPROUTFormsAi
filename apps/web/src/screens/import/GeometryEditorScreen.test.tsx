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
  drawArmed?: boolean;
  drawLine?: boolean;
  onDrawConnector?: (from: PageBox, to: PageBox) => void;
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
 * The placement learning loop's fire-and-forget sender (U6). Mocked so the
 * suite can assert WHAT a successful save emits without a network; the
 * sender's own contract (a rejected POST is swallowed, an empty slice sends
 * nothing) is proven in `lib/data/placement-outcomes.test.ts` — this file
 * only checks the wiring routes through the recorder into it.
 */
const { sendPlacementOutcomesMock } = vi.hoisted(() => ({
  sendPlacementOutcomesMock: vi.fn(),
}));
vi.mock('../../lib/data/placement-outcomes.js', () => ({
  sendPlacementOutcomes: sendPlacementOutcomesMock,
}));

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
const { pdfViewerPropsSpy, stubTextLayerItems, stubTextLayerPageCount, stubTextLayerRects } =
  vi.hoisted(() => ({
    pdfViewerPropsSpy: vi.fn<(props: MockPdfViewerProps) => void>(),
    stubTextLayerItems: { current: [] as { text: string; x: number; y: number; width: number }[] },
    // How many pages the stub feeds (page 0 carries `stubTextLayerItems`, the
    // rest are blank). One suffices almost everywhere; the page-scoped-scan
    // tests need a second page because a TextPage's index IS its page number.
    stubTextLayerPageCount: { current: 1 },
    // Page 0's printed rectangles (U6). Default null — the property is simply
    // absent, matching the NOT MEASURED convention every existing test ran under.
    stubTextLayerRects: {
      current: null as { x: number; y: number; width: number; height: number }[] | null,
    },
  }));

vi.mock('./PdfViewer.js', () => ({
  PdfViewer: (props: MockPdfViewerProps) => {
    pdfViewerPropsSpy(props);
    useEffect(() => {
      props.onTextLayer(
        Array.from({ length: stubTextLayerPageCount.current }, (_, i) => ({
          width: 595,
          height: 842,
          items: i === 0 ? stubTextLayerItems.current : [],
          ...(i === 0 && stubTextLayerRects.current ? { rects: stubTextLayerRects.current } : {}),
        })),
      );
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

/** An 8pt anchor box, as `matchAnchorBoxAt` mints one. */
function anchorBox(x: number, y: number): PageBox {
  return { page: 0, x, y, width: 8, height: 8, pageWidth: 595, pageHeight: 842 };
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
  stubTextLayerPageCount.current = 1;
  stubTextLayerRects.current = null;
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

describe('GeometryEditorScreen — the extraction window reaches the engine (sourcePages)', () => {
  /**
   * The window logic itself (capping, notes, refusals) is proven at the pure
   * level in `geometry-actions.test.ts`; derivation is stubbed here. What
   * these tests pin is the WIRING — which calls hand the engine a window and
   * which deliberately do not (R8) — by asserting the third argument the
   * stubbed deriver received.
   */
  const windowedField = (): FormField => ({
    ...choiceField('f1', 'Windowed field', ['Yes', 'No', 'Maybe']),
    sourcePages: { from: 1, to: 1 },
  });

  it('selectField resolves the field window and hands it to the deriver', () => {
    renderWithField(windowedField());
    deriveOptionCellsAcrossPagesMock.mockReturnValue(null);
    deriveOptionCellsAcrossPagesMock.mockClear();

    fireEvent.click(screen.getByText('Windowed field'));

    // One page in the stub, stamped {1,1}: 0-based bounds 0..0 after clamped
    // dilation. Both `selectField` and the panel's own preview memo derive,
    // and each must pass the same resolved window.
    const windows = deriveOptionCellsAcrossPagesMock.mock.calls.map((c) => c[2]);
    expect(windows.length).toBeGreaterThan(0);
    for (const w of windows) expect(w).toEqual({ first: 0, last: 0, from: 1, to: 1 });
  });

  it('a field with no sourcePages takes the unscoped path — the deriver gets null (R6)', () => {
    renderWithField(choiceField('f1', 'Legacy field', ['Yes', 'No', 'Maybe']));
    deriveOptionCellsAcrossPagesMock.mockReturnValue(null);
    deriveOptionCellsAcrossPagesMock.mockClear();

    fireEvent.click(screen.getByText('Legacy field'));

    expect(deriveOptionCellsAcrossPagesMock.mock.calls.length).toBeGreaterThan(0);
    for (const c of deriveOptionCellsAcrossPagesMock.mock.calls) expect(c[2]).toBeNull();
  });

  it('the whole-document bulk pass passes each field its own window', async () => {
    renderWithField(windowedField());
    deriveOptionCellsAcrossPagesMock.mockReturnValue(null);
    deriveOptionCellsAcrossPagesMock.mockClear();

    await clickAutoPlace();

    const call = deriveOptionCellsAcrossPagesMock.mock.calls.find(
      (c) => (c[0] as { label: string }).label === 'Windowed field',
    );
    expect(call).toBeDefined();
    expect(call![2]).toEqual({ first: 0, last: 0, from: 1, to: 1 });
  });

  it('AE6: the page-scoped scan passes NO window, and its unique hit still auto-confirms', async () => {
    // Two stub pages so a scoped page index is expressible. The field carries
    // a perfectly valid window; the author pointing at a page must outrank it
    // (R8) — the engine is handed null, so a stale or boundary-shifted window
    // cannot downgrade the scoped scan's auto-confirm.
    stubTextLayerPageCount.current = 2;
    renderWithField(windowedField());
    deriveOptionCellsAcrossPagesMock.mockReturnValue(proposal(1));

    fireEvent.change(screen.getByLabelText('Page'), { target: { value: '2' } });
    deriveOptionCellsAcrossPagesMock.mockClear();
    fireEvent.click(screen.getByText('Scan'));
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    const call = deriveOptionCellsAcrossPagesMock.mock.calls.find(
      (c) => (c[0] as { label: string }).label === 'Windowed field',
    );
    expect(call).toBeDefined();
    expect(call![2]).toBeNull();
    // The scoped scan's unique hit auto-confirms exactly as today.
    expect(screen.getByText(/3\/3 placed/)).toBeDefined();
  });

  it('a window-capped proposal parks as needs-review — never auto-confirmed — and shows its note', async () => {
    renderWithField(windowedField());
    // What the real windowed deriver returns for a window-disambiguated hit:
    // capped strictly below 1, note naming the excluded pages (KTD2/R5).
    deriveOptionCellsAcrossPagesMock.mockReturnValue({
      ...proposal(0.95),
      notes: ['Matched on page 7; pages 12 and 17 excluded by the extraction window (pages 5–8).'],
    });

    await clickAutoPlace();

    // Parked, not placed: the cap kept it out of the auto-confirm tier.
    expect(screen.getByText(/0\/3 placed/)).toBeDefined();
    expect(screen.getByText('1 field need review')).toBeDefined();

    // Opening the field surfaces the reviewer-facing story through the
    // existing notes channel — no new UI.
    fireEvent.click(screen.getByLabelText('Review Windowed field'));
    expect(
      screen.getByText('Matched on page 7; pages 12 and 17 excluded by the extraction window (pages 5–8).'),
    ).toBeDefined();
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

describe('GeometryEditorScreen — column-evidence caption (rect-columns U6, R7)', () => {
  /** The Mine Site shape: label column, ONE answer column, five printed rows. */
  function headerlessChecklist(id: string, label: string): FormField {
    return {
      id,
      type: 'repeating_group',
      label,
      required: false,
      source: 'imported',
      columns: [
        { key: 'method', label: 'Method', type: 'text' },
        { key: 'used', label: 'Used', type: 'check_cross' },
      ],
      fixedRows: ['Observation', 'Practical', 'Verbal', 'Written', 'Portfolio'],
    };
  }

  /** A dozer-shaped header table: header glyphs, four label rows, no rects. */
  function headerTable(id: string, label: string): FormField {
    return {
      id,
      type: 'repeating_group',
      label,
      required: false,
      source: 'imported',
      columns: [
        { key: 'item', label: 'Item', type: 'text' },
        { key: 'tick', label: '✓', type: 'boolean_yes_no' },
        { key: 'cross', label: '×', type: 'boolean_yes_no' },
        { key: 'na', label: 'N/A', type: 'boolean_yes_no' },
      ],
      fixedRows: ['r0', 'r1', 'r2', 'r3'],
    };
  }

  it('captions a rect-anchored grid as measured from printed boxes', () => {
    // Five labels at one margin, five 9pt squares on the measured 28.4pt
    // pitch, no header glyphs — the rect-anchored derivation, whose whole
    // point is that the columns were measured, and the caption says so.
    stubTextLayerItems.current = [0, 1, 2, 3, 4].map((i) => ({
      text: `Method ${i}`,
      x: 40,
      y: 762 - i * 28.4,
      width: 200,
    }));
    stubTextLayerRects.current = [0, 1, 2, 3, 4].map((i) => ({
      x: 500,
      y: 760 - i * 28.4,
      width: 9,
      height: 9,
    }));
    renderWithField(headerlessChecklist('t1', 'Methods table'));

    fireEvent.click(screen.getByText('Methods table'));

    expect(screen.getByText('Columns measured from printed boxes.')).toBeDefined();
  });

  it('captions a text-derived grid as inferred from header text', () => {
    // The measured dozer header with no rects on the page: the columns come
    // from header glyphs, and the caption must not claim otherwise — its
    // wording is the visible tell for the historic silent-zero rect
    // extractor regression.
    stubTextLayerItems.current = [
      { text: 'N/A', x: 539.9, y: 648.6, width: 13.3 },
      { text: 'During the demonstration, did the candidate:', x: 37.5, y: 647.7, width: 192 },
      { text: '', x: 502.6, y: 647.7, width: 7.1 },
      { text: '/ ×', x: 512.1, y: 647.7, width: 10.3 },
      { text: 'Receive and interpret work instructions', x: 37.5, y: 630.8, width: 258.1 },
      { text: 'Identify and report potential hazards', x: 37.5, y: 614, width: 143.6 },
      { text: 'Communicate with other personnel', x: 37.5, y: 597.1, width: 198.6 },
      { text: 'Wearing correct PPE', x: 37.5, y: 580.3, width: 84 },
    ];
    renderWithField(headerTable('t2', 'Practical table'));

    fireEvent.click(screen.getByText('Practical table'));

    expect(screen.getByText('Columns inferred from header text.')).toBeDefined();
    expect(screen.queryByText('Columns measured from printed boxes.')).toBeNull();
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
    // `getAllBy` because each entry also names itself in the "Draw a line"
    // selects — the row label and the option are two views of one anchor.
    expect(screen.getAllByText('Restricted area').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Biosecurity sign').length).toBeGreaterThan(0);
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

/*
  ONE DRAG, TWO ANCHORS.

  A matching answer is a line from a statement to a sign — a person doing the
  question with a pen draws exactly that. Placing anchors one at a time asks the
  author to think in a model the page does not use, and costs six gestures where
  three would do.
*/
describe('GeometryEditorScreen — drawing a matching connector', () => {
  const PAIRINGS = [
    'Restricted area -> Biosecurity sign',
    'Restricted area -> Traffic hazard sign',
    'Permission to pass -> Biosecurity sign',
    'Permission to pass -> Traffic hazard sign',
  ];

  const matchingField = (geometry?: FormField['geometry']) =>
    choiceField('q7', 'Match the statement to the signage', PAIRINGS, geometry);

  /** The props the stubbed viewer was last rendered with. */
  function lastViewerProps(): MockPdfViewerProps {
    const calls = pdfViewerPropsSpy.mock.calls;
    return calls[calls.length - 1]![0];
  }

  function open() {
    renderWithField(matchingField());
    fireEvent.click(screen.getByText('Match the statement to the signage'));
  }

  /** Which anchor keys currently carry a box, read off the viewer's placements. */
  function placedKeys(): string[] {
    return (lastViewerProps().placements ?? [])
      .map((p) => p.slot.split('#')[1]!)
      .sort();
  }

  it('ARMS LINE MODE, not box mode', () => {
    open();
    expect(lastViewerProps().drawLine).toBe(false);

    fireEvent.click(screen.getByText('Draw lines on the page'));

    expect(lastViewerProps().drawArmed).toBe(true);
    expect(lastViewerProps().drawLine).toBe(true);
  });

  it('places BOTH ends from one drag', () => {
    open();
    fireEvent.click(screen.getByText('Draw lines on the page'));

    act(() => {
      lastViewerProps().onDrawConnector!(anchorBox(40, 700), anchorBox(400, 700));
    });

    // Both ends down from a single gesture — the count is what the header reads.
    expect(screen.getByText(/2\/4 placed/)).toBeDefined();
  });

  it('STAYS ARMED AND ADVANCES, so the next drag needs no click', () => {
    /*
      The gesture is only "just draw" if the mode survives it. Disarming after
      each drag made a three-by-three question click, drag, click, drag, click,
      drag — half the gestures re-arming a mode that had just been used for
      exactly what it is for.
    */
    open();
    fireEvent.click(screen.getByText('Draw lines on the page'));
    act(() => {
      lastViewerProps().onDrawConnector!(anchorBox(40, 700), anchorBox(400, 700));
    });

    expect(lastViewerProps().drawArmed).toBe(true);
    expect(lastViewerProps().drawLine).toBe(true);
    expect((screen.getByLabelText('Line starts at') as HTMLSelectElement).value).toBe('l1');
    expect((screen.getByLabelText('Line ends at') as HTMLSelectElement).value).toBe('r1');
  });

  it('draws every line from ONE arming click', () => {
    open();
    fireEvent.click(screen.getByText('Draw lines on the page'));
    for (const y of [700, 660]) {
      act(() => {
        lastViewerProps().onDrawConnector!(anchorBox(40, y), anchorBox(400, y));
      });
    }

    expect(screen.getByText(/4\/4 placed/)).toBeDefined();
    expect(placedKeys()).toEqual(['l0', 'l1', 'r0', 'r1']);
  });

  it('DISARMS ONCE EVERY ANCHOR IS DOWN', () => {
    /*
      Staying armed on a finished question would let a stray drag silently move
      an anchor. Re-drawing one is that row's own Draw button.
    */
    open();
    fireEvent.click(screen.getByText('Draw lines on the page'));
    for (const y of [700, 660]) {
      act(() => {
        lastViewerProps().onDrawConnector!(anchorBox(40, y), anchorBox(400, y));
      });
    }

    expect(lastViewerProps().drawArmed).toBe(false);
  });

  it('lets the author jump to a different pair from the selects', () => {
    // A paper whose entries are printed out of order, or a pair already down.
    open();

    fireEvent.change(screen.getByLabelText('Line ends at'), { target: { value: 'r1' } });
    act(() => {
      lastViewerProps().onDrawConnector!(anchorBox(40, 700), anchorBox(400, 660));
    });

    // The far end landed on the CHOSEN answer, not the suggested one.
    expect(placedKeys()).toEqual(['l0', 'r1']);
  });

  it('NAMES THE PAIR THE NEXT DRAG WILL PLACE', () => {
    /*
      Which two anchors a drag lands on is the one thing the gesture cannot
      show: the line under the cursor looks identical whichever pair it belongs
      to. Saying it is what makes "just keep dragging" safe.
    */
    open();
    fireEvent.click(screen.getByText('Draw lines on the page'));

    expect(screen.getByText(/Drag from/)).toBeDefined();
    expect(screen.getAllByText('Restricted area').length).toBeGreaterThan(0);

    act(() => {
      lastViewerProps().onDrawConnector!(anchorBox(40, 700), anchorBox(400, 700));
    });

    expect((screen.getByLabelText('Line starts at') as HTMLSelectElement).value).toBe('l1');
  });

  it('LEAVES AN ORDINARY FIELD IN BOX MODE', () => {
    // Line mode is armed by the connector target's far end, which only a
    // matching question ever sets. A checkbox group must still rubber-band a
    // rectangle.
    deriveOptionCellsAcrossPagesMock.mockReturnValue(null);
    renderWithField(choiceField('f1', 'Ordinary group', ['Yes', 'No', 'Maybe']));
    fireEvent.click(screen.getByText('Ordinary group'));

    fireEvent.click(screen.getAllByText('Draw')[0]!);

    expect(lastViewerProps().drawArmed).toBe(true);
    expect(lastViewerProps().drawLine).toBe(false);
  });
});

/*
  AN OUTCOME BOX IS HIDDEN ONLY WHERE ITS QUESTION IS SHOWN.

  A question and its ✓/✗ cell are one unit of authoring work, so the cell has
  no row of its own — it is reachable through the question's "Outcome" chip.
  That justification holds only while the question is on screen. Behind the
  search filter it was reachable through NOTHING and vanished from the session,
  with the header still counting it, so the list read as having fewer boxes left
  than it had.
*/
describe('GeometryEditorScreen — reaching an outcome box', () => {
  const question = (id: string, label: string, outcomeId: string): FormField => ({
    id,
    type: 'radio',
    label,
    required: false,
    source: 'imported',
    options: ['Yes', 'No'],
    outcomeTarget: { fieldId: outcomeId },
  });

  const cell = (id: string, label: string): FormField => ({
    id,
    type: 'check_cross',
    label,
    required: false,
    source: 'imported',
  });

  const PAIR = [
    question('q1', 'Assessment Result outcome', 'verdict'),
    cell('verdict', 'The Candidate’s responses were'),
  ];

  it('gives the cell no row of its own while the question is listed', () => {
    deriveOptionCellsAcrossPagesMock.mockReturnValue(null);
    renderWithFields(PAIR);

    // One row, the pair. The cell has no row and no label of its own — it is
    // reached through the question's "Outcome" chip.
    expect(screen.getByText('Assessment Result outcome')).toBeDefined();
    expect(screen.queryByText('The Candidate’s responses were')).toBeNull();
  });

  it('GIVES IT A ROW WHEN THE FILTER HIDES ITS QUESTION', () => {
    /*
      The case that made a printed box unplaceable. Searching for the cell by
      its own name filtered out the question that owned it, and the cell was
      then reachable through nothing at all.
    */
    deriveOptionCellsAcrossPagesMock.mockReturnValue(null);
    renderWithFields(PAIR);

    fireEvent.change(screen.getByPlaceholderText(/filter|search/i), {
      target: { value: 'responses were' },
    });

    expect(screen.queryByText('Assessment Result outcome')).toBeNull();
    expect(screen.getByText('The Candidate’s responses were')).toBeDefined();
  });
});

/*
  THE PLACEMENT LEARNING LOOP'S EMIT (U6).

  The session rules themselves — upsert-on-re-propose, drain-once, the
  prior-refusal guard, bucket boundaries — are the pure recorder's regression
  coverage (placement-recorder.test.ts). These tests are the
  does-the-wiring-route-through-it check: every placement action feeds the
  recorder, and ONLY a successful save drains it into `sendPlacementOutcomes`.
*/
describe('GeometryEditorScreen — placement outcomes emit on save (U6)', () => {
  type SentPayload = {
    documentType?: string;
    formId?: string;
    versionId?: string;
    context: string;
    fieldCount: number;
    events: { kind: string; fieldId: string; [key: string]: unknown }[];
  };

  function lastSentPayload(): SentPayload {
    return sendPlacementOutcomesMock.mock.calls.at(-1)![0] as SentPayload;
  }

  function saveSucceeds() {
    saveMutate.mockImplementation((_fields: FormField[], opts: { onSuccess: () => void }) =>
      opts.onSuccess(),
    );
  }

  it('auto-place then save sends one payload carrying the proposed and accepted:auto events', async () => {
    saveSucceeds();
    renderWithField(choiceField('f1', 'Multi-option field', ['Yes', 'No', 'Maybe']));

    await clickAutoPlace();
    fireEvent.click(screen.getByText('Save placement'));

    expect(sendPlacementOutcomesMock).toHaveBeenCalledTimes(1);
    const payload = lastSentPayload();
    expect(payload).toMatchObject({
      context: 'standalone',
      formId: 'form1',
      versionId: 'v1',
      fieldCount: 1,
    });
    // The standalone mount knows no document type — the key is absent, so the
    // aggregator buckets it as `unspecified` (KTD6).
    expect('documentType' in payload).toBe(false);
    expect(payload.events).toContainEqual({
      kind: 'proposed',
      fieldId: 'f1',
      method: 'option-cells',
      tier: 'auto-confirm',
    });
    expect(payload.events).toContainEqual({
      kind: 'accepted',
      fieldId: 'f1',
      method: 'option-cells',
      via: 'auto',
    });
  });

  it('confirm and reject from the review queue produce their events in the saved slice', async () => {
    saveSucceeds();
    renderWithFields([
      choiceField('f1', 'Field A', ['Yes', 'No', 'Maybe']),
      choiceField('f2', 'Field B', ['Yes', 'No', 'Maybe']),
    ]);
    deriveOptionCellsAcrossPagesMock.mockReturnValue(proposal(0.6));

    await clickAutoPlace();
    fireEvent.click(screen.getByLabelText('Confirm Field A'));
    fireEvent.click(screen.getByLabelText('Reject Field B'));
    fireEvent.click(screen.getByText('Save placement'));

    const { events } = lastSentPayload();
    expect(events).toContainEqual({ kind: 'proposed', fieldId: 'f1', method: 'option-cells', tier: 'needs-review' });
    expect(events).toContainEqual({ kind: 'accepted', fieldId: 'f1', method: 'option-cells', via: 'confirm' });
    expect(events).toContainEqual({ kind: 'rejected', fieldId: 'f2', method: 'option-cells' });
  });

  it('a save with no recorded events sends nothing', () => {
    // A glyph pick dirties the draft without touching the engine: the field is
    // already placed, so nothing was proposed, accepted or drawn.
    saveSucceeds();
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
    fireEvent.click(screen.getByLabelText('Print PASS'));
    fireEvent.click(screen.getByText('Save placement'));

    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }));
    expect(sendPlacementOutcomesMock).not.toHaveBeenCalled();
  });

  it('AE5: the save toast is already shown before the send is even attempted', async () => {
    // The emit sits after the toast and is never awaited, so however the POST
    // later fails, the save's acknowledgement cannot be blocked or undone.
    // (That a rejected POST is swallowed is the sender's own tested contract.)
    saveSucceeds();
    renderWithField(choiceField('f1', 'Multi-option field', ['Yes', 'No', 'Maybe']));

    await clickAutoPlace();
    fireEvent.click(screen.getByText('Save placement'));

    const toastOrder = toast.mock.invocationCallOrder[0]!;
    const sendOrder = sendPlacementOutcomesMock.mock.invocationCallOrder[0]!;
    expect(toastOrder).toBeLessThan(sendOrder);
  });

  it('a failed save sends nothing — an unsaved session is not ground truth (AE4)', async () => {
    saveMutate.mockImplementation((_fields: FormField[], opts: { onError: () => void }) =>
      opts.onError(),
    );
    renderWithField(choiceField('f1', 'Multi-option field', ['Yes', 'No', 'Maybe']));

    await clickAutoPlace();
    fireEvent.click(screen.getByText('Save placement'));

    expect(sendPlacementOutcomesMock).not.toHaveBeenCalled();
  });

  it('a second save after more edits sends only the NEW events (drain-once)', async () => {
    saveSucceeds();
    renderWithFields([
      choiceField('f1', 'Auto field', ['Yes', 'No', 'Maybe']),
      choiceField('f2', 'Review field', ['Yes', 'No', 'Maybe']),
    ]);
    deriveOptionCellsAcrossPagesMock.mockImplementation((field: { label: string }) =>
      field.label === 'Review field' ? proposal(0.6) : proposal(1),
    );

    await clickAutoPlace();
    fireEvent.click(screen.getByText('Save placement'));
    expect(sendPlacementOutcomesMock).toHaveBeenCalledTimes(1);
    expect(lastSentPayload().events.length).toBeGreaterThan(1);

    // The parked proposal is confirmed AFTER the first save; the second slice
    // carries just that accept — with the method remembered across the drain.
    fireEvent.click(screen.getByLabelText('Confirm Review field'));
    fireEvent.click(screen.getByText('Save placement'));

    expect(sendPlacementOutcomesMock).toHaveBeenCalledTimes(2);
    expect(lastSentPayload().events).toEqual([
      { kind: 'accepted', fieldId: 'f2', method: 'option-cells', via: 'confirm' },
    ]);
  });

  it('the builder mount threads documentType and context into the payload (R9/KTD6)', () => {
    saveSucceeds();
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
    render(<GeometryEditorScreen embedded documentType="assessment" />);

    // Selecting the field auto-applies the confident default proposal.
    fireEvent.click(screen.getByText('Question one'));
    fireEvent.click(screen.getByText('Save placement'));

    expect(lastSentPayload()).toMatchObject({
      documentType: 'assessment',
      context: 'builder',
    });
  });
});
