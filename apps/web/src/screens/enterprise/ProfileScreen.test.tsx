// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider } from '@formai/ui';
import { PROFILE_FIELDS } from '@formai/shared';
import type {
  HeldCompetencyRow,
  MemberProfile,
  ProfileAccess,
  ProfileResponse,
  ProfileSeedResponse,
  RecommendedCompetencies,
} from '../../lib/data/types.js';

/*
  The screen is driven entirely by what the API says this reader may do, so the
  hooks are the seam. Mocking them lets each case state one configuration and
  assert what it renders — which is the whole point of resolving access per
  SECTION rather than as one grant (R44).
*/
const state: {
  profile: { data: ProfileResponse | undefined; isLoading: boolean; isError: boolean; error?: unknown };
  held: HeldCompetencyRow[];
  saved: Array<{ membershipId: string; values: Record<string, string> }>;
  seed: ProfileSeedResponse | undefined;
  role: string;
  signature: string | null;
  hasPassword: boolean;
  signatureSaves: Array<{ signature: string | null; password?: string }>;
  saveError: unknown;
  cases: Array<{ id: string; toolName: string; state: string; createdAt: string }>;
  /** The candidate's own recommended read (U7). Undefined keeps the card absent. */
  recommended: RecommendedCompetencies | undefined;
} = {
  profile: { data: undefined, isLoading: false, isError: false },
  held: [],
  saved: [],
  seed: undefined,
  role: 'admin',
  signature: null as string | null,
  hasPassword: true,
  cases: [],
  recommended: undefined,
  signatureSaves: [] as Array<{ signature: string | null; password?: string }>,
  saveError: undefined as unknown,
};
const requestTraining = vi.fn();
// Renewing invokes onSuccess so the control resets and toasts, the same shape
// useSaveProfile's mock takes.
const renewMutate = vi.fn((_input: unknown, opts?: { onSuccess?: () => void }) => {
  opts?.onSuccess?.();
});

/*
  No route params and no query string by default, so the screen takes its
  membership from the prop and seeds nothing. The seeded-create cases set
  `searchParams` and get the U40 entry point.
*/
let searchParams = new URLSearchParams();
vi.mock('react-router-dom', () => ({
  useParams: () => ({}),
  useSearchParams: () => [searchParams, vi.fn()] as const,
  useNavigate: () => vi.fn(),
}));

vi.mock('../../lib/data/hooks.js', () => ({
  useProfile: () => state.profile,
  useMyProfileMembership: () => ({ data: { membershipId: 'm-1' }, isLoading: false }),
  useSession: () => ({
    data: { role: state.role, signature: state.signature, hasPassword: state.hasPassword },
  }),
  useSaveSignature: () => ({
    mutate: (
      input: { signature: string | null; password?: string },
      opts?: { onSuccess?: () => void; onError?: (e: unknown) => void },
    ) => {
      state.signatureSaves.push(input);
      if (state.saveError) opts?.onError?.(state.saveError);
      else opts?.onSuccess?.();
    },
    isPending: false,
  }),
  useAssessmentCases: () => ({ data: state.cases }),
  useHeldCompetencies: () => ({ data: state.held }),
  useMemberPlacement: () => ({
    data: { locationIds: ['loc-1'], departmentIds: ['dep-1'], roleIds: ['role-1', 'role-2'] },
  }),
  useTaxonomy: () => ({
    data: {
      locations: [{ id: 'loc-1', name: 'Boddington', status: 'active' }],
      departments: [
        {
          id: 'dep-1',
          name: 'Mining',
          allowsMultipleRoles: true,
          status: 'active',
          roles: [
            { id: 'role-1', departmentId: 'dep-1', name: 'Dozer Operator', status: 'active' },
            // Retired but still held — exactly what a retirement review is.
            { id: 'role-2', departmentId: 'dep-1', name: 'Old Role', status: 'retired' },
          ],
        },
      ],
      settings: {},
    },
  }),
  useProfileSeed: () => ({ data: state.seed }),
  useMyRecommended: () => ({ data: state.recommended }),
  useRequestTraining: () => ({ mutate: requestTraining, isPending: false }),
  useRenewCompetency: () => ({ mutate: renewMutate, isPending: false }),
  useSaveProfile: () => ({
    mutate: (
      input: { membershipId: string; values: Record<string, string> },
      opts?: { onSuccess?: () => void },
    ) => {
      state.saved.push(input);
      opts?.onSuccess?.();
    },
    isPending: false,
    isError: false,
  }),
  useUploadProfilePhoto: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteProfilePhoto: () => ({ mutate: vi.fn(), isPending: false }),
  useBadgeIcons: () => ({ data: [] }),
  useGamificationStats: () => ({ data: undefined }),
}));

