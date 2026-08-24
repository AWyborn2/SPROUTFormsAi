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
const updateSettingsMutate = vi.fn();
const sessionResult: { data: { role: string } | undefined } = { data: { role: 'admin' } };
const taxonomyResult: { data: { settings: { allowLabelledSignoff: boolean } } | undefined } = {
  data: { settings: { allowLabelledSignoff: true } },
};

vi.mock('react-router-dom', () => ({
  useParams: () => ({ toolId: 'tool-1' }),
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));

const uploadCourseMutate = vi.fn();
const coursesResult: {
  data: { courses: { id: string; title: string; slideCount: number | null; fileCount: number }[] } | undefined;
} = {
  data: {
    courses: [
      { id: 'course-1', title: 'Mine Site SME Operating Manual', slideCount: 52, fileCount: 33 },
    ],
  },
};

vi.mock('../../lib/data/hooks.js', () => ({
  useAssessmentTool: () => toolResult,
  useCompetencies: () => ({
    data: [
      { id: 'comp-1', name: 'Drivers Licence C or higher' },
      { id: 'comp-hr', name: 'Licence - Rigid (HR)' },
    ],
  }),
  useCourses: () => coursesResult,
  useSaveWorkflow: () => ({ mutate: saveMutate, isPending: false }),
  useSetLocationParts: () => ({ mutate: setLocationPartsMutate, isPending: false }),
  useSession: () => sessionResult,
  useTaxonomy: () => taxonomyResult,
  useUpdateTaxonomySettings: () => ({ mutate: updateSettingsMutate, isPending: false }),
  useUploadCourse: () => ({ mutate: uploadCourseMutate, isPending: false }),
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
  taxonomyResult.data = { settings: { allowLabelledSignoff: true } };
});

describe('WorkflowBuilderScreen', () => {
  it('lists sections in PROCESS order', () => {
    toolResult.data = tool();
    render(<WorkflowBuilderScreen />);

    expect(screen.getByRole('button', { name: /^Part 1 — Theory/ })).toBeDefined();
    expect(screen.getByRole('button', { name: /^Part 2 — Practical/ })).toBeDefined();
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

    fireEvent.click(screen.getByRole('button', { name: /^Part 1 — Theory/ }));

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

describe('WorkflowBuilderScreen — labelled sign-off policy (both places)', () => {
  const withLabelledRole = (over: Partial<AssessmentToolDetail> = {}) =>
    tool({ workflow: { ...WORKFLOW, roles: ['candidate', 'assessor', 'sme'] }, ...over });

  it('stays hidden until a supervisor or SME role is on — noise otherwise', () => {
    // Candidate + assessor never apply a signature on someone's behalf.
    toolResult.data = tool();
    render(<WorkflowBuilderScreen />);
    expect(screen.queryByText(/Labelled sign-off/)).toBeNull();
  });

  it('shows the org policy beside the sign-off roles once one is on', () => {
    toolResult.data = withLabelledRole();
    render(<WorkflowBuilderScreen />);
    expect(screen.getByText(/Labelled sign-off/)).toBeDefined();
    expect(screen.getByText(/organisation-wide/)).toBeDefined();
  });

  it('writes the SAME org-wide setting the Settings card does', () => {
    toolResult.data = withLabelledRole();
    render(<WorkflowBuilderScreen />);

    // Checked (allowed) → clicking turns it off, org-wide.
    fireEvent.click(screen.getByLabelText('Supervisor / SME sign-off by labelled signature'));
    expect(updateSettingsMutate).toHaveBeenCalledWith(
      { allowLabelledSignoff: false },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it('reflects the OFF policy in words — the case waits for a login', () => {
    taxonomyResult.data = { settings: { allowLabelledSignoff: false } };
    toolResult.data = withLabelledRole();
    render(<WorkflowBuilderScreen />);
    expect(screen.getByText(/must be the named person/)).toBeDefined();
  });

  it('is read-only for a non-admin (R73)', () => {
    sessionResult.data = { role: 'builder' };
    toolResult.data = withLabelledRole();
    render(<WorkflowBuilderScreen />);

    expect(
      screen.getByLabelText('Supervisor / SME sign-off by labelled signature'),
    ).toHaveProperty('disabled', true);
    expect(screen.getByText(/Only an admin or owner can change this/)).toBeDefined();
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

/**
 * The summary auto-fill card. Publish GUESSES the result pair and the methods
 * mapping from printed labels with no way to see or fix the guess; this card
 * is the fix, so what it shows and what a save carries are pinned here.
 */
describe('WorkflowBuilderScreen — summary auto-fill', () => {
  const methodsTable: AssessmentToolDetail['fields'][number] = {
    id: 'methods',
    type: 'repeating_group',
    label: 'Assessment Methods',
    required: false,
    source: 'imported',
    fixedRows: ['1. Theory', '2. Practical Demonstration'],
    columns: [
      { key: 'method', label: 'Method', type: 'text' },
      { key: 'done', label: 'Done', type: 'checkbox' },
    ],
  };

  it('seeds the result pair from the manifest and saves a repointed box', () => {
    toolResult.data = tool({
      manifest: {
        ...tool().manifest,
        signOff: { overallSatisfactory: { fieldId: 'crit1', value: true } },
      },
    });
    render(<WorkflowBuilderScreen />);

    const competent = screen.getByLabelText(
      'Printed box for Candidate Competent',
    ) as HTMLSelectElement;
    expect(competent.value).toBe('crit1');

    fireEvent.change(screen.getByLabelText('Printed box for Candidate not yet Competent'), {
      target: { value: 'crit1' },
    });
    fireEvent.click(screen.getByText('Save workflow'));

    const payload = saveMutate.mock.calls[0]![0] as {
      signOff?: { overallSatisfactory?: { fieldId: string }; overallNotSatisfactory?: { fieldId: string } };
    };
    // The repoint rides WITH the stored half — repointing one box must not
    // shed the other.
    expect(payload.signOff?.overallSatisfactory?.fieldId).toBe('crit1');
    expect(payload.signOff?.overallNotSatisfactory).toEqual({ fieldId: 'crit1', value: true });
  });

  it('maps a pathway to its printed box — only the pathways this tool declares', () => {
    toolResult.data = tool();
    render(<WorkflowBuilderScreen />);

    // Parts declare only 'new', so 'experienced' is not offered.
    expect(screen.queryByLabelText(/Experienced \/ re-assessment pathway/)).toBeNull();

    fireEvent.change(
      screen.getByLabelText('Printed box for the New / inexperienced pathway'),
      { target: { value: 'crit1' } },
    );
    fireEvent.click(screen.getByText('Save workflow'));

    const payload = saveMutate.mock.calls[0]![0] as {
      pathwayMarks?: Record<string, { fieldId: string; value: unknown }>;
    };
    expect(payload.pathwayMarks).toEqual({ new: { fieldId: 'crit1', value: true } });
  });

  it('shows the mapping publish guessed ON the table row, and saves a corrected one', () => {
    // The control lives on the field itself — open its section and heading
    // group to reach it, like any other field override.
    toolResult.data = tool({
      fields: [...tool().fields, methodsTable],
      manifest: {
        ...tool().manifest,
        partCompletionMarks: [{ partKey: 'p1', fieldId: 'methods', rowIndex: 0, columnKey: 'done' }],
      },
    });
    render(<WorkflowBuilderScreen />);
    fireEvent.click(screen.getByRole('button', { name: /^Part 2 — Practical/ }));
    fireEvent.click(screen.getByText('Plan & Prepare'));

    const row0 = screen.getByLabelText('When "1. Theory" ticks') as HTMLSelectElement;
    // The invisible guess, finally visible.
    expect(row0.value).toBe('p1');

    fireEvent.change(screen.getByLabelText('When "2. Practical Demonstration" ticks'), {
      target: { value: 'p2' },
    });
    fireEvent.click(screen.getByText('Save workflow'));

    const payload = saveMutate.mock.calls[0]![0] as {
      partCompletionMarks?: Array<{ partKey: string; fieldId: string; rowIndex: number; columnKey: string }>;
    };
    expect(payload.partCompletionMarks).toEqual([
      { partKey: 'p1', fieldId: 'methods', rowIndex: 0, columnKey: 'done' },
      { partKey: 'p2', fieldId: 'methods', rowIndex: 1, columnKey: 'done' },
    ]);
  });

  it('maps one row to SEVERAL parts with the "+ and…" adder, and removes one by its chip', () => {
    /*
      The Track Dozer's Theory method spans three theory parts. The row ticks
      once every mapped part the case requires has passed, so the author lists
      them all here and the case's Location decides which ones count.
    */
    toolResult.data = tool({
      fields: [...tool().fields, methodsTable],
      manifest: {
        ...tool().manifest,
        partCompletionMarks: [{ partKey: 'p1', fieldId: 'methods', rowIndex: 0, columnKey: 'done' }],
      },
    });
    render(<WorkflowBuilderScreen />);
    fireEvent.click(screen.getByRole('button', { name: /^Part 2 — Practical/ }));
    fireEvent.click(screen.getByText('Plan & Prepare'));

    fireEvent.change(screen.getByLabelText('Also require another part before "1. Theory" ticks'), {
      target: { value: 'p2' },
    });
    fireEvent.click(screen.getByText('Save workflow'));

    const payload = saveMutate.mock.calls[0]![0] as {
      partCompletionMarks?: Array<{ partKey: string; rowIndex: number }>;
    };
    expect(payload.partCompletionMarks).toEqual([
      { partKey: 'p1', fieldId: 'methods', rowIndex: 0, columnKey: 'done' },
      { partKey: 'p2', fieldId: 'methods', rowIndex: 0, columnKey: 'done' },
    ]);

    // The extra renders as a removable chip; removing it leaves the primary.
    fireEvent.click(
      screen.getByLabelText('"1. Theory" no longer waits for Part 2 — Practical'),
    );
    fireEvent.click(screen.getByText('Save workflow'));
    const second = saveMutate.mock.calls[1]![0] as {
      partCompletionMarks?: Array<{ partKey: string }>;
    };
    expect(second.partCompletionMarks).toEqual([
      { partKey: 'p1', fieldId: 'methods', rowIndex: 0, columnKey: 'done' },
    ]);
  });

  it('switching a row from Always ticked to a part clears the preset — one row, one mechanism', () => {
    // A row pre-ticked AND completion-mapped would print ticked on untouched
    // cases while claiming to track completion; the one dropdown makes the
    // states exclusive.
    toolResult.data = tool({
      fields: [...tool().fields, methodsTable],
      manifest: {
        ...tool().manifest,
        fieldDefaults: { methods: [{ done: true }] },
      },
    });
    render(<WorkflowBuilderScreen />);
    fireEvent.click(screen.getByRole('button', { name: /^Part 2 — Practical/ }));
    fireEvent.click(screen.getByText('Plan & Prepare'));

    const row0 = screen.getByLabelText('When "1. Theory" ticks') as HTMLSelectElement;
    expect(row0.value).toBe('__always__');

    fireEvent.change(row0, { target: { value: 'p1' } });
    fireEvent.click(screen.getByText('Save workflow'));

    const payload = saveMutate.mock.calls[0]![0] as {
      fieldDefaults?: Record<string, unknown> | null;
      partCompletionMarks?: Array<{ partKey: string; rowIndex: number }>;
    };
    expect(payload.fieldDefaults).toBeNull();
    expect(payload.partCompletionMarks).toEqual([
      { partKey: 'p1', fieldId: 'methods', rowIndex: 0, columnKey: 'done' },
    ]);
  });

  it('adds an always-ticked box as a field default', () => {
    toolResult.data = tool();
    render(<WorkflowBuilderScreen />);

    fireEvent.change(screen.getByLabelText('Add an always-ticked box'), {
      target: { value: 'crit1' },
    });
    fireEvent.click(screen.getByText('Save workflow'));

    const payload = saveMutate.mock.calls[0]![0] as {
      fieldDefaults?: Record<string, unknown>;
    };
    expect(payload.fieldDefaults).toEqual({ crit1: true });
  });

  it('sends none of it untouched — a plain workflow save cannot erase the wiring', () => {
    toolResult.data = tool();
    render(<WorkflowBuilderScreen />);

    const group = screen.getByRole('group', { name: 'Candidate access to Part 2 — Practical' });
    fireEvent.click(within(group).getByText('fill'));
    fireEvent.click(screen.getByText('Save workflow'));

    const payload = saveMutate.mock.calls[0]![0] as Record<string, unknown>;
    expect('signOff' in payload).toBe(false);
    expect('pathwayMarks' in payload).toBe(false);
    expect('partCompletionMarks' in payload).toBe(false);
  });
});

/**
 * The pickers offer OPTIONS of choice fields, not just whole ✓/✗ boxes. A
 * printed pair — the two pathway lines, "not yet Competent / Competent" —
 * usually extracts as ONE field with two options, each option carrying its
 * own printed box; offering only whole fields hid exactly those boxes.
 */
describe('WorkflowBuilderScreen — summary auto-fill choice-field options', () => {
  const pathwayGroup: AssessmentToolDetail['fields'][number] = {
    id: 'pw-group',
    type: 'checkbox_group',
    label: 'Methods used to assess competence',
    required: false,
    source: 'imported',
    options: [
      'PART 1 and 2: Experienced candidates or Re-assessments',
      'PART 1, 2, 3, 4, 5 and Final: New and inexperienced candidates',
    ],
  };
  const resultPair: AssessmentToolDetail['fields'][number] = {
    id: 'result-pair',
    type: 'radio',
    label: 'Assessment Result',
    required: false,
    source: 'imported',
    options: ['Candidate not yet Competent', 'Candidate Competent'],
  };

  it('maps a pathway to one OPTION of a checkbox group', () => {
    toolResult.data = tool({ fields: [...tool().fields, pathwayGroup] });
    render(<WorkflowBuilderScreen />);

    const select = screen.getByLabelText(
      'Printed box for the New / inexperienced pathway',
    ) as HTMLSelectElement;
    const wanted = [...select.options].find((o) =>
      o.text.includes('New and inexperienced candidates'),
    );
    expect(wanted).toBeDefined();

    fireEvent.change(select, { target: { value: wanted!.value } });
    fireEvent.click(screen.getByText('Save workflow'));

    const payload = saveMutate.mock.calls[0]![0] as {
      pathwayMarks?: Record<string, { fieldId: string; value: unknown }>;
    };
    // A checkbox group ticks by SELECTION: the mark writes the option array.
    expect(payload.pathwayMarks).toEqual({
      new: {
        fieldId: 'pw-group',
        value: ['PART 1, 2, 3, 4, 5 and Final: New and inexperienced candidates'],
      },
    });
  });

  it('maps the result pair to the OPTIONS of a radio, and round-trips the stored mark', () => {
    toolResult.data = tool({
      fields: [...tool().fields, resultPair],
      manifest: {
        ...tool().manifest,
        signOff: {
          overallSatisfactory: { fieldId: 'result-pair', value: 'Candidate Competent' },
        },
      },
    });
    render(<WorkflowBuilderScreen />);

    const competent = screen.getByLabelText(
      'Printed box for Candidate Competent',
    ) as HTMLSelectElement;
    // The stored option-mark seeds the select back to its own entry.
    expect(competent.selectedOptions[0]?.text).toBe(
      'Assessment Result — Candidate Competent',
    );

    const notYet = screen.getByLabelText(
      'Printed box for Candidate not yet Competent',
    ) as HTMLSelectElement;
    const wanted = [...notYet.options].find((o) => o.text.includes('not yet Competent'));
    fireEvent.change(notYet, { target: { value: wanted!.value } });
    fireEvent.click(screen.getByText('Save workflow'));

    const payload = saveMutate.mock.calls[0]![0] as {
      signOff?: { overallNotSatisfactory?: { fieldId: string; value: unknown } };
    };
    // A radio ticks by ANSWER: the mark writes the option string.
    expect(payload.signOff?.overallNotSatisfactory).toEqual({
      fieldId: 'result-pair',
      value: 'Candidate not yet Competent',
    });
  });

  it('pre-ticks one option of a group as an always-ticked default', () => {
    toolResult.data = tool({ fields: [...tool().fields, pathwayGroup] });
    render(<WorkflowBuilderScreen />);

    const add = screen.getByLabelText('Add an always-ticked box') as HTMLSelectElement;
    const wanted = [...add.options].find((o) => o.text.includes('Experienced candidates'));
    fireEvent.change(add, { target: { value: wanted!.value } });
    fireEvent.click(screen.getByText('Save workflow'));

    const payload = saveMutate.mock.calls[0]![0] as { fieldDefaults?: Record<string, unknown> };
    expect(payload.fieldDefaults).toEqual({
      'pw-group': ['PART 1 and 2: Experienced candidates or Re-assessments'],
    });
  });

  it('keeps quiz machinery out of the pickers — keyed questions and their ✓/✗ cells', () => {
    // Offering every option of a thirty-question paper buried the handful of
    // real summary boxes. A keyed question and the cell its mark lands in are
    // auto-marking's territory, not a summary target.
    const question: AssessmentToolDetail['fields'][number] = {
      id: 'quiz-q1',
      type: 'radio',
      label: '1. What are the minimum requirements?',
      required: false,
      source: 'imported',
      options: ['PPE', 'Crib bag'],
      answerKey: ['PPE'],
      outcomeTarget: { fieldId: 'quiz-q1-out' },
    };
    const cell: AssessmentToolDetail['fields'][number] = {
      id: 'quiz-q1-out',
      type: 'check_cross',
      label: 'Outcome for Q1',
      required: false,
      source: 'imported',
    };
    toolResult.data = tool({ fields: [...tool().fields, question, cell] });
    render(<WorkflowBuilderScreen />);

    const add = screen.getByLabelText('Add an always-ticked box') as HTMLSelectElement;
    const texts = [...add.options].map((o) => o.text);
    expect(texts.some((t) => t.includes('minimum requirements'))).toBe(false);
    expect(texts).not.toContain('Outcome for Q1');
    // The real boxes are still there.
    expect(texts).toContain('Wears correct PPE');
  });
});

/**
 * A prerequisite box answered by ANY of several classes — "Driver's Licence C
 * or higher" is a family, and a check that could name only one class failed a
 * candidate holding a higher one.
 */
describe('WorkflowBuilderScreen — any-of prerequisite classes', () => {
  it('adds a second class with "+ or…" and saves the plural spelling', () => {
    toolResult.data = tool({
      manifest: {
        ...tool().manifest,
        prerequisiteChecks: [{ fieldId: 'crit1', competencyId: 'comp-1' }],
      },
    });
    render(<WorkflowBuilderScreen />);

    // The legacy single-class check seeds the primary select.
    const primary = screen.getByLabelText('Competency that answers it') as HTMLSelectElement;
    expect(primary.value).toBe('comp-1');

    fireEvent.change(screen.getByLabelText('Accept another class for this prerequisite'), {
      target: { value: 'comp-hr' },
    });
    fireEvent.click(screen.getByText('Save workflow'));

    const payload = saveMutate.mock.calls[0]![0] as {
      prerequisiteChecks?: Array<{ fieldId: string; competencyIds?: string[] }>;
    };
    expect(payload.prerequisiteChecks).toEqual([
      { fieldId: 'crit1', competencyIds: ['comp-1', 'comp-hr'], competencyId: undefined },
    ]);
  });

  it('removes a class by its chip, keeping the rest', () => {
    toolResult.data = tool({
      manifest: {
        ...tool().manifest,
        prerequisiteChecks: [{ fieldId: 'crit1', competencyIds: ['comp-1', 'comp-hr'] }],
      },
    });
    render(<WorkflowBuilderScreen />);

    expect(screen.getByText(/or Licence - Rigid \(HR\)/)).toBeDefined();
    fireEvent.click(
      screen.getByLabelText('Remove Licence - Rigid (HR) from this prerequisite'),
    );
    fireEvent.click(screen.getByText('Save workflow'));

    const payload = saveMutate.mock.calls[0]![0] as {
      prerequisiteChecks?: Array<{ competencyIds?: string[] }>;
    };
    expect(payload.prerequisiteChecks?.[0]?.competencyIds).toEqual(['comp-1']);
  });
});

/**
 * The parts' printed verdict pairs, finally author-mappable — the fix for a
 * "responses were" pair that publish's guess missed or hung on a part the
 * case excludes.
 */
describe('WorkflowBuilderScreen — part results', () => {
  it('maps a part pair to choice-field options and saves full state per part', () => {
    const pair: AssessmentToolDetail['fields'][number] = {
      id: 'p1-verdict',
      type: 'radio',
      label: 'PART 1 - The Candidate’s responses were',
      required: false,
      source: 'imported',
      options: ['Satisfactory', 'Not Satisfactory'],
    };
    toolResult.data = tool({ fields: [...tool().fields, pair] });
    render(<WorkflowBuilderScreen />);

    const yes = screen.getByLabelText('Satisfactory box for Part 1 — Theory') as HTMLSelectElement;
    const wantedYes = [...yes.options].find((o) => o.text.endsWith('— Satisfactory'));
    fireEvent.change(yes, { target: { value: wantedYes!.value } });
    const no = screen.getByLabelText(
      'Not Satisfactory box for Part 1 — Theory',
    ) as HTMLSelectElement;
    const wantedNo = [...no.options].find((o) => o.text.endsWith('— Not Satisfactory'));
    fireEvent.change(no, { target: { value: wantedNo!.value } });
    fireEvent.click(screen.getByText('Save workflow'));

    const payload = saveMutate.mock.calls[0]![0] as {
      partOutcomeMarks?: Array<{
        partKey: string;
        outcomeSatisfactory?: { fieldId: string; value: unknown };
        outcomeNotSatisfactory?: { fieldId: string; value: unknown };
      }>;
    };
    expect(payload.partOutcomeMarks).toEqual([
      {
        partKey: 'p1',
        outcomeSatisfactory: { fieldId: 'p1-verdict', value: 'Satisfactory' },
        outcomeNotSatisfactory: { fieldId: 'p1-verdict', value: 'Not Satisfactory' },
      },
      { partKey: 'p2' },
    ]);
  });
});

/*
  The Course material card (task #56): pick an org package, decide whether it
  gates the assessment, and send the link tri-state beside the workflow — set,
  keep-by-absence, clear.
*/
describe('WorkflowBuilderScreen — course material', () => {
  it('selecting a package sends the link, required by default', () => {
    toolResult.data = tool();
    render(<WorkflowBuilderScreen />);

    fireEvent.change(screen.getByLabelText('Course package'), {
      target: { value: 'course-1' },
    });
    // What the import understood is echoed beside the picker.
    expect(screen.getByText(/52 slides · 33 files/)).toBeDefined();

    fireEvent.click(screen.getByText('Save workflow'));
    expect(saveMutate.mock.calls[0]![0]).toMatchObject({
      course: { courseId: 'course-1', required: true },
    });
  });

  it('the requirement is the author’s call, and clearing sends null', () => {
    toolResult.data = tool({
      manifest: {
        parts: [
          { key: 'p1', ordinal: 1, label: 'Part 1 — Theory', kind: 'theory', pathways: ['new'], startFieldId: 'h1' },
        ],
        course: { courseId: 'course-1', required: true },
      },
    });
    render(<WorkflowBuilderScreen />);

    // The stored link renders selected with its gate ticked.
    const required = screen.getByLabelText(
      'Required before the assessment can start',
    ) as HTMLInputElement;
    expect(required.checked).toBe(true);

    fireEvent.click(required);
    fireEvent.click(screen.getByText('Save workflow'));
    expect(saveMutate.mock.calls[0]![0]).toMatchObject({
      course: { courseId: 'course-1', required: false },
    });

    saveMutate.mockClear();
    fireEvent.change(screen.getByLabelText('Course package'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save workflow'));
    expect(saveMutate.mock.calls[0]![0]).toMatchObject({ course: null });
  });

  it('an untouched card sends no course key at all', () => {
    toolResult.data = tool();
    render(<WorkflowBuilderScreen />);

    // Dirty the save through an unrelated card, leaving the course card alone.
    fireEvent.click(screen.getByText('Add a prerequisite check'));
    fireEvent.click(screen.getByText('Save workflow'));
    expect(saveMutate).toHaveBeenCalled();
    expect('course' in (saveMutate.mock.calls[0]![0] as Record<string, unknown>)).toBe(false);
  });
});
