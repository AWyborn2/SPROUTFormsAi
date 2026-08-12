// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PROFILE_FIELDS } from '@formai/shared';
import type {
  HeldCompetencyRow,
  MemberProfile,
  ProfileAccess,
  ProfileResponse,
  ProfileSeedResponse,
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
  cases: Array<{ id: string; toolName: string; state: string; createdAt: string }>;
} = {
  profile: { data: undefined, isLoading: false, isError: false },
  held: [],
  saved: [],
  seed: undefined,
  role: 'admin',
  cases: [],
};

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
  useSession: () => ({ data: { role: state.role } }),
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
}));

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
  return render(<ProfileScreen membershipId="m-1" />);
}

afterEach(() => {
  vi.clearAllMocks();
  state.profile = { data: undefined, isLoading: false, isError: false };
  state.held = [];
  state.saved = [];
  state.seed = undefined;
  state.role = 'admin';
  state.cases = [];
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
    // The NAME renders, never the row's database id (the id stays an attribute).
    expect(screen.getByText('Track Dozer')).toBeDefined();
    expect(screen.queryByText('c-dozer')).toBeNull();
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
    expect(screen.getByText('Voluntary Ticket')).toBeDefined();
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

  it('keeps the full record — placement and documents — for a non-candidate reader', () => {
    state.role = 'admin';
    show();
    expect(screen.getByText('Placement')).toBeDefined();
    expect(screen.getByText('Documents')).toBeDefined();
    expect(screen.queryByText('Assessments due')).toBeNull();
  });
});
