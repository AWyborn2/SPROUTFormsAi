// @vitest-environment jsdom
/**
 * Reopening a passed part from the case screen.
 *
 * A satisfactory part used to be the one card with no control on it. These pin
 * the control's contract rather than its look:
 *
 *  - the assessor sees "Reopen for another attempt" on a passed part while the
 *    case is unsigned, and nowhere once it is competent;
 *  - a candidate never sees it — the server would refuse them anyway, and a
 *    control that only produces a 403 is a lie;
 *  - the dialog will not submit without a reason, and sends exactly the part
 *    key and the trimmed reason;
 *  - a stood-down attempt stays on the trail, tagged, with its reason beside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FormField } from '@formai/shared';
import type { AssessmentCaseDetail, CaseAttemptView } from '../../lib/data/assessments.js';

const navigate = vi.fn();
const toastSpy = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useParams: () => ({ id: 'case-1' }),
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('@formai/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@formai/ui')>()),
  useToast: () => ({ toast: toastSpy }),
  // The sign-off pad draws on a canvas jsdom does not have; it is never opened here.
  SignaturePad: () => null,
}));

// The real renderers drag in dictation and canvas; the dialog's contract is
// that the sign-off fields render and their values travel, so the stub
// exposes exactly that.
vi.mock('../fields/FieldRenderer.js', () => ({
  FieldInput: ({
    field,
    value,
    onChange,
  }: {
    field: FormField;
    value: unknown;
    onChange: (v: unknown) => void;
  }) => (
    <input
      data-testid={`field-${field.id}`}
      aria-label={field.label}
      value={value === null || value === undefined ? '' : String(value)}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

const SIG = 'data:image/png;base64,iVBORw0KGgo=';
const reopenMutateAsync = vi.fn();
const signOffMutateAsync = vi.fn();
const openMutate = vi.fn();
const hookState: { detail: AssessmentCaseDetail | undefined; role: string; signature: string | null } = {
  detail: undefined,
  role: 'assessor',
  signature: null,
};
vi.mock('../../lib/data/hooks.js', () => ({
  useAssessmentCase: () => ({ data: hookState.detail, isLoading: false, error: null }),
  useAssessmentTools: () => ({ data: [] }),
  useExportCasePdf: () => ({ mutate: vi.fn(), isPending: false }),
  useOpenAttempt: () => ({ mutate: openMutate, isPending: false }),
  useRecordOutcome: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useReopenPart: () => ({ mutateAsync: reopenMutateAsync, isPending: false }),
  useSession: () => ({
    data: { role: hookState.role, userName: 'Alex Assessor', signature: hookState.signature },
  }),
  useSetCaseLocation: () => ({ mutate: vi.fn(), isPending: false }),
  useSignOffCase: () => ({ mutateAsync: signOffMutateAsync, isPending: false }),
}));

const { AssessmentCaseScreen } = await import('./AssessmentCaseScreen.js');

const attempt = (
  over: Partial<CaseAttemptView> & { id: string; partKey: string },
): CaseAttemptView => ({
  attemptNumber: 1,
  outcome: 'satisfactory',
  submittedAt: '2026-09-01T00:00:00Z',
  disposition: null,
  dispositionReason: null,
  templateVersionId: 'ver-1',
  signedAt: '2026-09-01T00:00:00Z',
  markerKind: 'person',
  markingEligibilityWarnings: [],
  supersededAt: null,
  supersededReason: null,
  ...over,
});

/** Theory and practical both passed — the case is waiting for a signature. */
const detail = (over: Partial<AssessmentCaseDetail> = {}): AssessmentCaseDetail =>
  ({
    id: 'case-1',
    toolId: 'tool-1',
    toolName: 'Authorised to Operate Scraper',
    candidateUserId: 'cand-1',
    candidateName: 'Casey Candidate',
    assessorUserId: 'ass-1',
    pathway: 'experienced',
    locationId: null,
    locationName: null,
    state: 'awaiting_sign_off',
    currentVersionId: 'ver-1',
    prerequisiteWarnings: [],
    appealOfCaseId: null,
    course: null,
    parts: [
      {
        key: 'p1',
        label: 'PART 1 - THEORY',
        kind: 'theory',
        ordinal: 1,
        minimumHours: null,
        durationUnit: null,
        state: 'satisfactory',
        attempts: 1,
        latestOutcome: 'satisfactory',
        selfMarking: true,
      },
      {
        key: 'p2',
        label: 'PART 2 - PRACTICAL',
        kind: 'practical',
        ordinal: 2,
        minimumHours: null,
        durationUnit: null,
        state: 'satisfactory',
        attempts: 1,
        latestOutcome: 'satisfactory',
        selfMarking: false,
      },
    ],
    attempts: [
      attempt({ id: 'att-1', partKey: 'p1', markerKind: 'automatic' }),
      attempt({ id: 'att-2', partKey: 'p2' }),
    ],
    signOffFields: [],
    signOffValues: {},
    ...over,
  }) as AssessmentCaseDetail;

