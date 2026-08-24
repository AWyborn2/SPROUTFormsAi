import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Icon,
  Input,
  SignaturePad,
  useToast,
  type BadgeVariant,
} from '@formai/ui';
import {
  PROFILE_FIELDS,
  isTerminalCaseState,
  profileField,
  type ProfileFieldSpec,
  type Standing,
} from '@formai/shared';
import {
  useAssessmentCases,
  useHeldCompetencies,
  useMemberPlacement,
  useMyProfileMembership,
  useProfile,
  useProfileSeed,
  useRenewCompetency,
  useSaveProfile,
  useSaveSignature,
  useSession,
  useTaxonomy,
} from '../../lib/data/hooks.js';
import { ApiError } from '../../lib/data/api-client.js';
import { CaseStateBadge } from '../statusBadges.js';
import { RecommendedTrainingList } from '../recommended-training.js';
import { sourcesLine } from '../../lib/competency-sources.js';
import type { HeldCompetencyRow, MemberProfile, ProfileAccess } from '../../lib/data/types.js';

/**
 * A member's workforce record (U38).
 *
 * SERVES EVERY MEMBER, not only candidates — an assessor's and an
 * administrator's record is this one. The candidate's own view is this same
 * screen taking the fixed own-record path (R49), which is what keeps their read
 * demonstrably in full rather than a second, thinner surface that could quietly
 * diverge from it.
 *
 * RENDERS FROM THE SHARED INVENTORY rather than a hand-written field list, so a
 * field added there appears here with no second edit and the required, sensitive
 * and derived marks cannot drift between the two.
 *
 * READS RESOLVE PER SECTION (R44). `view` governs the fields, `view_competencies`
 * the competencies and the assessment history, `view_documents` the documents —
 * so an organisation that tightens fields but leaves documents open renders the
 * documents alone. A screen with only two states, everything or nothing, would
 * render that configuration as a blank page.
 */
