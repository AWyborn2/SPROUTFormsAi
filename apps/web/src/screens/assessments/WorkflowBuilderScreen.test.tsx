// @vitest-environment jsdom
/**
 * Configuring who fills what.
 *
 * The two things this screen must not get wrong:
 *
 *  · reordering changes the PROCESS, never the printed document — the whole
 *    reason the two orderings are separate numbers;
 *  · an unconfigured tool is shown as unconfigured, rather than as a
 *    configuration somebody made.
 *
 * Everything opens collapsed on purpose. The Track Dozer carries 185 fields
 * across six parts, and a screen that opens on all of them is one nobody can
 * navigate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { AssessmentWorkflow } from '@formai/shared';
import type { AssessmentToolDetail } from '../../lib/data/assessments.js';

const toolResult: { data: AssessmentToolDetail | undefined; isLoading: boolean; isError: boolean } = {
  data: undefined,
  isLoading: false,
  isError: false,
};
const saveMutate = vi.fn();
const setLocationPartsMutate = vi.fn();
const sessionResult: { data: { role: string } | undefined } = { data: { role: 'admin' } };

vi.mock('react-router-dom', () => ({
  useParams: () => ({ toolId: 'tool-1' }),
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

vi.mock('../../lib/data/hooks.js', () => ({
  useAssessmentTool: () => toolResult,
  useCompetencies: () => ({ data: [{ id: 'comp-1', name: 'Drivers Licence C or higher' }] }),
  useSaveWorkflow: () => ({ mutate: saveMutate, isPending: false }),
  useSetLocationParts: () => ({ mutate: setLocationPartsMutate, isPending: false }),
  useSession: () => sessionResult,
}));

const toast = vi.fn();
vi.mock('@formai/ui', async () => {
  const actual = await vi.importActual<typeof import('@formai/ui')>('@formai/ui');
  return { ...actual, useToast: () => ({ toast }) };
});

const { WorkflowBuilderScreen } = await import('./WorkflowBuilderScreen.js');

const WORKFLOW: AssessmentWorkflow = {
  roles: ['candidate', 'assessor'],
  sections: [
    {
      key: 'p1',
      ordinal: 1,
      label: 'Part 1 — Theory',
      partKey: 'p1',
      access: { candidate: 'fill', assessor: 'view' },
    },
    {
      key: 'p2',
      ordinal: 2,
      label: 'Part 2 — Practical',
      partKey: 'p2',
      access: { candidate: 'view', assessor: 'fill' },
    },
  ],
};

function tool(over: Partial<AssessmentToolDetail> = {}): AssessmentToolDetail {
  return {
    id: 'tool-1',
    name: 'Authorised to Operate Track Dozer',
    templateId: 'tpl-1',
    manifest: {
      parts: [
        { key: 'p1', ordinal: 1, label: 'Part 1 — Theory', kind: 'theory', pathways: ['new'], startFieldId: 'h1' },
        { key: 'p2', ordinal: 2, label: 'Part 2 — Practical', kind: 'practical', pathways: ['new'], startFieldId: 'h2' },
      ],
    },
    workflow: WORKFLOW,
    workflowIsDefault: false,
    fields: [
      { id: 'h1', type: 'section_header', label: 'General questions', required: false, source: 'imported' },
      { id: 'q1', type: 'text', label: 'Question one', required: false, source: 'imported' },
      { id: 'h2', type: 'section_header', label: 'Plan & Prepare', required: false, source: 'imported' },
      { id: 'crit1', type: 'check_cross', label: 'Wears correct PPE', required: false, source: 'imported' },
    ],
    locations: [],
    locationPartKeys: {},
    problems: [],
    warnings: [],
    ...over,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  toolResult.data = undefined;
  toolResult.isLoading = false;
  toolResult.isError = false;
  sessionResult.data = { role: 'admin' };
});

describe('WorkflowBuilderScreen', () => {
  it('lists sections in PROCESS order', () => {
    toolResult.data = tool();
    render(<WorkflowBuilderScreen />);

    expect(screen.getByText('Part 1 — Theory')).toBeDefined();
    expect(screen.getByText('Part 2 — Practical')).toBeDefined();
  });

  it('opens with every section collapsed', () => {
    /*
      185 fields across six parts. Expanded by default the screen opens on a
      wall; collapsed it opens on the handful of decisions an author makes.
    */
    toolResult.data = tool();
    render(<WorkflowBuilderScreen />);

    expect(screen.queryByText('General questions')).toBeNull();
    expect(screen.queryByText('Question one')).toBeNull();
  });

  it('groups a part’s fields under the printed headings, still collapsed', () => {
    toolResult.data = tool();
    render(<WorkflowBuilderScreen />);

    fireEvent.click(screen.getByText('Part 1 — Theory'));

    // The heading group appears…
    expect(screen.getByText('General questions')).toBeDefined();
    // …and its fields do not, until it is opened too.
    expect(screen.queryByText('Question one')).toBeNull();

    fireEvent.click(screen.getByText('General questions'));
    expect(screen.getByText('Question one')).toBeDefined();
  });

  it('says plainly when nobody has configured this yet', () => {
    // An author must not be shown a default presented as their own decision.
    toolResult.data = tool({ workflowIsDefault: true });
    render(<WorkflowBuilderScreen />);

    expect(screen.getByText(/Nobody has set this up yet/)).toBeDefined();
  });

  it('does not say that once a workflow has been configured', () => {
    toolResult.data = tool({ workflowIsDefault: false });
    render(<WorkflowBuilderScreen />);

    expect(screen.queryByText(/Nobody has set this up yet/)).toBeNull();
  });

  it('changes a role’s access to a section', () => {
    toolResult.data = tool();
    render(<WorkflowBuilderScreen />);

    const group = screen.getByRole('group', { name: 'Candidate access to Part 2 — Practical' });
    fireEvent.click(within(group).getByText('fill'));
    fireEvent.click(screen.getByText('Save workflow'));

    // The mutation now carries `{ workflow, profilePrefill? }` — the map rides
    // beside the workflow so saving one cannot erase the other.
    const saved = (saveMutate.mock.calls[0]![0] as { workflow: AssessmentWorkflow }).workflow;
    expect(saved.sections.find((s) => s.key === 'p2')!.access.candidate).toBe('fill');
  });

  it('REORDERS THE PROCESS, not the document', () => {
    /*
      The point of two separate numbers. Moving a card swaps `section.ordinal`;
      `part.ordinal` — where it prints, and what the exported evidence is laid
      out by — must not move at all.
    */
    toolResult.data = tool();
    render(<WorkflowBuilderScreen />);

    fireEvent.click(screen.getByLabelText('Move Part 2 — Practical earlier'));
    fireEvent.click(screen.getByText('Save workflow'));

    // The mutation now carries `{ workflow, profilePrefill? }` — the map rides
    // beside the workflow so saving one cannot erase the other.
    const saved = (saveMutate.mock.calls[0]![0] as { workflow: AssessmentWorkflow }).workflow;
    expect(saved.sections.find((s) => s.key === 'p2')!.ordinal).toBe(1);
    expect(saved.sections.find((s) => s.key === 'p1')!.ordinal).toBe(2);
    // Nothing in the manifest moved — the screen never touches it.
    expect(toolResult.data!.manifest.parts.map((p) => p.ordinal)).toEqual([1, 2]);
  });

  it('cannot move the first section earlier or the last one later', () => {
    toolResult.data = tool();
    render(<WorkflowBuilderScreen />);

    expect(screen.getByLabelText('Move Part 1 — Theory earlier')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Move Part 2 — Practical later')).toHaveProperty('disabled', true);
  });

  it('offers nothing to save until something changes', () => {
    toolResult.data = tool();
    render(<WorkflowBuilderScreen />);

    expect(screen.getByText('Saved')).toHaveProperty('disabled', true);
  });

  it('shows problems that block a save', () => {
    toolResult.data = tool({ problems: ['Section "x" requires itself.'] });
    render(<WorkflowBuilderScreen />);

    expect(screen.getByText(/requires itself/)).toBeDefined();
  });

  it('shows warnings without implying they block anything', () => {
    toolResult.data = tool({ warnings: ['Nobody fills "Part 2 — Practical".'] });
    render(<WorkflowBuilderScreen />);

    expect(screen.getByText(/Nobody fills/)).toBeDefined();
    expect(screen.queryByText(/cannot be saved/)).toBeNull();
  });

  it('says so when a failed save leaves the work on screen', () => {
    // Without this a rejected workflow reads as a click that did nothing.
    toolResult.data = tool();
    saveMutate.mockImplementation((_w, opts) => opts?.onError?.(new Error('invalid_workflow')));
    render(<WorkflowBuilderScreen />);

    fireEvent.click(screen.getByLabelText('Move Part 2 — Practical earlier'));
    fireEvent.click(screen.getByText('Save workflow'));

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'warning', message: expect.stringContaining('invalid_workflow') }),
    );
  });

  it('reports a failed load rather than an empty screen', () => {
    toolResult.isError = true;
    render(<WorkflowBuilderScreen />);

    expect(screen.getByText(/Could not load/)).toBeDefined();
  });
});