const reopenButtons = () => screen.queryAllByRole('button', { name: /Reopen for another attempt/ });

beforeEach(() => {
  hookState.role = 'assessor';
  hookState.signature = null;
  hookState.detail = detail();
  reopenMutateAsync.mockReset();
  signOffMutateAsync.mockReset();
  toastSpy.mockReset();
});
afterEach(cleanup);

describe('reopening a passed part', () => {
  it('offers the assessor a reopen control on every passed part while the case is unsigned', () => {
    render(<AssessmentCaseScreen />);
    expect(reopenButtons()).toHaveLength(2);
  });

  it('shows nothing to a candidate', () => {
    hookState.role = 'candidate';
    render(<AssessmentCaseScreen />);
    expect(reopenButtons()).toHaveLength(0);
  });

  it('withdraws the control once the case is signed off', () => {
    hookState.detail = detail({ state: 'competent' });
    render(<AssessmentCaseScreen />);
    expect(reopenButtons()).toHaveLength(0);
  });

  it('demands a reason, then sends the part key and the trimmed reason', async () => {
    reopenMutateAsync.mockResolvedValue({
      partKey: 'p2',
      supersededAttemptIds: ['att-2'],
      partState: 'open',
      state: 'open',
    });
    render(<AssessmentCaseScreen />);

    fireEvent.click(reopenButtons()[1]!);
    const dialog = screen.getByRole('dialog', { name: 'Reopen part' });
    expect(dialog.textContent).toContain('Reopen PART 2 - PRACTICAL');

    // Empty reason: refused locally, nothing sent.
    fireEvent.click(screen.getByRole('button', { name: 'Reopen part' }));
    expect(reopenMutateAsync).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain('Say why this part is being reopened');

    fireEvent.change(screen.getByLabelText('Why is this part being reopened?'), {
      target: { value: '  Marked against the wrong candidate  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reopen part' }));

    await waitFor(() =>
      expect(reopenMutateAsync).toHaveBeenCalledWith({
        partKey: 'p2',
        reason: 'Marked against the wrong candidate',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Reopen part' })).toBeNull());
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'success',
        message: expect.stringContaining('PART 2 - PRACTICAL reopened'),
      }),
    );
  });

  it('keeps a stood-down attempt on the trail, tagged, with its reason — and offers a fresh attempt', () => {
    hookState.detail = detail({
      state: 'open',
      parts: [
        {
          key: 'p1',
          label: 'PART 1 - THEORY',
          kind: 'theory',
          ordinal: 1,
          minimumHours: null,
          durationUnit: null,
          state: 'satisfactory',
          attempts: 1,
          latestOutcome: 'satisfactory',
          selfMarking: true,
        },
        {
          key: 'p2',
          label: 'PART 2 - PRACTICAL',
          kind: 'practical',
          ordinal: 2,
          minimumHours: null,
          durationUnit: null,
          state: 'open',
          attempts: 0,
          latestOutcome: null,
          selfMarking: false,
        },
      ],
      attempts: [
        attempt({ id: 'att-1', partKey: 'p1', markerKind: 'automatic' }),
        attempt({
          id: 'att-2',
          partKey: 'p2',
          supersededAt: '2026-09-09T00:00:00Z',
          supersededReason: 'Re-demonstration required after the incident',
        }),
      ],
    });
    render(<AssessmentCaseScreen />);

    // The passing attempt is still there and still readable — both parts have an
    // "Attempt 1", so the stood-down one is picked by where it links.
    const link = screen
      .getAllByRole('link', { name: 'Attempt 1' })
      .find((l) => l.getAttribute('href')?.includes('/attempts/att-2'));
    expect(link).toBeTruthy();
    const trail = link!.closest('li')!.textContent ?? '';
    expect(trail).toContain('satisfactory');
    expect(trail).toContain('superseded');
    expect(trail).toContain('reopened: Re-demonstration required after the incident');

    // ...but it is not the record: the part is open, so the retry control is back
    // and the reopen control is gone from it.
    expect(screen.getByRole('button', { name: /Start another attempt/ })).toBeTruthy();
    expect(reopenButtons()).toHaveLength(1);
  });
});