export function ProfileScreen({ membershipId }: { membershipId?: string }) {
  /*
    The route supplies the membership; the prop overrides it. Omitting both means
    "my own record" — the candidate's fixed path (R49), which is the same screen
    rather than a second, thinner one.
  */
  const params = useParams<{ id: string }>();
  const mine = useMyProfileMembership();
  const session = useSession();
  const targetId = membershipId ?? params.id ?? mine.data?.membershipId;

  const { data, isLoading, isError, error } = useProfile(targetId);
  /*
    U40's entry point: `?seedFrom=<submissionId>` prefills this form from an
    induction submission instead of an Admin typing it again. It reuses THIS
    form rather than introducing a second one — a separate seeded-create screen
    would need its own validation and its own option lists, and would drift.
  */
  const seedFrom = useSearchParams()[0].get('seedFrom') ?? undefined;
  const seed = useProfileSeed(seedFrom);
  const [editing, setEditing] = useState(false);

  if (isLoading || (!membershipId && mine.isLoading)) {
    return <Frame><div className="p-6 text-sm text-text-tertiary">Loading…</div></Frame>;
  }

  if (isError) {
    /*
      A 403 and a 404 read the same here on purpose. The API answers not-found
      for a membership in another organisation so a probe cannot tell an existing
      record elsewhere from one that is absent, and repeating that distinction on
      screen would give it back.
    */
    const forbidden = /403/.test(String(error ?? ''));
    return (
      <Frame>
        <Card className="p-6 text-sm text-text-tertiary">
          {forbidden
            ? 'You do not have access to this record.'
            : 'That record could not be found.'}
        </Card>
      </Frame>
    );
  }

  if (!data) return <Frame><div className="p-6 text-sm text-text-tertiary">Nothing to show.</div></Frame>;

  const { profile, access, userId } = data;
  const canEdit = access.editableFields.length > 0;
  /*
    Who may RENEW a held competency here — re-date a lapsed licence and file the
    new evidence. It re-grants, so it takes the register's own authoring tier
    (owner/admin/assessor), AND the evidence attach is an edit of this record, so
    it needs edit access on a record that is not the caller's own. A candidate
    fixing their own licence goes the replacement route, which waits for
    approval; this is the assessor unblocking a sign-off.
  */
  const canRenewCompetencies =
    canEdit &&
    !access.isSubject &&
    ['owner', 'admin', 'assessor'].includes(session.data?.role ?? '');
  /*
    A candidate on their OWN record gets the focused layout: their details, the
    competencies they hold, and the assessments waiting on them. The placement
    and documents machinery is the organisation's bookkeeping — rendering it to
    the person it is about only buried the three answers they came for.
  */
  const candidateSelf = access.isSubject && session.data?.role === 'candidate';

  return (
    <Frame>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <Avatar name={profile.displayName || '?'} size="lg" />
          <div>
            <h2 className="font-heading text-xl font-bold">
              {profile.displayName || 'Member record'}
            </h2>
            <p className="mt-0.5 flex items-center gap-2 text-sm text-text-tertiary">
              {profile.identifier && (
                <span className="font-mono text-[12px]">{profile.identifier}</span>
              )}
              <span>
                {candidateSelf
                  ? 'Your profile — your details, competencies and assessments.'
                  : access.isSubject
                    ? 'Your own workforce record.'
                    : 'The organisation’s workforce record for this person.'}
              </span>
            </p>
          </div>
        </div>
        {canEdit && !editing && (
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Edit record
          </Button>
        )}
      </div>

      {profile.emailUnreachableAt && (
        <Card className="flex items-start gap-2 border-warning-border bg-warning-surface p-4">
          <Icon name="mail-x" size={16} className="mt-0.5 text-warning-text" />
          <p className="text-[12.5px] text-warning-text">
            This address has been marked as reaching nobody. The address is still on the record —
            expiry notices need somebody to pass on in person.
          </p>
        </Card>
      )}

      {seedFrom && <SeedBanner submissionId={seedFrom} />}

      {candidateSelf && <MyAssessmentsCard />}

      {/*
        OWN RECORD ONLY. The signature is a users-level value — one mark across
        every organisation the person works for — shown here because "my
        record" is where a person manages what is theirs. An admin viewing a
        MEMBER record must not see or edit it: the profile permission matrix
        governs org-scoped profile fields and is the wrong gate for a
        product-wide personal mark.
      */}
      {access.isSubject && <MySignatureCard />}

      {access.canViewCompetencies ? (
        <CompetenciesCard
          userId={userId}
          ownRecord={access.isSubject}
          canRenew={canRenewCompetencies}
        />
      ) : (
        <WithheldCard title="Competencies" />
      )}

      {/* Recommended-but-unheld, on the candidate's OWN record only (U7, R12):
          the held tier already shows through the standing badge above. */}
      {candidateSelf && <RecommendedCard />}

      {editing && targetId ? (
        <ProfileForm
          membershipId={targetId}
          profile={profile}
          access={access}
          seeded={seed.data?.disposition === 'create' ? seed.data.seed.fields : undefined}
          onDone={() => setEditing(false)}
        />
      ) : (
        <FieldsCard profile={profile} access={access} />
      )}

      {!candidateSelf && targetId && <PlacementCard membershipId={targetId} />}

      {!candidateSelf &&
        (access.canViewDocuments ? <DocumentsCard /> : <WithheldCard title="Documents" />)}
    </Frame>
  );
}

/**
 * The assessments still waiting on the candidate, on their own record (their
 * "what do I owe" list). The API already scopes the case read to their own
 * cases, so this filters only for the ones still open. Errors render as the
 * empty state — a candidate whose plan or permissions carry no assessments has
 * nothing due by definition.
 */
