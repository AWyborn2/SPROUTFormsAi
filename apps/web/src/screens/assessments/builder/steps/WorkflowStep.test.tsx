// @vitest-environment jsdom
/**
 * Step 7 — publish, and WHAT THE ASSESSMENT AWARDS (U5, R1, R2 — AE2).
 *
 * The award control is scoped by ACTION, not by the revision flag: every path
 * that CREATES a tool must send exactly one awarded competency (U2 400s
 * `invalid_award` otherwise), and no path that UPDATES a tool may touch it.
 * That gives three behaviours worth pinning, each a way to ship the wrong
 * thing silently:
 *
 *   · a fresh publish with no award picked would 400 at the last step of a
 *     seven-step flow — so publish stays DISABLED until one is chosen;
 *   · the deleted-form recovery ("publish as a new tool") calls createTool
 *     too, so it must render the same control and send the id;
 *   · a republish updates the EXISTING tool, whose award already stands —
 *     rendering the control there would invite an accidental re-link that
 *     the API deliberately guards behind its own preview (KTD10).
 *
 * The publish plumbing itself (validators, manifests, republish guards) is
 * tested where it lives: builder-publish.test.ts and the API suites. Those
 * modules are mocked flat here so these tests exercise only what this step
 * decides.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ApiError } from '../../../../lib/data/api-client.js';
import type { Competency } from '../../../../lib/data/types.js';
import type { BuilderDraftState } from '../use-builder-draft.js';

const createToolAsync = vi.fn();
const createDraftAsync = vi.fn();
const publishVersionAsync = vi.fn();
const saveFieldsAsync = vi.fn();
const createCompetencyMutate = vi.fn();
const competencies: { data: Competency[] } = { data: [] };

vi.mock('../../../../lib/data/hooks.js', () => ({
  useCreateAssessmentTool: () => ({ mutateAsync: createToolAsync, isPending: false }),
  useCreateDraftForm: () => ({ mutateAsync: createDraftAsync, isPending: false }),
  usePublishFormVersion: () => ({ mutateAsync: publishVersionAsync, isPending: false }),
  useSaveVersionFields: () => ({ mutateAsync: saveFieldsAsync, isPending: false }),
  useCompetencies: () => competencies,
  useCreateCompetency: () => ({ mutate: createCompetencyMutate, isPending: false }),
}));

const storePublishFormVersion = vi.fn();
vi.mock('../../../../lib/data/store.js', () => ({
  store: {
    publishFormVersion: (...args: unknown[]) => storePublishFormVersion(...args),
    listBuilderDrafts: vi.fn().mockResolvedValue([]),
    discardBuilderDraft: vi.fn(),
  },
}));

const republishAsync = vi.fn();
vi.mock('../../../../lib/data/assessments.js', () => ({
  assessmentsApi: { republishTool: (...args: unknown[]) => republishAsync(...args) },
}));

vi.mock('../use-start-revision.js', () => ({
  useStartRevision: () => ({ start: vi.fn() }),
}));

/*
  The publish gate itself is builder-publish.test.ts's subject; here it is held
  open so the only thing standing between the author and publish is what THIS
  round added — the award.
*/
vi.mock('../builder-publish.js', () => ({
  checkPublish: () => ({ problems: [], fields: [], carried: [], inferred: [], unplaced: [] }),
  extractionQuestionRefs: () => new Map<string, string>(),
  publishSummary: () => ({ parts: 1, questionsKeyed: 2, questionsVerified: 1, boxesPlaced: 2 }),
  composeRevisionManifest: (_seed: unknown, next: unknown) => next,
}));

vi.mock('../builder-workflow.js', () => ({
  workflowFromStructure: () => ({ sections: [] }),
}));

// Link renders outside a router here; the anchor is all these tests need.
vi.mock('react-router-dom', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={String(to)} {...rest}>
      {children}
    </a>
  ),
}));

const { WorkflowStep } = await import('./WorkflowStep.js');

const GRADER: Competency = {
  id: 'c-grader',
  name: 'ATO - Grader',
  code: 'Q50071833',
  holders: 0,
  validForMonths: null,
  gracePeriodDays: null,
  color: 'var(--accent)',
};

/** The slice of BuilderDraftState this step reads, fresh-build shaped. */
function draftOf(over: Record<string, unknown> = {}): BuilderDraftState {
  return {
    fields: [],
    keys: [],
    manifest: { parts: [] },
    structure: { sections: [] },
    parts: [],
    formId: 'form-1',
    versionId: 'v-1',
    title: 'ATO - Grader',
    carriedGeometry: {},
    setVersionIds: vi.fn(),
    setRevisionIdentity: vi.fn(),
    ...over,
  } as unknown as BuilderDraftState;
}