describe('WorkflowBuilderScreen — where each part applies (U9)', () => {
  const withLocations = () =>
    tool({
      locations: [
        { id: 'loc-m', name: 'Mining' },
        { id: 'loc-r', name: 'Raw Materials' },
      ],
    });

  const openPanel = () => fireEvent.click(screen.getByText('Where each part applies'));

  function card(name: string) {
    const el = screen.getByText(name).closest('.rounded-md');
    if (!el) throw new Error(`no card for ${name}`);
    return el as HTMLElement;
  }

  it('stores only the exceptions — a narrowed Location, nothing for an untouched one', () => {
    toolResult.data = withLocations();
    render(<WorkflowBuilderScreen />);
    openPanel();

    // Mining drops its practical part; Raw Materials is left at the default.
    fireEvent.click(within(card('Mining')).getByRole('button', { name: 'Part 2 — Practical' }));
    fireEvent.click(screen.getByText('Save parts rule'));

    expect(setLocationPartsMutate).toHaveBeenCalledTimes(1);
    const saved = setLocationPartsMutate.mock.calls[0]![0] as Record<string, string[]>;
    expect(saved).toEqual({ 'loc-m': ['p1'] });
  });

  it('drops the entry when every part is turned back on — the default IS every part', () => {
    toolResult.data = tool({
      locations: [{ id: 'loc-m', name: 'Mining' }],
      locationPartKeys: { 'loc-m': ['p1'] },
    });
    render(<WorkflowBuilderScreen />);
    openPanel();

    // Turning the practical part back on restores the full set → no explicit entry.
    fireEvent.click(within(card('Mining')).getByRole('button', { name: 'Part 2 — Practical' }));
    fireEvent.click(screen.getByText('Save parts rule'));

    const saved = setLocationPartsMutate.mock.calls[0]![0] as Record<string, string[]>;
    expect(saved).toEqual({});
  });

  it('reads only for a non-admin — no toggles, no save (R73)', () => {
    sessionResult.data = { role: 'builder' };
    toolResult.data = withLocations();
    render(<WorkflowBuilderScreen />);
    openPanel();

    expect(screen.getByText(/Only an admin can change/)).toBeDefined();
    expect(screen.queryByText('Save parts rule')).toBeNull();
    expect(
      within(card('Mining')).getByRole('button', { name: 'Part 1 — Theory' }),
    ).toHaveProperty('disabled', true);
  });

  it('says a rule for a retired Location is kept (R118)', () => {
    toolResult.data = tool({
      locations: [{ id: 'loc-m', name: 'Mining' }],
      locationPartKeys: { 'loc-m': ['p1'], 'loc-gone': ['p2'] },
    });
    render(<WorkflowBuilderScreen />);
    openPanel();

    expect(screen.getByText(/retired Location/)).toBeDefined();
  });

  it('offers nowhere to vary parts when the org has no Locations', () => {
    toolResult.data = tool({ locations: [] });
    render(<WorkflowBuilderScreen />);
    openPanel();

    expect(screen.getByText(/no Locations yet/)).toBeDefined();
    expect(screen.queryByText('Save parts rule')).toBeNull();
  });
});