// The recommended card toasts on request outcomes; the provider is app chrome
// these component tests do not mount.
const toast = vi.fn();
vi.mock('@formai/ui', async () => {
  const actual = await vi.importActual<typeof import('@formai/ui')>('@formai/ui');
  return {
    ...actual,
    useToast: () => ({ toast }),
    // The real pad drags in canvas; the card's contract is only what it saves,
    // so the stub exposes a deterministic "draw" that fires onChange.
    SignaturePad: ({ onChange }: { onChange: (v: string) => void }) => (
      <button data-testid="pad-draw" onClick={() => onChange('data:image/png;base64,iVBORw0KDRAWN=')} />
    ),
  };
});

const { ProfileScreen } = await import('./ProfileScreen.js');

const PROFILE: MemberProfile = {
  membershipId: 'm-1',
  firstName: 'Jane',
  middleName: null,
  lastName: 'Smith',
  displayName: 'Jane Smith',
  identifier: 'E100',
  gender: 'Female',
  ethnicity: 'Aboriginal',
  indigenousStatus: 'indigenous',
  dateOfBirth: '1990-04-17',
  addressStreet: '12 Mill Road',
  suburb: 'Boddington',
  postcode: '6390',
  mobile: '0400 000 000',
  emergencyContactName: 'Chris Smith',
  emergencyContactPhone: '0400 111 111',
  starterType: 'New starter',
  employeeNumber: 'E100',
  swipeCardNumber: null,
  inductionDate: null,
  email: 'jane@x.io',
  emailUnreachableAt: null,
  photoUrl: null,
};

const READ_ONLY: ProfileAccess = {
  canViewDocuments: true,
  canViewCompetencies: true,
  canApprove: true,
  editableFields: [],
  isSubject: false,
};

function show(access: Partial<ProfileAccess> = {}, profile: Partial<MemberProfile> = {}) {
  state.profile = {
    data: {
      profile: { ...PROFILE, ...profile },
      userId: 'u-1',
      access: { ...READ_ONLY, ...access },
    },
    isLoading: false,
    isError: false,
  };
  return render(<ToastProvider><ProfileScreen membershipId="m-1" /></ToastProvider>);
}

afterEach(() => {
  vi.clearAllMocks();
  state.profile = { data: undefined, isLoading: false, isError: false };
  state.held = [];
  state.saved = [];
  state.seed = undefined;
  state.role = 'admin';
  state.cases = [];
  state.recommended = undefined;
  state.signature = null;
  state.hasPassword = true;
  state.signatureSaves = [];
  state.saveError = undefined;
  searchParams = new URLSearchParams();
});