/** A revision draft — what the republish and formGone paths run on. */
function revisionDraftOf(over: Record<string, unknown> = {}): BuilderDraftState {
  return draftOf({
    revisionOfToolId: 'tool-9',
    seededFromVersionId: 'sv-1',
    revisionToolManifest: { parts: [] },
    ...over,
  });
}

const publishButton = () =>
  screen.getByText('Publish assessment tool').closest('button') as HTMLButtonElement;

afterEach(() => {
  vi.clearAllMocks();
  competencies.data = [];
  saveFieldsAsync.mockReset().mockResolvedValue(undefined);
  createToolAsync.mockReset().mockResolvedValue({ id: 'tool-new' });
  createDraftAsync.mockReset().mockResolvedValue({ formId: 'nf-1', versionId: 'nv-1' });
  publishVersionAsync.mockReset().mockResolvedValue(undefined);
  storePublishFormVersion.mockReset().mockResolvedValue(undefined);
  republishAsync.mockReset().mockResolvedValue({ id: 'tool-9' });
});

describe('WorkflowStep award control (U5)', () => {
  it('keeps publish disabled until the one awarded competency is chosen (R1)', async () => {
    competencies.data = [GRADER];
    render(<WorkflowStep draft={draftOf()} />);

    // Everything else is ready — the award is the only thing missing.
    expect(publishButton().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('This assessment awards'), {
      target: { value: 'c-grader' },
    });
    expect(publishButton().disabled).toBe(false);

    await act(async () => {
      fireEvent.click(publishButton());
    });

    // The id travels on the create — the API 400s `invalid_award` without it.
    expect(createToolAsync).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'form-1', awardedCompetencyIds: ['c-grader'] }),
    );
  });

  it('covers AE2: offers creating the matching competency inline, linking it in one step', async () => {
    // No competency matches "ATO - Grader", so the one-step default appears.
    competencies.data = [];
    createCompetencyMutate.mockImplementation((input, opts) =>
      opts?.onSuccess?.({ ...GRADER, id: 'c-new', name: input.name, code: input.code }),
    );
    render(<WorkflowStep draft={draftOf()} />);

    fireEvent.click(screen.getByText('Create competency: ATO - Grader'));

    expect(createCompetencyMutate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ATO - Grader', code: null }),
      expect.anything(),
    );

    // Accepting SELECTED it too — publish is armed with the new competency.
    expect(publishButton().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(publishButton());
    });
    expect(createToolAsync).toHaveBeenCalledWith(
      expect.objectContaining({ awardedCompetencyIds: ['c-new'] }),
    );
  });

  it('does not offer the inline create when an exact match already exists', () => {
    // Creating "ATO - Grader" beside an existing "ATO - Grader" would seed the
    // duplicate-code mess the register's own create form guards against.
    competencies.data = [GRADER];
    render(<WorkflowStep draft={draftOf()} />);

    expect(screen.queryByText('Create competency: ATO - Grader')).toBeNull();
  });

  it('never renders the control on the republish path (R2 stays a guarded edit)', async () => {
    competencies.data = [GRADER];
    render(<WorkflowStep draft={revisionDraftOf()} />);

    // No award control anywhere on a republish…
    expect(screen.queryByLabelText('This assessment awards')).toBeNull();
    // …and no award requirement either: republish is enabled without one.
    expect(publishButton().disabled).toBe(false);

    await act(async () => {
      fireEvent.click(publishButton());
    });

    // The republish updates the EXISTING tool; it never creates one.
    expect(republishAsync).toHaveBeenCalledWith(expect.objectContaining({ toolId: 'tool-9' }));
    expect(createToolAsync).not.toHaveBeenCalled();
  });

  it('renders the control in the deleted-form recovery and sends the id', async () => {
    /*
      The formGone arm calls createTool — it CREATES, whatever the revision
      flag says, so without the control every recovery would 400
      `invalid_award` at the very end of an already-broken afternoon.
    */
    competencies.data = [GRADER];
    saveFieldsAsync.mockRejectedValue(new ApiError(404, { error: 'not_found' }));
    render(<WorkflowStep draft={revisionDraftOf()} />);

    await act(async () => {
      fireEvent.click(publishButton());
    });
    expect(screen.getByText(/no longer exists/)).toBeDefined();

    const recover = screen
      .getByText('Publish as a new tool')
      .closest('button') as HTMLButtonElement;
    // Same rule as the fresh publish: no award, no create.
    expect(recover.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('This assessment awards'), {
      target: { value: 'c-grader' },
    });
    expect(recover.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(recover);
    });

    expect(createToolAsync).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'nf-1', awardedCompetencyIds: ['c-grader'] }),
    );
  });
});
