import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Badge, Button, Card, Icon } from '@formai/ui';
import { PROFILE_FIELDS, profileField, type ProfileFieldSpec } from '@formai/shared';
import {
  useHeldCompetencies,
  useMemberPlacement,
  useMyProfileMembership,
  useProfile,
  useSaveProfile,
  useTaxonomy,
} from '../../lib/data/hooks.js';
import type { MemberProfile, ProfileAccess } from '../../lib/data/types.js';

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
  const targetId = membershipId ?? params.id ?? mine.data?.membershipId;

  const { data, isLoading, isError, error } = useProfile(targetId);
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

  return (
    <Frame>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-heading text-xl font-bold">{profile.displayName || 'Member record'}</h2>
          <p className="mt-1 text-sm text-text-tertiary">
            {profile.identifier ? `${profile.identifier} · ` : ''}
            The organisation&rsquo;s workforce record for this person.
          </p>
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

      {editing && targetId ? (
        <ProfileForm
          membershipId={targetId}
          profile={profile}
          access={access}
          onDone={() => setEditing(false)}
        />
      ) : (
        <FieldsCard profile={profile} access={access} />
      )}

      {targetId && <PlacementCard membershipId={targetId} />}

      {access.canViewCompetencies ? (
        <CompetenciesCard userId={userId} />
      ) : (
        <WithheldCard title="Competencies" />
      )}

      {access.canViewDocuments ? (
        <DocumentsCard />
      ) : (
        <WithheldCard title="Documents" />
      )}
    </Frame>
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
  onDone,
}: {
  membershipId: string;
  profile: MemberProfile;
  access: ProfileAccess;
  onDone: () => void;
}) {
  const save = useSaveProfile();
  const fields = useMemo(
    () => DISPLAY_FIELDS.filter((f) => access.editableFields.includes(f.key)),
    [access.editableFields],
  );
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, displayValue(profile, f)])),
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
function CompetenciesCard({ userId }: { userId: string | undefined }) {
  // Keyed on the USER, not the membership: a grant is recorded against the
  // person, and passing a membership id here validates as a UUID and then
  // matches nothing.
  const held = useHeldCompetencies(userId);
  const rows = held.data ?? [];

  return (
    <Card className="p-5">
      <h3 className="font-ui text-sm font-semibold">Competencies</h3>
      {rows.length === 0 && (
        <p className="mt-2 text-[12.5px] text-text-tertiary">No competencies held.</p>
      )}
      <ul className="mt-3 flex flex-col gap-1">
        {rows.map((c) => (
          <li
            key={c.competencyId}
            className="flex items-center justify-between gap-3 rounded-md bg-surface-sunken px-3 py-1.5 text-[12.5px]"
          >
            <span className="truncate font-medium">{c.competencyId}</span>
            <span className="flex items-center gap-1.5">
              <Badge variant={c.standing === 'required' ? 'info' : 'neutral'}>{c.standing}</Badge>
              <Badge variant={currencyTone(c.status)}>{c.status}</Badge>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
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
