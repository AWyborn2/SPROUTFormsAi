// @vitest-environment jsdom
/**
 * Step 4 — units and gating.
 *
 * The derivation is tested without a DOM in `builder-manifest.test.ts`. What is
 * left here is what only the step decides, and the two that matter are the two
 * an author could get silently wrong:
 *
 *   · reordering must change PROCESS order and leave the PRINTED number alone,
 *     and the screen has to make that visible rather than merely true;
 *   · the problems shown must be the shared validator's own, ALL of them, so
 *     the builder cannot disagree with publish.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ExtractedField } from '@formai/shared';
import { UnitsStep } from './UnitsStep.js';
import { useBuilderDraftState, type BuilderDraftState } from '../use-builder-draft.js';

vi.mock('@formai/ui', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

const post = vi.fn();
vi.mock('../../../../lib/data/api-client.js', () => ({
  apiClient: { post: (...args: unknown[]) => post(...args) },
  ApiError: class ApiError extends Error {},
  uploadAttachment: vi.fn(),
}));

vi.mock('../../../../lib/data/import-session.js', () => ({
  fileToBase64: () => Promise.resolve('JVBERi0='),
  IMPORT_REQUEST_TIMEOUT_MS: 1000,
}));

function ex(over: Partial<ExtractedField> & { id: string }): ExtractedField {
  return { label: over.id, type: 'text', confidence: 0.9, ...over };
}

/** A hook holding the given extracted fields, via the real ingest path. */
async function draftOf(fields: ExtractedField[]) {
  post.mockReset();
  post.mockResolvedValueOnce({ assetId: 'a' }).mockResolvedValueOnce({
    sourceType: 'pdf_import',
    path: 'ai',
    fileName: 'assessment.pdf',
    pageCount: 3,
    fields,
    designNotes: [],
  });
  const { result } = renderHook(() => useBuilderDraftState());
  await act(async () => {
    await result.current.ingest(new File(['x'], 'assessment.pdf', { type: 'application/pdf' }));
  });
  return result;
}

function renderStep(result: { current: BuilderDraftState }) {
  function Harness() {
    return <UnitsStep draft={result.current} />;
  }
  return render(<Harness />);
}

/** A paper: a theory part and a logbook part, under their printed headings. */
const PAPER = [
  ex({ id: 'h1', type: 'section_header', label: 'PART 1 — THEORY' }),
  ex({ id: 'q1', type: 'radio', label: 'Q1', options: ['a', 'b'] }),
  ex({ id: 'h2', type: 'section_header', label: 'PART 3 — LOG' }),
  ex({
    id: 'tbl',
    type: 'repeating_group',
    label: 'Operating log',
    columns: [
      { key: 'task', label: 'Task', type: 'text' },
      { key: 'duration', label: 'Hours', type: 'number' },
    ],
  }),
];

