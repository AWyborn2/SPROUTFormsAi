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

const reopenMutateAsync = vi.fn();
const openMutate = vi.fn();
const hookState: { detail: AssessmentCaseDetail | undefined; role: string } = {
  detail: undefined,
  role: 'assessor',
};
vi.mock('../../lib/data/hooks.js', () => ({
  useAssessmentCase: () => ({ data: hookState.detail, isLoading: false, error: null }),
  useAssessmentTools: () => ({ data: [] }),
  useExportCasePdf: () => ({ mutate: vi.fn(), isPending: false }),
  useOpenAttempt: () => ({ mutate: openMutate, isPending: false }),
  useRecordOutcome: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useReopenPart: () => ({ mutateAsync: reopenMutateAsync, isPending: false }),
  useSession: () => ({
    data: { role: hookState.role, userName: 'Alex Assessor', signature: null },
  }),
  useSetCaseLocation: () => ({ mutate: vi.fn(), isPending: false }),
  useSignOffCase: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
    ...over,
  }) as AssessmentCaseDetail;

const reopenButtons = () => screen.queryAllByRole('button', { name: /Reopen for another attempt/ });

beforeEach(() => {
  hookState.role = 'assessor';
  hookState.detail = detail();
  reopenMutateAsync.mockReset();
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
