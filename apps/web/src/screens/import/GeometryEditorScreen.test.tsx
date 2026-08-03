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
  it('Covers AE4: runs the same tiering across every unplaced field, applying auto-confirm fields in one batched update and leaving needs-review/no-match fields untouched', () => {
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

    fireEvent.click(screen.getByText('Auto-place remaining fields'));

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

  it('Covers AE4: a field already fully placed is excluded from the loop — derivation is never even called for it, and it is left unchanged', () => {
    renderWithFields([fullyPlacedChoiceField('f-full', 'Full field'), choiceField('f-eligible', 'Eligible field', ['Yes', 'No', 'Maybe'])]);

    deriveOptionCellsAcrossPagesMock.mockClear();
    deriveOptionCellsAcrossPagesMock.mockReturnValue(proposal(1));

    fireEvent.click(screen.getByText('Auto-place remaining fields'));

    // Only the eligible field was ever handed to derivation — the fully
    // placed field's box count (3 >= expectedBoxes of 3) excluded it before
    // `deriveProposal` was ever reached.
    expect(deriveOptionCellsAcrossPagesMock).toHaveBeenCalledTimes(1);
    expect(deriveOptionCellsAcrossPagesMock.mock.calls[0]![0]).toMatchObject({ label: 'Eligible field' });

    // Both fields read 3/3 now — the already-placed field unchanged, the
    // eligible one freshly auto-confirmed.
    expect(screen.getAllByText(/3\/3 placed/)).toHaveLength(2);
  });

  it('a field with some but not all options placed is still evaluated, and gets its missing options auto-placed', () => {
    renderWithField(
      choiceField('f1', 'Partial field', ['Yes', 'No', 'Maybe'], {
        segments: [
          { page: 0, x: 0, y: 0, width: 10, height: 10, pageWidth: 595, pageHeight: 842, optionKey: 'Yes' },
        ],
      }),
    );
    deriveOptionCellsAcrossPagesMock.mockReturnValue(proposal(1));

    fireEvent.click(screen.getByText('Auto-place remaining fields'));

    expect(screen.getByText(/3\/3 placed/)).toBeDefined();
  });

  it('is a no-op when every field is already fully placed — no crash, no state change', () => {
    renderWithField(fullyPlacedChoiceField('f-full', 'Full field'));
    deriveOptionCellsAcrossPagesMock.mockClear();

    fireEvent.click(screen.getByText('Auto-place remaining fields'));

    // Fully placed already, so nothing was eligible: derivation never ran...
    expect(deriveOptionCellsAcrossPagesMock).not.toHaveBeenCalled();
    // ...and nothing was staged for save.
    expect(screen.queryByText(/unsaved changes/)).toBeNull();
    expect(screen.getByText(/3\/3 placed/)).toBeDefined();
  });
});