describe('ProfileScreen — the record (U38)', () => {
  it('renders from the SHARED inventory, so a field added there appears with no change here', () => {
    /*
      The property that matters is not that these particular labels render — it
      is that the screen holds no second copy of the field list. A hand-written
      list here would let the required, sensitive and derived marks drift from
      the inventory the API validates against.
    */
    show();
    const rendered = PROFILE_FIELDS.filter(
      (f) => f.storedOn !== 'membership' && f.key !== 'profilePictureKey',
    );
    for (const f of rendered) {
      expect(screen.getAllByText(f.label).length).toBeGreaterThan(0);
    }
  });

  it('shows Indigenous status derived and offers no way to enter it (R15)', () => {
    show();
    expect(screen.getByText('Indigenous')).toBeDefined();
    // Marked derived on the read...
    expect(screen.getAllByText('derived').length).toBeGreaterThan(0);
    // ...and absent from the form, because nobody enters it.
    const spec = PROFILE_FIELDS.find((f) => f.key === 'indigenousStatus')!;
    expect(spec.editableBy).toEqual([]);
  });

  it('marks a RETIRED Role in place rather than hiding it (R109)', () => {
    // Hiding it would misreport the record: a retired value somebody still holds
    // is exactly what an Admin is asked to review.
    show();
    expect(screen.getByText(/Old Role · retired/)).toBeDefined();
    expect(screen.getByText('Dozer Operator')).toBeDefined();
  });

  it('shows the unreachable mark WITH the address still on the record (R16)', () => {
    show({}, { emailUnreachableAt: '2026-08-01T00:00:00Z' });
    expect(screen.getByText(/marked as reaching nobody/)).toBeDefined();
    // The address did not go anywhere — R16 requires a profile to carry one, not
    // a working one.
    expect(screen.getByText('12 Mill Road')).toBeDefined();
  });
});