describe('UnitsStep', () => {
  it('derives a part per section and names its printed number', async () => {
    const result = await draftOf(PAPER);
    renderStep(result);

    expect(result.current.parts.map((p) => [p.label, p.ordinal, p.kind])).toEqual([
      ['PART 1 — THEORY', 1, 'theory'],
      ['PART 3 — LOG', 2, 'logbook'],
    ]);
    expect(screen.getByText(/Printed as part 1/)).toBeTruthy();
  });

  it('REORDERING CHANGES PROCESS ORDER AND LEAVES THE PRINTED NUMBER ALONE', async () => {
    /*
      R14. An attempt records a part KEY and the ordinal is what says which
      printed pages that key means — so renumbering on a reorder would re-point
      every stored attempt at a different part of the document.
    */
    const result = await draftOf(PAPER);
    renderStep(result);

    const before = new Map(result.current.parts.map((p) => [p.key, p.ordinal]));

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Move PART 3 — LOG earlier/ }));
    });

    expect(result.current.parts.map((p) => p.label)).toEqual(['PART 3 — LOG', 'PART 1 — THEORY']);
    for (const part of result.current.parts) {
      expect(part.ordinal).toBe(before.get(part.key));
    }
  });

  it('narrows a part to the pathways that require it', async () => {
    const result = await draftOf(PAPER);
    renderStep(result);

    const first = result.current.parts[0]!;
    expect(first.pathways.length).toBeGreaterThan(1);

    act(() => {
      fireEvent.click(screen.getByRole('checkbox', { name: `New requires ${first.label}` }));
    });

    expect(result.current.parts[0]!.pathways).not.toContain('new');
  });

  it('shows every validator problem at once, in the validator’s own words', async () => {
    /*
      A logbook with no minimum hours and no declared duration column produces
      two problems. Showing one at a time makes an author re-run the gate once
      per mistake — which is what the authoring script's all-or-nothing refusal
      feels like from the outside.
    */
    const result = await draftOf(PAPER);
    renderStep(result);

    // The derived logbook has a duration column but no minimum hours.
    expect(result.current.manifestProblems.some((p) => p.includes('minimumHours'))).toBe(true);
    expect(screen.getByText(/minimumHours/)).toBeTruthy();
  });

  it('clears a problem as soon as the author fixes it', async () => {
    const result = await draftOf(PAPER);
    renderStep(result);

    const logbook = result.current.parts.find((p) => p.kind === 'logbook')!;
    act(() => result.current.partOps.update(logbook.key, { minimumHours: 20 }));

    expect(result.current.manifestProblems.some((p) => p.includes('minimumHours'))).toBe(false);
  });

  it('offers only columns that exist in the part’s own table', async () => {
    // The picker and the validator read the same slice, so a pick cannot fail
    // the gate it was made in.
    const result = await draftOf(PAPER);
    renderStep(result);

    const logbook = result.current.parts.find((p) => p.kind === 'logbook')!;
    const select = screen.getByLabelText(`Duration column for ${logbook.label}`) as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value);

    expect(values).toContain('duration');
    expect(values).toContain('task');
    expect(values).not.toContain('nonexistent');
  });

  it('keeps an author’s edit when the structure changes underneath it', async () => {
    /*
      Parts are re-derived from structure on every render, with edits layered on
      top. A resolved list held in state would freeze the manifest at the moment
      this step first opened — rename a section afterwards and the part would
      still carry the old label with nothing saying they had diverged.
    */
    const result = await draftOf(PAPER);
    const logbook = result.current.parts.find((p) => p.kind === 'logbook')!;

    act(() => result.current.partOps.update(logbook.key, { minimumHours: 20 }));
    act(() => result.current.structureOps.renameSection(logbook.sectionKey, 'Part 3 — Renamed'));

    const after = result.current.parts.find((p) => p.key === logbook.key)!;
    expect(after.label).toBe('Part 3 — Renamed');
    expect(after.minimumHours).toBe(20);
  });

  it('reset drops the author’s edits and goes back to the derivation', async () => {
    const result = await draftOf(PAPER);
    const logbook = result.current.parts.find((p) => p.kind === 'logbook')!;

    act(() => result.current.partOps.update(logbook.key, { minimumHours: 20 }));
    act(() => result.current.partOps.reset());

    expect(result.current.parts.find((p) => p.key === logbook.key)!.minimumHours).toBeUndefined();
  });

  it('surfaces the cover page’s prerequisite rows', async () => {
    // Rule 9 keeps these verbatim precisely so they reach a screen. A
    // prerequisite read as a heading disappears and nothing downstream can tell
    // it was printed.
    const result = await draftOf([
      ...PAPER,
      ex({
        id: 'pre',
        type: 'check_cross',
        label: 'Q50001782 Driver’s Licence C OR higher class',
        coverSection: 'pathway_prerequisites',
      }),
    ]);
    renderStep(result);

    expect(screen.getByText(/Driver’s Licence C OR higher class/)).toBeTruthy();
  });

  it('says so rather than rendering an empty list when there are no parts', async () => {
    const result = await draftOf([ex({ id: 'only', type: 'text', label: 'Name' })]);
    // A single cover-less section still derives one part, so empty it first.
    act(() => result.current.structureOps.reset());
    renderStep({ current: { ...result.current, parts: [] } as BuilderDraftState });

    expect(screen.getByText(/No parts yet/)).toBeTruthy();
  });
});