function MyAssessmentsCard() {
  const navigate = useNavigate();
  const { data: cases } = useAssessmentCases();
  const due = (cases ?? []).filter((c) => !isTerminalCaseState(c.state));

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-ui text-sm font-semibold">Assessments due</h3>
        {due.length > 0 && <Badge variant="warning">{due.length} open</Badge>}
      </div>
      {due.length === 0 ? (
        <p className="mt-2 text-[12.5px] text-text-tertiary">
          Nothing due — you&rsquo;re up to date.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5">
          {due.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => navigate(`/app/assessments/${c.id}`)}
                className="fai-row flex w-full items-center justify-between gap-3 rounded-md bg-surface-sunken px-3 py-2 text-left hover:bg-surface-hover"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold">{c.toolName}</span>
                  <span className="block text-[11.5px] text-text-tertiary">
                    Started {new Date(c.createdAt).toLocaleDateString()}
                  </span>
                </span>
                <span className="flex flex-none items-center gap-2">
                  <CaseStateBadge state={c.state} />
                  <Icon name="chevron-right" size={15} className="text-text-tertiary" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * What the induction submission says, and whether it may seed anything (U40).
 *
 * A REPEAT CREATES NOTHING (R89). Two records for one person is unrecoverable
 * without a merge, so a submission from somebody who already holds a record
 * tells an Admin and stops — and where they were deactivated, asks, because
 * reactivation takes a seat and may buy a block (R78, R86).
 */
/**
 * The person's saved signature — their digital ID (U4).
 *
 * Draw or upload once here; signing surfaces offer to APPLY it, gated by a
 * password confirmation at that moment. The preview shows exactly what will
 * print on an exported record, because the stored value IS the PNG the
 * exporter embeds. Editing replaces; Remove clears both the mark and the
 * deliberate-save marker, returning the account to remember-on-sign-off.
 */
function MySignatureCard() {
  const session = useSession();
  const save = useSaveSignature();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const saved = session.data?.signature ?? null;

  const persist = (signature: string | null, done: string) => {
    save.mutate(signature, {
      onSuccess: () => {
        setEditing(false);
        setDraft('');
        toast({ variant: 'success', message: done });
      },
      // The route distinguishes too-large from wrong-format; a network/503
      // failure is neither, so fall back to a connection message rather than
      // wrongly blaming the image.
      onError: (err) => {
        const body = err instanceof ApiError ? (err.body as { error?: unknown } | null) : null;
        const message =
          body?.error === 'too_large'
            ? 'That signature image is too large. Try a smaller one.'
            : body?.error === 'not_png_data_url'
              ? 'That signature could not be saved. It must be a PNG image.'
              : 'That signature could not be saved. Check your connection and try again.';
        toast({ variant: 'danger', message });
      },
    });
  };

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-heading text-[15px] font-bold">My signature</h3>
          <p className="mt-0.5 text-[12.5px] text-text-tertiary">
            Saved once, applied when you sign — you confirm with your password each time it is used.
          </p>
        </div>
        {saved && !editing && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              Replace
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => persist(null, 'Saved signature removed.')}
            >
              Remove
            </Button>
          </div>
        )}
      </div>

      {saved && !editing ? (
        <div className="mt-3 inline-block rounded-lg border border-border-strong bg-surface-card p-2">
          <img src={saved} alt="Your saved signature" className="h-[75px] max-w-full" />
        </div>
      ) : (
        <div className="mt-3 flex max-w-[460px] flex-col gap-2">
          <SignaturePad value={draft} onChange={setDraft} allowUpload aria-label="Your signature" />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={!draft || save.isPending}
              onClick={() => persist(draft, 'Signature saved to your profile.')}
            >
              Save signature
            </Button>
            {editing && (
              <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setDraft(''); }}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function SeedBanner({ submissionId }: { submissionId: string }) {
  const { data } = useProfileSeed(submissionId);
  if (!data) return null;

  if (data.disposition !== 'create') {
    return (
      <Card className="flex items-start gap-2 border-warning-border bg-warning-surface p-4">
        <Icon name="user-check" size={16} className="mt-0.5 text-warning-text" />
        <p className="text-[12.5px] text-warning-text">
          {data.disposition === 'deactivated'
            ? 'This person already has a record and has been deactivated. Reactivate them rather than creating a second record — it takes a seat.'
            : 'This person already has a record. Nothing was seeded; open their record instead of creating a second one.'}
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <p className="text-[12.5px] text-text-tertiary">
        Prefilled from an induction submission. No document came across &mdash; the file was never
        kept &mdash; and the employee and swipe card numbers are yours to enter.
      </p>
      {data.seed.unmatched.length > 0 && (
        <div className="mt-2">
          <p className="text-[12px] font-medium">These answers are no longer offered:</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {data.seed.unmatched.map((u) => (
              <li key={`${u.key}-${u.value}`}>
                <Badge variant="warning">
                  {u.key}: {u.value}
                </Badge>
              </li>
            ))}
          </ul>
          {/* A suggestion, not a value — an Admin picks from the current lists (R94). */}
          <p className="mt-1 text-[11.5px] text-text-tertiary">Pick a current value for each.</p>
        </div>
      )}
    </Card>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="fai-rise mx-auto grid max-w-[860px] gap-5 p-[30px_28px_60px]">{children}</div>;
}

/**
 * A section this reader is not admitted to.
 *
 * Named rather than omitted, so somebody who cannot see the documents knows
 * there is a documents section rather than wondering whether the record has any.
 * The COUNT is not shown — that would leak the very thing the setting withholds.
 */
function WithheldCard({ title }: { title: string }) {
  return (
    <Card className="flex items-center gap-2 p-5 text-sm text-text-tertiary">
      <Icon name="lock" size={15} />
      <span>{title} are not shown to your access level in this organisation.</span>
    </Card>
  );
}

/** Inventory entries the record itself renders — placement has its own card. */
const DISPLAY_FIELDS = PROFILE_FIELDS.filter(
  (f) => f.storedOn !== 'membership' && f.key !== 'profilePictureKey',
);

function FieldsCard({ profile, access }: { profile: MemberProfile; access: ProfileAccess }) {
  return (
    <Card className="p-5">
      <h3 className="font-ui text-sm font-semibold">Details</h3>
      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {DISPLAY_FIELDS.map((f) => (
          <div key={f.key} className="flex items-baseline justify-between gap-3 border-b border-border-subtle py-1.5">
            <dt className="flex items-center gap-1.5 text-[12px] text-text-tertiary">
              {f.label}
              {f.presence === 'derived' && (
                // Derived and stored nowhere (R3, R15, KTD19) — the form offers
                // no way to enter it, and saying so here is why.
                <Badge variant="neutral">derived</Badge>
              )}
            </dt>
            <dd className="text-[12.5px] font-medium">{displayValue(profile, f) || '—'}</dd>
          </div>
        ))}
      </dl>
      {access.isSubject && (
        <p className="mt-3 text-[12px] text-text-tertiary">
          This is your own record. You may change your address, mobile and emergency contact;
          everything else is the organisation&rsquo;s to correct.
        </p>
      )}
    </Card>
  );
}

const INDIGENOUS_LABEL: Record<MemberProfile['indigenousStatus'], string> = {
  indigenous: 'Indigenous',
  not_indigenous: 'Not Indigenous',
  not_stated: 'Not stated',
};

function displayValue(profile: MemberProfile, f: ProfileFieldSpec): string {
  if (f.key === 'indigenousStatus') return INDIGENOUS_LABEL[profile.indigenousStatus];
  const raw = (profile as unknown as Record<string, unknown>)[f.key];
  return raw == null ? '' : String(raw);
}

/**
 * The Admin's entry form (F1).
 *
 * Renders from the SAME inventory the read does, marks its required fields from
 * it, and offers each closed field's own option list (R13, R14) — so the decline
 * values for gender and ethnicity are present because the inventory carries
 * them, not because this form remembered to add them.
 *
 * A candidate reaching this form gets the three fields R51 gives them and no
 * others, because `editableFields` is resolved by the API rather than by role
 * guesswork here.
 */
function ProfileForm({
  membershipId,
  profile,
  access,
  seeded,
  onDone,
}: {
  membershipId: string;
  profile: MemberProfile;
  access: ProfileAccess;
  /** Values an induction submission supplied (U40). Undefined on an ordinary edit. */
  seeded?: Record<string, string>;
  onDone: () => void;
}) {
  const save = useSaveProfile();
  const fields = useMemo(
    () => DISPLAY_FIELDS.filter((f) => access.editableFields.includes(f.key)),
    [access.editableFields],
  );
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      // A seeded value only fills a field the record has NOT already answered:
      // a submission is older than any correction an Admin has since made, so
      // letting it overwrite would undo their work.
      fields.map((f) => [f.key, displayValue(profile, f) || (seeded?.[f.key] ?? '')]),
    ),
  );
  const [missing, setMissing] = useState<string[]>([]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    /*
      Required-field validation runs here AND on the API. This copy exists so
      the person is told which field is missing without a round trip; the API's
      is the one that binds, because a form is not a place to enforce anything.
    */
    const blank = fields
      .filter((f) => f.presence === 'required' && !values[f.key]?.trim())
      .map((f) => f.key);
    setMissing(blank);
    if (blank.length > 0) return;
    save.mutate({ membershipId, values }, { onSuccess: onDone });
  }

  return (
    <Card className="p-5">
      <h3 className="font-ui text-sm font-semibold">Edit record</h3>
      <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={submit}>
        {fields.map((f) => (
          <label key={f.key} className="flex flex-col gap-1 text-[12px]">
            <span className="text-text-tertiary">
              {f.label}
              {f.presence === 'required' && <span aria-hidden className="ml-0.5 text-danger-text">*</span>}
            </span>
            {f.options ? (
              <select
                aria-label={f.label}
                className="rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-[12.5px]"
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              >
                <option value="">Select…</option>
                {f.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                aria-label={f.label}
                className="rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-[12.5px]"
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            )}
            {missing.includes(f.key) && (
              <span role="alert" className="text-[11.5px] text-danger-text">
                {f.label} is required.
              </span>
            )}
          </label>
        ))}
        <div className="flex items-center gap-2 sm:col-span-2">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          {save.isError && (
            <span role="alert" className="text-[12px] text-danger-text">
              That could not be saved.
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

/**
 * Where this person works, with retired and withdrawn values MARKED IN PLACE
 * (R109) rather than hidden.
 *
 * Hiding them would misreport the record: a retired Location a person still
 * holds is exactly what the working list asks an Admin to review, so a reader
 * has to be able to tell a value that still counts from one that does not.
 */
function PlacementCard({ membershipId }: { membershipId: string }) {
  const placement = useMemberPlacement(membershipId);
  const taxonomy = useTaxonomy();

  if (!placement.data || !taxonomy.data) return null;
  const { locations, departments } = taxonomy.data;
  // Roles are offered BY a Department (R5), so the flat list the placement holds
  // has to be resolved back through the Departments that own them.
  const roles = departments.flatMap((d) => d.roles);
  const name = (list: Array<{ id: string; name: string; status?: string }>, ids: string[]) =>
    ids.map((id) => {
      const found = list.find((x) => x.id === id);
      return { id, label: found?.name ?? 'Unknown', retired: found?.status === 'retired' };
    });

  const groups = [
    { title: 'Locations', items: name(locations, placement.data.locationIds) },
    { title: 'Departments', items: name(departments, placement.data.departmentIds) },
    { title: 'Roles', items: name(roles, placement.data.roleIds) },
  ];

  return (
    <Card className="p-5">
      <h3 className="font-ui text-sm font-semibold">Placement</h3>
      <div className="mt-3 grid gap-3">
        {groups.map((g) => (
          <div key={g.title}>
            <p className="text-[12px] text-text-tertiary">{g.title}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {g.items.length === 0 && <span className="text-[12.5px] text-text-tertiary">—</span>}
              {g.items.map((i) => (
                <Badge key={i.id} variant={i.retired ? 'warning' : 'neutral'}>
                  {i.label}
                  {i.retired ? ' · retired' : ''}
                </Badge>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * Competencies, showing STANDING and CURRENCY as two facts side by side.
 *
 * They answer different questions — standing is obligation and follows the
 * person's Roles, currency is eligibility and follows the competency's own dates
 * — and a reader who cannot tell them apart reads an expired OPTIONAL competency
 * as a compliance failure, which it is not (R102, R104).
 *
 * Currency arrives already resolved on the reader's own audience window, so a
 * candidate sees the thirty-day warning and everyone else the assessor's ninety.
 */
function CompetenciesCard({
  userId,
  ownRecord = false,
  canRenew = false,
}: {
  userId: string | undefined;
  /** Changes only the copy — "you hold" reads differently from "they hold". */
  ownRecord?: boolean;
  /** Whether the reader may renew a held ticket — re-date it and file evidence. */
  canRenew?: boolean;
}) {
  // Keyed on the USER, not the membership: a grant is recorded against the
  // person, and passing a membership id here validates as a UUID and then
  // matches nothing.
  const held = useHeldCompetencies(userId);
  const rows = held.data ?? [];
  /*
    Sorted urgent-first: what has lapsed or is about to lapse is the reason
    anyone opens this card, so it must not be buried under a long tail of
    healthy tickets. Ties keep the name order so the list reads stably.
  */
  const URGENCY: Record<string, number> = { expired: 0, grace: 1, expiring: 2, held: 3 };
  const sorted = [...rows].sort(
    (a, b) => (URGENCY[a.status] ?? 4) - (URGENCY[b.status] ?? 4) || a.name.localeCompare(b.name),
  );
  const current = rows.filter((c) => c.current).length;
  const attention = rows.filter((c) => c.status !== 'held').length;

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-ui text-sm font-semibold">Competencies</h3>
        {rows.length > 0 && (
          <span className="flex items-center gap-1.5">
            <Badge variant="success">{current} current</Badge>
            {attention > 0 && <Badge variant="warning">{attention} need attention</Badge>}
          </span>
        )}
      </div>
      {rows.length === 0 && (
        <p className="mt-2 text-[12.5px] text-text-tertiary">
          {ownRecord ? 'You hold no competencies yet.' : 'No competencies held.'}
        </p>
      )}
      <ul className="mt-3 flex flex-col gap-1.5">
        {sorted.map((c) => (
          <li
            key={c.competencyId}
            className="flex flex-col gap-2 rounded-md bg-surface-sunken px-3 py-2"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-semibold">{c.name}</span>
                  {c.code && (
                    <span className="flex-none font-mono text-[10.5px] uppercase tracking-wide text-text-tertiary">
                      {c.code}
                    </span>
                  )}
                </span>
                <span className="block text-[11.5px] text-text-tertiary">
                  {competencySubline(c)}
                </span>
                {/*
                  WHERE the obligation comes from (R5, U8): one comma-joined
                  line, "and" before the last — "Required — from Boddington,
                  Operations and Dozer Operator"; org-scope reads "org-wide".
                  Absent where the API withheld sources (the viewer gate) or
                  nothing names the entry — no line beats a false one.
                */}
                {sourcesLine(c.standing, c.sources) && (
                  <span className="block text-[11px] text-text-tertiary">
                    {sourcesLine(c.standing, c.sources)}
                  </span>
                )}
              </span>
              <span className="flex flex-none items-center gap-1.5">
                <Badge variant={STANDING_TONE[c.standing]}>{c.standing}</Badge>
                <Badge variant={currencyTone(c.status)}>{c.status}</Badge>
              </span>
            </div>
            {/* Renew — re-date a lapsed ticket and file the new evidence — for a
                reader with the authority, on someone else's record. */}
            {canRenew && userId && <RenewControl row={c} userId={userId} />}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Renew ONE held competency from the profile — the dead-end a sign-off hits when
 * a prerequisite reads "expired" and the licence has since been renewed.
 *
 * Collapsed to a "Renew" link until opened, like the register's record-by-hand
 * control. Two moves, either or both: a new expiry date re-dates the holding so
 * the prerequisite it gates passes again, and an evidence file records the
 * renewed licence against the same holding. At least one is required — an empty
 * renewal would toast nothing done.
 */
function RenewControl({ row, userId }: { row: HeldCompetencyRow; userId: string }) {
  const { toast } = useToast();
  const renew = useRenewCompetency({
    competencyId: row.competencyId,
    userId,
    holderId: row.holderId,
  });
  const [open, setOpen] = useState(false);
  const [expires, setExpires] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function reset() {
    setExpires('');
    setFile(null);
    setProgress(null);
    setOpen(false);
  }

  function onRenew() {
    if (!expires && !file) {
      toast({ variant: 'warning', message: 'Set a new expiry date, attach evidence, or both.' });
      return;
    }
    renew.mutate(
      {
        // End of day, so a licence stays valid THROUGH its printed expiry date
        // instead of lapsing the midnight that date begins — the same rule the
        // register's grant-by-hand uses.
        ...(expires ? { expiresAt: `${expires}T23:59:59.000Z` } : {}),
        evidenceFile: file,
        onProgress: setProgress,
      },
      {
        onSuccess: () => {
          toast({ variant: 'success', message: `Renewed ${row.name}.` });
          reset();
        },
        onError: () => {
          setProgress(null);
          toast({ variant: 'danger', message: 'Could not renew this competency.' });
        },
      },
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fai-chip-btn inline-flex w-fit items-center gap-1 rounded-sm text-[11px] font-medium text-text-accent hover:underline"
      >
        <Icon name="refresh-cw" size={12} />
        Renew
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border-subtle pt-2.5">
      <Input
        label="New expiry date"
        type="date"
        value={expires}
        onChange={(e) => setExpires(e.target.value)}
      />
      <div>
        <span className="block text-[12px] font-medium text-text-secondary">
          Evidence (optional)
        </span>
        <div className="mt-1 flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => fileRef.current?.click()}
            disabled={renew.isPending}
          >
            {file ? 'Change file' : 'Attach file'}
          </Button>
          {file && (
            <span className="min-w-0 truncate text-[11.5px] text-text-tertiary">{file.name}</span>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,application/pdf"
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
      </div>
      <p className="text-[11px] text-text-tertiary">
        Set the new expiry so the prerequisite passes again, and attach the renewed licence as
        evidence. PNG, JPG, WebP or PDF, up to 10 MB.
      </p>
      {progress !== null && progress < 100 && (
        <div className="h-1.5 overflow-hidden rounded-pill bg-surface-card">
          {/* Scaled, not widened — `transform` composites where animating
              `width` re-runs layout on every progress tick. */}
          <div
            className="h-full w-full origin-left bg-accent transition-transform duration-base"
            style={{ transform: `scaleX(${Math.min(Math.max(progress / 100, 0), 1)})` }}
          />
        </div>
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={onRenew} disabled={renew.isPending || (!expires && !file)}>
          {renew.isPending ? 'Renewing…' : 'Renew'}
        </Button>
        <Button size="sm" variant="ghost" onClick={reset} disabled={renew.isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * The standing badge's tone, EXHAUSTIVE over the union (U7, KTD7): a
 * recommended competency is marked distinct from required AND from merely-held
 * (R12) — the accent tone, where the old two-branch ternary would have
 * collapsed it into the neutral "optional" look by omission.
 */
const STANDING_TONE: Record<Standing, BadgeVariant> = {
  required: 'info',
  recommended: 'accent',
  optional: 'neutral',
};

/**
 * What the candidate's Roles RECOMMEND that they do not yet hold (U7, R12) —
 * the shared `RecommendedTrainingList` owns the hooks, the unheld filter and
 * the rows; this wrapper is only the profile's card chrome.
 */
function RecommendedCard() {
  return (
    <RecommendedTrainingList
      row="li"
      render={(rows) => (
        <Card className="p-5">
          <h3 className="font-ui text-sm font-semibold">Recommended for your roles</h3>
          <p className="mt-1 text-[12px] text-text-tertiary">
            Worth holding for the roles you carry — never required, and never counted against you.
          </p>
          <ul className="mt-3 flex flex-col gap-1.5">{rows}</ul>
        </Card>
      )}
    />
  );
}

/** The one-line story under a competency's name: its dates, or that it has none. */
function competencySubline(c: HeldCompetencyRow): string {
  if (c.note) return c.note;
  if (c.expiresAt) {
    const when = new Date(c.expiresAt).toLocaleDateString();
    return c.status === 'expired' ? `Expired ${when}` : `Valid until ${when}`;
  }
  return 'No expiry';
}

function currencyTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'held') return 'success';
  if (status === 'expiring' || status === 'grace') return 'warning';
  if (status === 'expired') return 'danger';
  return 'neutral';
}

function DocumentsCard() {
  return (
    <Card className="p-5">
      <h3 className="font-ui text-sm font-semibold">Documents</h3>
      <p className="mt-2 text-[12.5px] text-text-tertiary">
        Certificates and licences are held against the competency they evidence.
      </p>
    </Card>
  );
}

export { profileField };