describe('ProfileScreen — competencies (R37, R104)', () => {
  it('shows standing and currency as two separate facts', () => {
    state.held = [
      {
        holderId: 'h-dozer',
        competencyId: 'c-dozer',
        name: 'Track Dozer',
        code: null,
        evidenceRef: null,
        licenceClass: null,
        licenceNumber: null,
        status: 'held',
        standing: 'required',
        current: true,
        expiresAt: null,
        note: null,
      },
    ];
    show();
    expect(screen.getByText('required')).toBeDefined();
    expect(screen.getByText('held')).toBeDefined();
    // The NAME renders (badge wall + register), never the raw database id.
    expect(screen.getAllByText('Track Dozer').length).toBeGreaterThan(0);
    expect(screen.queryByText('c-dozer')).toBeNull();
  });

  it('renders each entry’s source scopes as ONE comma-joined line (AE1, R5, U8)', () => {
    /*
      The AE1 stack on the record: a required entry produced by three scopes
      reads "Required — from <a>, <b> and <c>" — commas, "and" before the
      last — and an org-scope entry reads "org-wide", never the org's name.
    */
    state.held = [
      {
        holderId: 'h-site',
        competencyId: 'c-site',
        name: 'Site Induction',
        code: null,
        evidenceRef: null,
        licenceClass: null,
        licenceNumber: null,
        status: 'held',
        standing: 'required',
        sources: [
          { scope: 'location', name: 'Boddington' },
          { scope: 'department', name: 'Operations' },
          { scope: 'role', name: 'Dozer Operator' },
        ],
        current: true,
        expiresAt: null,
        note: null,
      },
      {
        holderId: 'h-org',
        competencyId: 'c-org',
        name: 'First Aid',
        code: null,
        evidenceRef: null,
        licenceClass: null,
        licenceNumber: null,
        status: 'held',
        standing: 'required',
        sources: [{ scope: 'org', name: 'Org One' }],
        current: true,
        expiresAt: null,
        note: null,
      },
    ];
    show();
    expect(
      screen.getByText('Required — from Boddington, Operations and Dozer Operator'),
    ).toBeDefined();
    expect(screen.getByText('Required — org-wide')).toBeDefined();
    expect(screen.queryByText(/Org One/)).toBeNull();
  });

  it('renders NO source line where the API withheld sources (the viewer gate, U8)', () => {
    // A colleague read without `profiles.view_competencies`: the field is
    // absent, and the row must not render a dangling or invented caption.
    state.held = [
      {
        holderId: 'h-dozer',
        competencyId: 'c-dozer',
        name: 'Track Dozer',
        code: null,
        evidenceRef: null,
        licenceClass: null,
        licenceNumber: null,
        status: 'held',
        standing: 'required',
        current: true,
        expiresAt: null,
        note: null,
      },
    ];
    show();
    expect(screen.queryByText(/— from/)).toBeNull();
    expect(screen.queryByText(/org-wide/)).toBeNull();
  });

  it('does not render an expired OPTIONAL competency as a compliance failure (AE43, R102)', () => {
    /*
      Standing is obligation and follows the person's Roles; currency is
      eligibility and follows the competency's own dates. Rendering only the
      second would read a voluntary lapse as a failure, which it is not — so the
      optional mark has to be visible beside the expiry.
    */
    state.held = [
      {
        holderId: 'h-req',
        competencyId: 'c-req',
        name: 'Required Ticket',
        code: null,
        evidenceRef: null,
        licenceClass: null,
        licenceNumber: null,
        status: 'held',
        standing: 'required',
        current: true,
        expiresAt: null,
        note: null,
      },
      {
        holderId: 'h-vol',
        competencyId: 'c-vol',
        name: 'Voluntary Ticket',
        code: null,
        evidenceRef: null,
        licenceClass: null,
        licenceNumber: null,
        status: 'expired',
        standing: 'optional',
        current: false,
        expiresAt: '2025-01-01T00:00:00Z',
        note: null,
      },
    ];
    show();
    expect(screen.getByText('optional')).toBeDefined();
    expect(screen.getByText('expired')).toBeDefined();
    expect(screen.getAllByText('Voluntary Ticket').length).toBeGreaterThan(0);
  });

  /*
    RENEW (task #43): the sign-off dead-end. A lapsed licence blocks
    certification, and until now there was no way to re-date it — the assessor
    was stuck. On an editable record they can now set the new expiry and file the
    renewed evidence from the person's own record.
  */
  const LAPSED_LICENCE: HeldCompetencyRow = {
    holderId: 'h-lic',
    competencyId: 'c-lic',
    name: 'Driver Licence',
    code: null,
    evidenceRef: null,
    licenceClass: 'C',
    licenceNumber: null,
    status: 'expired',
    standing: 'required',
    current: false,
    expiresAt: '2025-01-01T00:00:00Z',
    note: null,
  };

  it('renews a lapsed licence with the end-of-day expiry (task #43)', () => {
    state.role = 'admin';
    state.held = [LAPSED_LICENCE];
    // A non-subject reader who may edit the record — both the re-grant and the
    // evidence attach need that authority.
    show({ editableFields: ['firstName'] });

    // Collapsed until opened.
    fireEvent.click(screen.getByRole('button', { name: /Renew/ }));
    fireEvent.change(screen.getByLabelText('New expiry date'), {
      target: { value: '2031-06-30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Renew' }));

    expect(renewMutate).toHaveBeenCalledTimes(1);
    // End of day, so the licence stays valid THROUGH its printed expiry date.
    expect(renewMutate.mock.calls[0]![0]).toMatchObject({
      expiresAt: '2031-06-30T23:59:59.000Z',
    });
  });

  it('does nothing with neither a new date nor a file — the submit stays disabled', () => {
    state.role = 'admin';
    state.held = [LAPSED_LICENCE];
    show({ editableFields: ['firstName'] });
    fireEvent.click(screen.getByRole('button', { name: /Renew/ }));

    const submit = screen.getByRole('button', { name: 'Renew' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(renewMutate).not.toHaveBeenCalled();
  });

  it('offers no Renew on a read-only record', () => {
    state.role = 'admin';
    state.held = [LAPSED_LICENCE];
    // READ_ONLY has no editable fields — the default access. No affordance.
    show();
    expect(screen.queryByRole('button', { name: /Renew/ })).toBeNull();
  });

  it('offers no Renew to the subject on their own record — that path is a replacement', () => {
    state.role = 'assessor';
    state.held = [LAPSED_LICENCE];
    // Even with fields to edit, the subject may not attach held evidence here.
    show({ isSubject: true, editableFields: ['firstName'] });
    expect(screen.queryByRole('button', { name: /Renew/ })).toBeNull();
  });
});

describe('ProfileScreen — access resolves per section (R44)', () => {
  it('renders documents and no fields where the organisation tightened fields only', () => {
    /*
      The configuration R44 exists to allow. A screen with only two states —
      everything or nothing — would render this as a blank page, which is why
      each section resolves against its own grant.
    */
    show({ canViewDocuments: true, canViewCompetencies: false });
    expect(screen.getByText('Documents')).toBeDefined();
    expect(screen.getByText(/Competencies are not shown/)).toBeDefined();
  });

  it('still reads competencies where the organisation tightened documents only (R41, R55)', () => {
    show({ canViewDocuments: false, canViewCompetencies: true });
    expect(screen.getByText('Competencies')).toBeDefined();
    expect(screen.getByText(/Documents are not shown/)).toBeDefined();
  });

  it('names a withheld section rather than omitting it, and does not leak its size', () => {
    // Somebody who cannot see the documents should know there IS a documents
    // section; a count would leak the very thing the setting withholds.
    show({ canViewDocuments: false, canViewCompetencies: false });
    const withheld = screen.getByText(/Documents are not shown/);
    expect(withheld.textContent).not.toMatch(/\d/);
  });
});

describe('ProfileScreen — the Admin entry form (F1)', () => {
  /*
    Exactly what the API sends: `storedOn === 'profile'` and Admin-editable.
    Email lives on `users` and the placement fields on the membership, so
    neither is writable through this route — and a fixture that offered them
    here would test a form the product never renders.
  */
  const ADMIN_FIELDS = PROFILE_FIELDS.filter(
    (f) => f.storedOn === 'profile' && f.editableBy.includes('admin'),
  ).map((f) => f.key);

  it('blocks the save and NAMES the missing required field (R12)', () => {
    show({ editableFields: ADMIN_FIELDS });
    fireEvent.click(screen.getByText('Edit record'));

    fireEvent.change(screen.getByLabelText('First name'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));

    expect(screen.getByText('First name is required.')).toBeDefined();
    expect(state.saved).toHaveLength(0);
  });

  it('offers the decline values on the closed fields, from the inventory (R13, R14)', () => {
    show({ editableFields: ADMIN_FIELDS });
    fireEvent.click(screen.getByText('Edit record'));

    const gender = screen.getByLabelText('Gender') as HTMLSelectElement;
    const options = [...gender.options].map((o) => o.value);
    const spec = PROFILE_FIELDS.find((f) => f.key === 'gender')!;
    // Every value the inventory carries, and nothing invented here.
    for (const o of spec.options!) expect(options).toContain(o);
  });

  it('saves the changed fields (R2)', () => {
    show({ editableFields: ADMIN_FIELDS });
    fireEvent.click(screen.getByText('Edit record'));
    fireEvent.change(screen.getByLabelText('Mobile'), { target: { value: '0411 222 333' } });
    fireEvent.click(screen.getByText('Save'));

    expect(state.saved).toHaveLength(1);
    expect(state.saved[0]!.values.mobile).toBe('0411 222 333');
  });

  it('accepts a record with no middle name, numbers or induction date (AE49, R12)', () => {
    // Those are OPTIONAL in the inventory, so a blank one must not block a save.
    show({ editableFields: ADMIN_FIELDS }, { middleName: null, employeeNumber: null, inductionDate: null });
    fireEvent.click(screen.getByText('Edit record'));
    fireEvent.click(screen.getByText('Save'));

    expect(screen.queryByText(/is required\./)).toBeNull();
    expect(state.saved).toHaveLength(1);
  });
});

describe('ProfileScreen — the candidate on their own record (R49, R51)', () => {
  const CANDIDATE_FIELDS = PROFILE_FIELDS.filter((f) => f.editableBy.includes('candidate')).map((f) => f.key);

  it('reads every field including the sensitive ones (AE2, AE51)', () => {
    show({ isSubject: true, editableFields: CANDIDATE_FIELDS });
    // The date of birth is marked sensitive in the inventory and is still here:
    // R8's mark drives export redaction, NOT who reads the record (KTD26).
    expect(screen.getByText('1990-04-17')).toBeDefined();
    expect(screen.getByText('Aboriginal')).toBeDefined();
  });

  it('offers their address, mobile and emergency contact, and nothing else (AE3)', () => {
    show({ isSubject: true, editableFields: CANDIDATE_FIELDS });
    fireEvent.click(screen.getByText('Edit record'));

    // Theirs.
    expect(screen.getByLabelText('Mobile')).toBeDefined();
    expect(screen.getByLabelText('Street address')).toBeDefined();
    expect(screen.getByLabelText('Emergency contact name')).toBeDefined();
    // The organisation's — a candidate who could set their own employee number
    // could impersonate a colleague on a swipe reader (R53).
    expect(screen.queryByLabelText('Employee number')).toBeNull();
    expect(screen.queryByLabelText('Date of birth')).toBeNull();
    expect(screen.queryByLabelText('Gender')).toBeNull();
  });

  it('offers no edit at all to a reader with no editable fields', () => {
    show({ editableFields: [] });
    expect(screen.queryByText('Edit record')).toBeNull();
  });
});

describe('ProfileScreen — seeded from an induction submission (U40)', () => {
  const ADMIN_FIELDS = PROFILE_FIELDS.filter(
    (f) => f.storedOn === 'profile' && f.editableBy.includes('admin'),
  ).map((f) => f.key);

  const seedResponse = (over: Partial<ProfileSeedResponse> = {}): ProfileSeedResponse => ({
    submissionId: 'sub-1',
    disposition: 'create',
    seed: {
      fields: { firstName: 'Marlee', lastName: 'Okonkwo', mobile: '0412 345 678' },
      department: 'Operations',
      roles: ['Dozer Operator'],
      email: 'marlee@example.com',
      indigenousStatus: 'indigenous',
      unmatched: [],
    },
    membershipId: null,
    ...over,
  });

  function seeded(response: ProfileSeedResponse, profile: Partial<MemberProfile> = {}) {
    state.seed = response;
    searchParams = new URLSearchParams({ seedFrom: 'sub-1' });
    return show({ editableFields: ADMIN_FIELDS }, profile);
  }

  it('prefills the form from the submission rather than making an Admin retype it', () => {
    seeded(seedResponse(), { firstName: null, lastName: null, mobile: null });
    fireEvent.click(screen.getByText('Edit record'));
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Marlee');
    expect((screen.getByLabelText('Mobile') as HTMLInputElement).value).toBe('0412 345 678');
  });

  it('does NOT overwrite a value the record already carries', () => {
    /*
      A submission is older than any correction an Admin has since made to the
      record. Letting it overwrite would silently undo their work — so a seeded
      value fills a gap and never replaces an answer.
    */
    seeded(seedResponse(), { firstName: 'Jane' });
    fireEvent.click(screen.getByText('Edit record'));
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Jane');
  });

  it('says what did not come across', () => {
    seeded(seedResponse(), { firstName: null });
    expect(screen.getByText(/No document came across/)).toBeDefined();
    expect(screen.getByText(/employee and swipe card numbers are yours to enter/)).toBeDefined();
  });

  it('SEEDS NOTHING for somebody who already holds a record (R89)', () => {
    // Two records for one person is unrecoverable without a merge, which is why
    // the repeat stops here rather than prefilling a second one.
    seeded(seedResponse({ disposition: 'existing_record', membershipId: 'm-9' }), {
      firstName: null,
      lastName: null,
    });
    expect(screen.getByText(/already has a record/)).toBeDefined();

    fireEvent.click(screen.getByText('Edit record'));
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('');
  });

  it('asks about reactivation for a deactivated person rather than doing it (R90)', () => {
    // Reactivation takes a seat and may buy a block (R78, R86).
    seeded(seedResponse({ disposition: 'deactivated', membershipId: 'm-9' }));
    expect(screen.getByText(/Reactivate them rather than creating a second record/)).toBeDefined();
  });

  it('reports an answer the current lists no longer offer as a suggestion (R94)', () => {
    seeded(
      seedResponse({
        seed: { ...seedResponse().seed, unmatched: [{ key: 'department', value: 'Smelting' }] },
      }),
    );
    expect(screen.getByText(/These answers are no longer offered/)).toBeDefined();
    expect(screen.getByText('department: Smelting')).toBeDefined();
    expect(screen.getByText('Pick a current value for each.')).toBeDefined();
  });

  it('shows no seed banner at all without the query parameter', () => {
    show({ editableFields: ADMIN_FIELDS });
    expect(screen.queryByText(/Prefilled from an induction submission/)).toBeNull();
  });
});

describe('ProfileScreen — the candidate-focused own view', () => {
  it('shows a candidate their assessments due and hides the org bookkeeping', () => {
    state.role = 'candidate';
    state.cases = [
      { id: 'case-1', toolName: 'Dozer Assessment', state: 'open', createdAt: '2026-08-01T00:00:00Z' },
      // Terminal — finished, so not "due".
      { id: 'case-2', toolName: 'Old Assessment', state: 'competent', createdAt: '2026-05-01T00:00:00Z' },
    ];
    show({ isSubject: true });

    expect(screen.getByText('Assessments due')).toBeDefined();
    expect(screen.getByText('Dozer Assessment')).toBeDefined();
    expect(screen.queryByText('Old Assessment')).toBeNull();
    // Placement and documents are the organisation's bookkeeping, not theirs.
    expect(screen.queryByText('Placement')).toBeNull();
    expect(screen.queryByText('Documents')).toBeNull();
  });

  it('tells an up-to-date candidate so instead of rendering an empty table', () => {
    state.role = 'candidate';
    show({ isSubject: true });
    expect(screen.getByText(/Nothing due/)).toBeDefined();
  });

  it('shows an unheld recommendation with NO start action while self-start is OFF (AE5, R12)', () => {
    state.role = 'candidate';
    state.recommended = {
      selfStartEnabled: false,
      items: [
        { competencyId: 'c1', name: 'First Aid', code: 'HLTAID011', held: false, requestableToolId: 't1' },
      ],
    };
    show({ isSubject: true });
    expect(screen.getByText('Recommended for your roles')).toBeDefined();
    expect(screen.getByText('First Aid')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Request this training' })).toBeNull();
  });

  it('exposes the request action when the org flips self-start ON, posting { toolId } (AE5, R14)', () => {
    state.role = 'candidate';
    state.recommended = {
      selfStartEnabled: true,
      items: [
        { competencyId: 'c1', name: 'First Aid', code: 'HLTAID011', held: false, requestableToolId: 't1' },
      ],
    };
    show({ isSubject: true });
    fireEvent.click(screen.getByRole('button', { name: 'Request this training' }));
    // The existing voluntary body — the request lands in the training-request
    // queue, never enrols directly (R94, R96).
    expect(requestTraining).toHaveBeenCalledWith('t1', expect.anything());
  });

  it('captions a recommendation with its recommending scope — "Recommended — from <Location>" (AE5, U8)', () => {
    state.role = 'candidate';
    state.recommended = {
      selfStartEnabled: false,
      items: [
        {
          competencyId: 'c1',
          name: 'First Aid',
          code: 'HLTAID011',
          held: false,
          requestableToolId: 't1',
          sources: [{ scope: 'location', name: 'Boddington' }],
        },
      ],
    };
    show({ isSubject: true });
    expect(screen.getByText('Recommended — from Boddington')).toBeDefined();
  });

  it('offers no request for an evidence-only recommendation, toggle regardless (R7)', () => {
    state.role = 'candidate';
    state.recommended = {
      selfStartEnabled: true,
      items: [
        { competencyId: 'c2', name: 'Driver Licence', code: null, held: false, requestableToolId: null },
      ],
    };
    show({ isSubject: true });
    expect(screen.getByText('Driver Licence')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Request this training' })).toBeNull();
  });

  it('renders no recommended card on someone ELSE’s record — it is a self surface (R12)', () => {
    state.role = 'admin';
    state.recommended = {
      selfStartEnabled: true,
      items: [
        { competencyId: 'c1', name: 'First Aid', code: null, held: false, requestableToolId: 't1' },
      ],
    };
    show();
    expect(screen.queryByText('Recommended for your roles')).toBeNull();
  });

  it('keeps the full record — placement and documents — for a non-candidate reader', () => {
    state.role = 'admin';
    show();
    expect(screen.getByText('Placement')).toBeDefined();
    expect(screen.getByText('Documents')).toBeDefined();
    expect(screen.queryByText('Assessments due')).toBeNull();
  });
});

describe('ProfileScreen — My signature (own record only)', () => {
  it('renders the card on the caller’s own record', () => {
    show({ isSubject: true });
    expect(screen.getByText('My signature')).toBeDefined();
  });

  it('never renders on a member record an admin is viewing', () => {
    show({ isSubject: false });
    expect(screen.queryByText('My signature')).toBeNull();
  });

  it('removing a saved mark takes the password before it clears (disarm defence)', () => {
    state.signature = 'data:image/png;base64,iVBORw0KSAVED=';
    show({ isSubject: true });
    expect(screen.getByAltText('Your saved signature')).toBeDefined();
    fireEvent.click(screen.getByText('Remove'));
    // Does NOT clear yet — a password panel appears instead.
    expect(state.signatureSaves).toEqual([]);
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByText('Remove signature'));
    expect(state.signatureSaves).toEqual([{ signature: null, password: 'pw' }]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }));
  });

  it('replacing a saved mark sends the drawn mark WITH the password', () => {
    state.signature = 'data:image/png;base64,iVBORw0KSAVED=';
    show({ isSubject: true });
    fireEvent.click(screen.getByText('Replace'));
    fireEvent.click(screen.getByTestId('pad-draw'));
    // Save stays disabled until the password is entered.
    const save = screen.getByText('Save signature').closest('button')!;
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'pw' } });
    expect(save.hasAttribute('disabled')).toBe(false);
    fireEvent.click(save);
    expect(state.signatureSaves).toEqual([
      { signature: 'data:image/png;base64,iVBORw0KDRAWN=', password: 'pw' },
    ]);
  });

  it('a no-password account can remove its mark without a password prompt (R6)', () => {
    state.signature = 'data:image/png;base64,iVBORw0KSAVED=';
    state.hasPassword = false;
    show({ isSubject: true });
    fireEvent.click(screen.getByText('Remove'));
    expect(state.signatureSaves).toEqual([{ signature: null }]);
  });

  it('with nothing saved, offers the pad and disables Save until something is drawn', () => {
    show({ isSubject: true });
    const save = screen.getByText('Save signature').closest('button')!;
    expect(save.hasAttribute('disabled')).toBe(true);
  });

  it('first save (nothing saved yet) sends the drawn mark with no password (AE1)', () => {
    show({ isSubject: true });
    fireEvent.click(screen.getByTestId('pad-draw'));
    const save = screen.getByText('Save signature').closest('button')!;
    expect(save.hasAttribute('disabled')).toBe(false);
    fireEvent.click(save);
    expect(state.signatureSaves).toEqual([{ signature: 'data:image/png;base64,iVBORw0KDRAWN=' }]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }));
  });

  it('an oversized-save error names the size, not the format', async () => {
    const { ApiError } = await import('../../lib/data/api-client.js');
    state.saveError = new ApiError(400, { error: 'too_large' });
    show({ isSubject: true });
    fireEvent.click(screen.getByTestId('pad-draw'));
    fireEvent.click(screen.getByText('Save signature'));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'danger', message: expect.stringMatching(/too large/i) }),
    );
  });

  it('a wrong-password error on replace names the password, not the format', async () => {
    const { ApiError } = await import('../../lib/data/api-client.js');
    state.signature = 'data:image/png;base64,iVBORw0KSAVED=';
    state.saveError = new ApiError(401, { error: 'invalid_credentials' });
    show({ isSubject: true });
    fireEvent.click(screen.getByText('Replace'));
    fireEvent.click(screen.getByTestId('pad-draw'));
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByText('Save signature'));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'danger', message: expect.stringMatching(/password is not right/i) }),
    );
  });
});