/**
 * The assessor's feedback and declaration are typed IN the sign-off dialog —
 * they belong to no part — and shown read-only once the case is signed.
 */
describe('signing off with the typed block', () => {
  const FEEDBACK: FormField = {
    id: 'feedback',
    type: 'textarea',
    label: "Assessor's feedback",
    required: true,
    source: 'imported',
  };

  it('renders the tool’s sign-off fields, refuses an empty required box, then sends the values', async () => {
    hookState.signature = SIG;
    hookState.detail = detail({ signOffFields: [FEEDBACK] });
    signOffMutateAsync.mockResolvedValue({ state: 'competent', granted: [], warnings: [] });
    render(<AssessmentCaseScreen />);

    fireEvent.click(screen.getByRole('button', { name: /Sign off and certify/ }));
    const dialog = screen.getByRole('dialog', { name: 'Sign off and certify' });
    expect(screen.getByRole('group', { name: "Assessor's feedback and declaration" })).toBeTruthy();

    // Name and signature are prefilled from the session; the feedback box is not.
    fireEvent.click(screen.getByRole('button', { name: 'Sign off' }));
    expect(signOffMutateAsync).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain('Fill "Assessor\'s feedback" before signing off.');

    fireEvent.change(screen.getByTestId('field-feedback'), { target: { value: 'Confident and safe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign off' }));

    await waitFor(() =>
      expect(signOffMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ values: { feedback: 'Confident and safe' } }),
      ),
    );
  });

  it('sends no values for a tool that has no sign-off fields', async () => {
    hookState.signature = SIG;
    signOffMutateAsync.mockResolvedValue({ state: 'competent', granted: [], warnings: [] });
    render(<AssessmentCaseScreen />);

    fireEvent.click(screen.getByRole('button', { name: /Sign off and certify/ }));
    expect(screen.queryByRole('group', { name: "Assessor's feedback and declaration" })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign off' }));

    await waitFor(() => expect(signOffMutateAsync).toHaveBeenCalled());
    expect(signOffMutateAsync.mock.calls[0]![0]).not.toHaveProperty('values');
  });

  it('shows what was written once the case is signed', () => {
    hookState.detail = detail({
      state: 'competent',
      signOffFields: [FEEDBACK],
      signOffValues: { feedback: 'Confident and safe' },
    });
    render(<AssessmentCaseScreen />);

    const summary = screen.getByRole('region', { name: "Assessor's sign-off" });
    expect(summary.textContent).toContain("Assessor's feedback");
    expect(summary.textContent).toContain('Confident and safe');
  });
});
