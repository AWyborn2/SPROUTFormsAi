import { Fragment, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, Icon, Input, SignaturePad, useToast } from '@formai/ui';
import {
  PROFILE_FIELDS,
  isTerminalCaseState,
  profileField,
  type ProfileFieldSpec,
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
import type {
  HeldCompetencyRow,
  MemberProfile,
  ProfileAccess,
  ProfileSeedResponse,
} from '../../lib/data/types.js';

/* ── View-model types ─────────────────────────────────────────────────────── */

type BadgeKind = 'earned' | 'expiring' | 'progress' | 'achievement' | 'locked';

interface BadgeItem {
  code: string;
  name: string;
  sub: string;
  kind: BadgeKind;
  pct?: number;
}

interface ActionItem {
  mark: string;
  markColor: string;
  bg: string;
  bd: string;
  name: string;
  sub: string;
  subColor: string;
  btnLabel: { candidate: string; other: string };
  btnBg: string;
  btnFg: string;
}

interface TimelineEvent {
  title: string;
  sub: string;
  dotColor: string;
  xp: string;
}

type RoleAction = 'edit' | 'download' | 'upload' | 'viewCrew' | 'nudge' | 'startCase' | 'assign';

interface RoleActionBtn {
  action: RoleAction;
  label: string;
  variant: 'secondary' | 'primary';
}

interface ProfileViewModel {
  name: string;
  meta: string;
  heroAlert: string | null;
  xp: { current: number; max: number; level: number; pct: number };
  stats: Array<{ v: string; label: string }>;
  badges: BadgeItem[];
  earnedCount: number;
  register: HeldCompetencyRow[];
  gallery: Array<{ label: string; name: string; meta: string }>;
  actions: ActionItem[];
  timeline: TimelineEvent[];
  roleActions: Record<string, RoleActionBtn[]>;
  viewerNotes: Record<string, string>;
  gallerySub: Record<string, string>;
  nextBadgeLabel: { candidate: string; candidateRequested: string; other: string };
}

/* ── Placeholder constants (future gamification backend replaces these) ──── */

const PLACEHOLDER_XP = { current: 0, max: 1000, level: 1, pct: 0 };

const PLACEHOLDER_ACHIEVEMENTS: BadgeItem[] = [];

const PLACEHOLDER_TIMELINE: TimelineEvent[] = [];

const ROLE_ACTIONS: Record<string, RoleActionBtn[]> = {
  candidate: [
    { action: 'download', label: 'Download training record', variant: 'secondary' },
    { action: 'upload', label: 'Upload training document', variant: 'primary' },
  ],
  supervisor: [
    { action: 'viewCrew', label: 'View crew matrix', variant: 'secondary' },
    { action: 'download', label: 'Download training record', variant: 'secondary' },
    { action: 'nudge', label: 'Nudge renewal', variant: 'primary' },
  ],
  assessor: [
    { action: 'download', label: 'Download training record', variant: 'secondary' },
    { action: 'startCase', label: 'Start assessment case', variant: 'primary' },
  ],
  admin: [
    { action: 'edit', label: 'Edit record', variant: 'secondary' },
    { action: 'download', label: 'Download training record', variant: 'secondary' },
    { action: 'assign', label: 'Assign assessment', variant: 'primary' },
  ],
};

const VIEWER_NOTES: Record<string, string> = {
  candidate: 'your own record — supervisors and assessors see the same badges',
  supervisor: 'read-only crew view — renewals can be nudged, not edited',
  assessor: 'assessment cases can be started and signed off from here',
  admin: 'full record — grants, evidence and role links are editable',
};

const GALLERY_SUBS: Record<string, string> = {
  candidate: 'View only',
  supervisor: 'View only',
  assessor: 'Drag photos to attach evidence',
  admin: 'Drag photos to attach evidence',
};

/* ── View-model builder ───────────────────────────────────────────────────── */

const URGENCY: Record<string, number> = { expired: 0, grace: 1, expiring: 2, held: 3, undated: 3 };

const EMPTY_ROWS: HeldCompetencyRow[] = [];

function daysUntil(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000));
}

function badgeCodeFromName(name: string): string {
  const words = name.split(/\s+/).filter((w) => w.length > 1);
  if (words.length >= 2) return words.map((w) => w[0]!.toUpperCase()).slice(0, 3).join('');
  return name.slice(0, 2).toUpperCase();
}

function buildProfileViewModel(
  profile: MemberProfile,
  held: HeldCompetencyRow[],
): ProfileViewModel {
  const sorted = [...held].sort(
    (a, b) =>
      (URGENCY[a.status] ?? 4) - (URGENCY[b.status] ?? 4) || a.name.localeCompare(b.name),
  );

  const badges: BadgeItem[] = sorted.map((c) => {
    const code = c.code || badgeCodeFromName(c.name);
    if (c.status === 'held' || c.status === 'undated') {
      const expiry = c.expiresAt
        ? `Earned · expires ${new Date(c.expiresAt).toLocaleDateString()}`
        : 'Earned';
      return { code, name: c.name, sub: expiry, kind: 'earned' as BadgeKind };
    }
    if (c.status === 'expiring' || c.status === 'grace') {
      const days = c.expiresAt ? daysUntil(c.expiresAt) : 0;
      return {
        code,
        name: c.name,
        sub: `Renewal due${c.expiresAt ? ` · ${days}d` : ''}`,
        kind: 'expiring' as BadgeKind,
      };
    }
    if (c.status === 'expired') {
      return {
        code,
        name: c.name,
        sub: 'Lapsed — renewal needed',
        kind: 'expiring' as BadgeKind,
      };
    }
    return {
      code,
      name: c.name,
      sub: c.current ? 'In progress' : 'Not started',
      kind: 'progress' as BadgeKind,
      pct: c.current ? 40 : 0,
    };
  });

  badges.push(...PLACEHOLDER_ACHIEVEMENTS);
  const earnedCount = badges.filter((b) => b.kind === 'earned').length;

  const expiringRows = sorted.filter((c) => c.status === 'expiring' || c.status === 'grace');
  const expiredRows = sorted.filter((c) => c.status === 'expired');
  const heroAlert =
    expiringRows.length > 0
      ? `${expiringRows.length} expiring — ${expiringRows[0]!.name}`
      : expiredRows.length > 0
        ? `${expiredRows.length} expired — ${expiredRows[0]!.name}`
        : null;

  const actions: ActionItem[] = [];
  for (const c of expiredRows) {
    actions.push({
      mark: '!',
      markColor: 'var(--danger-text)',
      bg: 'var(--danger-soft)',
      bd: 'var(--red-50)',
      name: c.name,
      sub: `Expired${c.expiresAt ? ` ${new Date(c.expiresAt).toLocaleDateString()}` : ''}`,
      subColor: 'var(--danger-text)',
      btnLabel: { candidate: 'Upload evidence', other: 'Request upload' },
      btnBg: 'var(--danger)',
      btnFg: '#fff',
    });
  }
  for (const c of expiringRows) {
    const days = c.expiresAt ? daysUntil(c.expiresAt) : 0;
    actions.push({
      mark: `${days}d`,
      markColor: 'var(--warning-text)',
      bg: 'var(--warning-soft)',
      bd: 'var(--amber-50)',
      name: c.name,
      sub: `Expires${c.expiresAt ? ` ${new Date(c.expiresAt).toLocaleDateString()}` : ''} — renewal`,
      subColor: 'var(--warning-text)',
      btnLabel: { candidate: 'Book renewal', other: 'Assign renewal' },
      btnBg: 'var(--accent)',
      btnFg: '#fff',
    });
  }

  const currentCount = held.filter((c) => c.current).length;

  const meta = [profile.identifier, profile.inductionDate ? `Inducted ${profile.inductionDate}` : null]
    .filter(Boolean)
    .join(' · ');

  return {
    name: profile.displayName || 'Member record',
    meta,
    heroAlert,
    xp: PLACEHOLDER_XP,
    stats: [
      { v: String(currentCount), label: 'Competencies held' },
      { v: '0', label: 'XP earned' },
      { v: '—', label: 'Zero-lapse streak' },
      { v: '—', label: 'Site leaderboard' },
    ],
    badges,
    earnedCount,
    register: sorted,
    gallery: [],
    actions,
    timeline: PLACEHOLDER_TIMELINE,
    roleActions: ROLE_ACTIONS,
    viewerNotes: VIEWER_NOTES,
    gallerySub: GALLERY_SUBS,
    nextBadgeLabel: {
      candidate: 'Request this training',
      candidateRequested: 'Requested — in the training queue ✓',
      other: 'Assign the awarding assessment',
    },
  };
}

/* ── Main screen ──────────────────────────────────────────────────────────── */

export function ProfileScreen({ membershipId }: { membershipId?: string }) {
  const params = useParams<{ id: string }>();
  const mine = useMyProfileMembership();
  const session = useSession();
  const targetId = membershipId ?? params.id ?? mine.data?.membershipId;

  const { data, isLoading, isError, error } = useProfile(targetId);
  const seedFrom = useSearchParams()[0].get('seedFrom') ?? undefined;
  const seed = useProfileSeed(seedFrom);
  const [editing, setEditing] = useState(false);

  if (isLoading || (!membershipId && mine.isLoading)) {
    return (
      <Frame>
        <div className="p-6 text-sm text-text-tertiary">Loading…</div>
      </Frame>
    );
  }

  if (isError) {
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

  if (!data)
    return (
      <Frame>
        <div className="p-6 text-sm text-text-tertiary">Nothing to show.</div>
      </Frame>
    );

  const { profile, access, userId } = data;
  const role = (session.data?.role ?? 'candidate') as string;
  /*
    A candidate on their OWN record gets the focused layout: their details, the
    competencies they hold, and the assessments waiting on them. The placement
    and documents machinery is the organisation's bookkeeping — rendering it to
    the person it is about only buried the three answers they came for.
  */
  const candidateSelf = access.isSubject && role === 'candidate';
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

  return (
    <ProfileContent
      profile={profile}
      access={access}
      userId={userId}
      membershipId={targetId}
      role={role}
      candidateSelf={candidateSelf}
      canEdit={canEdit}
      canRenewCompetencies={canRenewCompetencies}
      editing={editing}
      setEditing={setEditing}
      seedFrom={seedFrom}
      seed={seed.data}
    />
  );
}

function ProfileContent({
  profile,
  access,
  userId,
  membershipId,
  role,
  candidateSelf,
  canEdit,
  canRenewCompetencies,
  editing,
  setEditing,
  seedFrom,
  seed,
}: {
  profile: MemberProfile;
  access: ProfileAccess;
  userId: string;
  membershipId: string | undefined;
  role: string;
  candidateSelf: boolean;
  canEdit: boolean;
  canRenewCompetencies: boolean;
  editing: boolean;
  setEditing: (v: boolean) => void;
  seedFrom: string | undefined;
  seed: ProfileSeedResponse | undefined;
}) {
  const held = useHeldCompetencies(userId);
  const rows = held.data ?? EMPTY_ROWS;
  const vm = useMemo(() => buildProfileViewModel(profile, rows), [profile, rows]);
  const { toast } = useToast();
  const navigate = useNavigate();

  const handleAction = (btn: RoleActionBtn) => {
    switch (btn.action) {
      case 'edit':
        setEditing(true);
        break;
      case 'download':
        if (role === 'admin' && membershipId) {
          window.open(`/api/profiles/${membershipId}/export`, '_blank');
        } else {
          toast({ variant: 'info', message: 'Export is available to administrators.' });
        }
        break;
      case 'startCase':
        navigate(`/app/assessments/new?memberId=${userId}`);
        break;
      default:
        toast({ variant: 'info', message: `${btn.label} — coming soon.` });
    }
  };

  return (
    <div className="fai-rise mx-auto max-w-[1180px] p-[24px_24px_48px]">
      <div className="flex flex-col gap-4">
        {seedFrom && <SeedBanner submissionId={seedFrom} />}

        {profile.emailUnreachableAt && (
          <Card className="flex items-start gap-2 border-warning-border bg-warning-surface p-4">
            <Icon name="mail-x" size={16} className="mt-0.5 text-warning-text" />
            <p className="text-[12.5px] text-warning-text">
              This address has been marked as reaching nobody. The address is still on the
              record &mdash; expiry notices need somebody to pass on in person.
            </p>
          </Card>
        )}

        <HeroCard vm={vm} role={role} canEdit={canEdit} onAction={handleAction} />

        {access.canViewCompetencies && (
          <BadgeWall badges={vm.badges} earnedCount={vm.earnedCount} />
        )}

        {editing && membershipId ? (
          <ProfileForm
            membershipId={membershipId}
            profile={profile}
            access={access}
            seeded={seed?.disposition === 'create' ? seed.seed.fields : undefined}
            onDone={() => setEditing(false)}
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.5fr_1fr]">
            {/* Main column */}
            <div className="flex flex-col gap-4">
              {access.canViewCompetencies ? (
                <CompetencyRegister
                  rows={vm.register}
                  membershipId={membershipId}
                  userId={userId}
                  role={role}
                  canRenew={canRenewCompetencies}
                />
              ) : (
                <WithheldCard title="Competencies" />
              )}

              {access.canViewDocuments && (
                <EvidenceGallery gallery={vm.gallery} role={role} gallerySub={vm.gallerySub} />
              )}

              {!candidateSelf && <FieldsCard profile={profile} access={access} />}
              {!candidateSelf && membershipId && (
                <PlacementCard membershipId={membershipId} />
              )}
              {!candidateSelf &&
                (access.canViewDocuments ? (
                  <DocumentsCard />
                ) : (
                  <WithheldCard title="Documents" />
                ))}
            </div>

            {/* Sidebar column */}
            <div className="flex flex-col gap-4">
              {candidateSelf && <MyAssessmentsCard />}

              {/*
                OWN RECORD ONLY. The signature is a users-level value — one mark
                across every organisation the person works for — shown here
                because "my record" is where a person manages what is theirs. An
                admin viewing a MEMBER record must not see or edit it: the
                profile permission matrix governs org-scoped profile fields and
                is the wrong gate for a product-wide personal mark.
              */}
              {access.isSubject && <MySignatureCard />}

              <NextBadgeCard
                badges={vm.badges}
                role={role}
                labels={vm.nextBadgeLabel}
              />

              <TrainingActions actions={vm.actions} role={role} />

              {/* Recommended-but-unheld, on the candidate's OWN record only
                  (U7, R12): the held tier already shows through the register
                  above. */}
              {candidateSelf && <RecommendedCard />}

              <TrainingTimeline events={vm.timeline} />
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center gap-2.5 px-1 text-[12px] text-text-tertiary">
          <span>
            Record view:{' '}
            <span className="font-semibold text-text-secondary">
              {vm.viewerNotes[role] ?? vm.viewerNotes.candidate}
            </span>
          </span>
          <span className="flex-1" />
          <span>
            Powered by{' '}
            <span className="font-semibold text-text-primary">
              Form<span className="text-accent">AI</span>
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

/* ── Hero card ────────────────────────────────────────────────────────────── */

function HeroCard({
  vm,
  role,
  canEdit,
  onAction,
}: {
  vm: ProfileViewModel;
  role: string;
  canEdit: boolean;
  onAction: (btn: RoleActionBtn) => void;
}) {
  const raw = vm.roleActions[role] ?? vm.roleActions.candidate!;
  const buttons = canEdit ? raw : raw.filter((b) => b.action !== 'edit');

  return (
    <Card className="overflow-hidden">
      {/* Teal banner */}
      <div className="relative h-[88px] overflow-hidden rounded-t-lg bg-brand-slate">
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(600px 88px at 20% 100%, rgba(110,199,146,.25), transparent)',
          }}
        />
        {vm.heroAlert && (
          <span className="absolute right-5 top-4 inline-flex items-center gap-1.5 rounded-pill border border-white/[.16] bg-white/10 px-3 py-0 text-[12px] font-semibold text-white">
            <span
              className="h-[7px] w-[7px] rounded-full"
              style={{ background: 'var(--warning)' }}
            />
            {vm.heroAlert}
          </span>
        )}
      </div>

      {/* Hero body */}
      <div className="flex flex-wrap items-end gap-6 px-7 pb-5">
        {/* Avatar with XP ring */}
        <div className="-mt-[52px] relative flex-none">
          <div
            className="h-[128px] w-[128px] rounded-full p-[5px]"
            style={{
              background: `conic-gradient(var(--accent) ${vm.xp.pct}%, var(--border-subtle) 0)`,
            }}
          >
            <div className="flex h-full w-full items-center justify-center rounded-full bg-surface-card p-1">
              <div className="flex h-[110px] w-[110px] flex-col items-center justify-center gap-1 rounded-full bg-surface-sunken text-[12px] text-text-tertiary">
                <Icon name="image" size={28} className="opacity-50" />
                <span>Drop photo</span>
              </div>
            </div>
          </div>
          <span className="absolute bottom-0.5 right-0.5 grid h-[34px] w-[34px] place-items-center rounded-full border-[3px] border-surface-card bg-brand-slate font-heading text-[13px] font-extrabold text-brand-green">
            {vm.xp.level}
          </span>
        </div>

        {/* Name, meta, XP */}
        <div className="min-w-[280px] flex-1 pt-3.5">
          <h2 className="font-heading text-[26px] font-bold">{vm.name}</h2>
          {vm.meta && (
            <p className="mt-0.5 text-[13.5px] text-text-secondary">{vm.meta}</p>
          )}

          {/* XP bar */}
          <div className="mt-3 flex max-w-[460px] items-center gap-3">
            <span className="whitespace-nowrap font-mono text-[11px] font-semibold text-accent">
              LVL {vm.xp.level}
            </span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${vm.xp.pct}%`,
                  background: 'linear-gradient(90deg, var(--accent), var(--brand-green))',
                }}
              />
            </div>
            <span className="whitespace-nowrap font-mono text-[11px] text-text-tertiary">
              {vm.xp.current.toLocaleString()} / {vm.xp.max.toLocaleString()} XP
            </span>
          </div>

          {/* Chips */}
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-pill bg-success-soft px-2.5 py-0 text-[12px] font-semibold text-success-text">
              Zero-lapse streak
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-pill bg-info-soft px-2.5 py-0 text-[12px] font-semibold text-info-text">
              Leaderboard
            </span>
          </div>
        </div>

        {/* Role-specific action buttons */}
        <div className="flex flex-wrap gap-2.5 pt-3.5">
          {buttons.map((btn) => (
            <Button
              key={btn.action}
              variant={btn.variant}
              onClick={() => onAction(btn)}
            >
              {btn.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 border-t border-border-subtle max-md:grid-cols-2">
        {vm.stats.map((s, i) => (
          <div
            key={s.label}
            className={`px-6 py-3.5 ${i < vm.stats.length - 1 ? 'border-r border-border-subtle max-md:[&:nth-child(2)]:border-r-0' : ''}`}
          >
            <div className="font-heading text-[24px] font-bold tabular-nums">{s.v}</div>
            <div className="mt-px text-[12px] text-text-tertiary">{s.label}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ── Badge wall ───────────────────────────────────────────────────────────── */

function badgeRing(b: BadgeItem): string {
  const greenGrad = 'linear-gradient(135deg, var(--accent), var(--brand-green))';
  switch (b.kind) {
    case 'earned':
      return greenGrad;
    case 'expiring':
      return 'conic-gradient(var(--warning) 92%, var(--warning-soft) 0)';
    case 'progress':
      return `conic-gradient(var(--accent) ${b.pct ?? 0}%, var(--border-subtle) 0)`;
    case 'achievement':
      return greenGrad;
    case 'locked':
      return 'var(--border-subtle)';
    default:
      return 'var(--border-subtle)';
  }
}

function badgeInnerStyle(b: BadgeItem): React.CSSProperties {
  if (b.kind === 'achievement') return { background: 'var(--brand-slate)' };
  if (b.kind === 'locked')
    return { background: 'var(--surface-hover)', border: '2px dashed var(--border-strong)' };
  if (b.kind === 'earned') return { background: 'var(--success-soft)' };
  if (b.kind === 'expiring') return { background: 'var(--warning-soft)' };
  return { background: 'var(--surface-card)' };
}

function badgeCodeColor(b: BadgeItem): string {
  if (b.kind === 'earned') return 'var(--accent)';
  if (b.kind === 'expiring') return 'var(--warning-text)';
  if (b.kind === 'achievement') return 'var(--brand-green)';
  if (b.kind === 'locked') return 'var(--text-disabled)';
  return 'var(--text-disabled)';
}

function BadgeWall({ badges, earnedCount }: { badges: BadgeItem[]; earnedCount: number }) {
  if (badges.length === 0) return null;

  return (
    <Card className="px-7 py-5">
      <div className="mb-4 flex items-baseline justify-between">
        <div>
          <h3 className="font-heading text-[17px] font-bold">Badge wall</h3>
          <p className="mt-0.5 text-[12.5px] text-text-tertiary">
            Competency badges, renewals and achievements
          </p>
        </div>
        <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-accent">
          {earnedCount} of {badges.length} earned
        </span>
      </div>
      <div className="grid grid-cols-6 gap-4 max-md:grid-cols-4 max-sm:grid-cols-3">
        {badges.map((b) => (
          <div
            key={`${b.code}-${b.name}`}
            className="flex cursor-default flex-col items-center gap-2 rounded-xl p-3.5 text-center transition-colors hover:bg-surface-hover"
          >
            <div
              className="h-[74px] w-[74px] rounded-full p-1"
              style={{ background: badgeRing(b) }}
            >
              <div
                className="flex h-full w-full items-center justify-center rounded-full"
                style={badgeInnerStyle(b)}
              >
                <span
                  className="font-heading font-extrabold"
                  style={{ color: badgeCodeColor(b), fontSize: b.code.length > 3 ? '14px' : '20px' }}
                >
                  {b.code}
                </span>
              </div>
            </div>
            <span
              className="text-[11.5px] font-semibold leading-tight"
              style={{
                color:
                  b.kind === 'locked' ? 'var(--text-disabled)' : 'var(--text-primary)',
              }}
            >
              {b.name}
            </span>
            <span
              className="text-[10.5px] font-medium"
              style={{
                color:
                  b.kind === 'expiring'
                    ? 'var(--warning-text)'
                    : b.kind === 'progress'
                      ? 'var(--accent)'
                      : 'var(--text-tertiary)',
              }}
            >
              {b.sub}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ── Competency register ──────────────────────────────────────────────────── */

function statusDotColor(status: string): string {
  if (status === 'held') return 'var(--success)';
  if (status === 'expiring' || status === 'grace') return 'var(--warning)';
  if (status === 'expired') return 'var(--danger)';
  return 'var(--info)';
}

function statusTextColor(status: string): string {
  if (status === 'held') return 'var(--success-text)';
  if (status === 'expiring' || status === 'grace') return 'var(--warning-text)';
  if (status === 'expired') return 'var(--danger-text)';
  return 'var(--info-text)';
}

function CompetencyRegister({
  rows,
  membershipId,
  userId,
  role,
  canRenew,
}: {
  rows: HeldCompetencyRow[];
  membershipId: string | undefined;
  userId: string;
  role: string;
  canRenew: boolean;
}) {
  const { toast } = useToast();

  if (rows.length === 0) {
    return (
      <Card className="p-5">
        <h3 className="font-ui text-sm font-semibold">Competencies</h3>
        <p className="mt-2 text-[12.5px] text-text-tertiary">No competencies held.</p>
      </Card>
    );
  }

  return (
    <Card className="px-7 py-5">
      <h3 className="mb-3 font-heading text-[17px] font-bold">Competencies</h3>
      <div className="overflow-x-auto">
        <div
          className="grid text-[13px]"
          style={{ gridTemplateColumns: '2fr 1.15fr 1.35fr 1fr' }}
        >
          {/* Header */}
          <div className="border-b border-border-default pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
            Competency
          </div>
          <div className="border-b border-border-default pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
            Status
          </div>
          <div className="border-b border-border-default pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
            Evidence
          </div>
          <div className="border-b border-border-default pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
            Record
          </div>

          {/* Rows */}
          {rows.map((r) => {
            const standingColor =
              r.standing === 'required' ? 'var(--accent)' : 'var(--text-tertiary)';
            const expiryWarn = r.status === 'expiring' || r.status === 'grace';
            const needsRenewal =
              r.status === 'expired' || r.status === 'expiring' || r.status === 'grace';
            return (
              <Fragment key={r.competencyId}>
                <div className="border-b border-border-subtle py-2.5">
                  <span className="font-semibold">{r.name}</span>{' '}
                  <span className="font-medium text-text-tertiary"> &middot; </span>
                  <span className="font-medium" style={{ color: standingColor }}>
                    {r.standing}
                  </span>
                  {/*
                    WHERE the obligation comes from (R5, U8): one comma-joined
                    line, "and" before the last — "Required — from Boddington,
                    Operations and Dozer Operator"; org-scope reads "org-wide".
                    Absent where the API withheld sources (the viewer gate) or
                    nothing names the entry — no line beats a false one.
                  */}
                  {sourcesLine(r.standing, r.sources) && (
                    <span className="block text-[11px] text-text-tertiary">
                      {sourcesLine(r.standing, r.sources)}
                    </span>
                  )}
                </div>
                <div className="border-b border-border-subtle py-2.5">
                  <span
                    className="inline-flex items-center gap-1.5 font-semibold"
                    style={{ color: statusTextColor(r.status) }}
                  >
                    <span
                      className="h-[7px] w-[7px] flex-none rounded-full"
                      style={{ background: statusDotColor(r.status) }}
                    />
                    {r.status}
                  </span>
                  {r.expiresAt && (
                    <span
                      className="block pl-[13px] text-[11px]"
                      style={{
                        fontWeight: expiryWarn ? 600 : 400,
                        color: expiryWarn ? 'var(--warning-text)' : 'var(--text-tertiary)',
                      }}
                    >
                      expires {new Date(r.expiresAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
                <div className="border-b border-border-subtle py-2.5 text-text-secondary">
                  {r.evidenceRef || '—'}
                </div>
                <div className="border-b border-border-subtle py-2">
                  {r.evidenceRef ? (
                    <button
                      className="inline-flex items-center gap-1.5 rounded-pill border border-border-accent bg-surface-accent-soft px-2.5 py-0 text-[12px] font-semibold text-success-text transition-colors hover:bg-success-soft"
                      onClick={() => {
                        if (role === 'admin' && membershipId) {
                          window.open(`/api/profiles/${membershipId}/export`, '_blank');
                        } else {
                          toast({ variant: 'info', message: 'Export is available to administrators.' });
                        }
                      }}
                    >
                      <Icon name="download" size={13} />
                      PDF
                    </button>
                  ) : (
                    <span className="text-[12px] leading-7 text-text-disabled">&mdash;</span>
                  )}
                </div>
                {/* Renew — re-date a lapsed ticket and file the new evidence — for
                    a reader with the authority, on someone else's record. */}
                {canRenew && needsRenewal && (
                  <div
                    className="border-b border-border-subtle pb-2.5 pt-1"
                    style={{ gridColumn: '1 / -1' }}
                  >
                    <RenewControl row={r} userId={userId} />
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

/* ── Evidence gallery ─────────────────────────────────────────────────────── */

function EvidenceGallery({
  gallery,
  role,
  gallerySub,
}: {
  gallery: Array<{ label: string; name: string; meta: string }>;
  role: string;
  gallerySub: Record<string, string>;
}) {
  const subtitle = gallerySub[role] ?? gallerySub.candidate;
  const slots =
    gallery.length > 0
      ? gallery
      : [
          { label: 'No evidence yet', name: '', meta: '' },
          { label: 'No evidence yet', name: '', meta: '' },
          { label: 'No evidence yet', name: '', meta: '' },
        ];

  return (
    <Card className="px-7 py-5">
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="font-heading text-[17px] font-bold">Evidence gallery</h3>
        <span className="text-[12px] text-text-tertiary">{subtitle}</span>
      </div>
      <p className="mb-3.5 text-[12.5px] text-text-tertiary">
        Photos attached to grants &mdash; licence scans, VOC photos, induction cards.
      </p>
      <div className="grid grid-cols-3 gap-3 max-sm:grid-cols-2">
        {slots.map((g, i) => (
          <div key={`${g.label}-${i}`}>
            <div className="flex h-[150px] w-full flex-col items-center justify-center gap-1.5 rounded-md border-2 border-dashed border-border-default bg-surface-hover text-[12px] text-text-tertiary">
              <Icon name="image" size={28} className="opacity-40" />
              <span>{g.label}</span>
            </div>
            {g.name && (
              <div className="mt-1.5 text-[11.5px] font-semibold">{g.name}</div>
            )}
            {g.meta && (
              <div className="text-[10.5px] text-text-tertiary">{g.meta}</div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ── Next badge card ──────────────────────────────────────────────────────── */

function NextBadgeCard({
  badges,
  role,
  labels,
}: {
  badges: BadgeItem[];
  role: string;
  labels: { candidate: string; candidateRequested: string; other: string };
}) {
  const isCandidate = role === 'candidate';
  const canAssign = role === 'assessor' || role === 'admin';
  const showCard = isCandidate || canAssign;
  const nextBadge = badges.find((b) => b.kind === 'progress');
  const [requested, setRequested] = useState(false);

  if (!showCard || !nextBadge) return null;

  const btnLabel = isCandidate
    ? requested
      ? labels.candidateRequested
      : labels.candidate
    : labels.other;

  return (
    <div className="rounded-lg border border-border-accent bg-surface-accent-soft p-5">
      <div className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-accent">
        Next badge
      </div>
      <div className="flex items-center gap-3.5">
        <div
          className="h-14 w-14 flex-none rounded-full p-[3px]"
          style={{
            background: `conic-gradient(var(--accent) ${nextBadge.pct ?? 0}%, var(--success-soft) 0)`,
          }}
        >
          <div className="flex h-full w-full items-center justify-center rounded-full bg-surface-card">
            <span className="font-heading text-[15px] font-extrabold text-accent">
              {nextBadge.code}
            </span>
          </div>
        </div>
        <div>
          <div className="font-heading text-[14px] font-bold">{nextBadge.name}</div>
          <div className="mt-0.5 text-[12px] text-text-secondary">
            {nextBadge.sub}
          </div>
        </div>
      </div>
      <button
        className={`mt-3.5 w-full rounded-md py-2 text-[13px] font-semibold transition-colors ${
          isCandidate && requested
            ? 'border border-border-accent bg-surface-card text-accent'
            : 'bg-accent text-white hover:bg-accent-hover'
        }`}
        onClick={() => {
          if (isCandidate) setRequested((r) => !r);
        }}
      >
        {btnLabel}
      </button>
    </div>
  );
}

/* ── Training actions ─────────────────────────────────────────────────────── */

function TrainingActions({
  actions,
  role,
}: {
  actions: ActionItem[];
  role: string;
}) {
  const isCandidate = role === 'candidate';

  return (
    <Card className="px-6 py-5">
      <h3 className="mb-3.5 font-heading text-[16px] font-bold">Training actions</h3>
      {actions.length === 0 ? (
        <p className="text-[12.5px] text-text-tertiary">
          All up to date &mdash; no renewals within 90 days.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {actions.map((a) => (
            <div
              key={a.name}
              className="flex items-center gap-3 rounded-md border p-2.5"
              style={{ background: a.bg, borderColor: a.bd }}
            >
              <span
                className="w-9 flex-none text-center font-heading text-[15px] font-extrabold leading-tight"
                style={{ color: a.markColor }}
              >
                {a.mark}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold">{a.name}</div>
                <div className="text-[11.5px]" style={{ color: a.subColor }}>
                  {a.sub}
                </div>
              </div>
              <button
                className="whitespace-nowrap rounded-md px-3 py-1.5 text-[12.5px] font-semibold transition-[filter] hover:brightness-[.94]"
                style={{ background: a.btnBg, color: a.btnFg }}
              >
                {isCandidate ? a.btnLabel.candidate : a.btnLabel.other}
              </button>
            </div>
          ))}
          <p className="mt-3 text-[12px] text-text-tertiary">
            No other renewals within 90 days.
          </p>
        </div>
      )}
    </Card>
  );
}

/* ── Training timeline ────────────────────────────────────────────────────── */

function TrainingTimeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return (
      <Card className="px-6 py-5">
        <h3 className="mb-3.5 font-heading text-[16px] font-bold">Training activity</h3>
        <p className="text-[12.5px] text-text-tertiary">No activity recorded yet.</p>
      </Card>
    );
  }

  return (
    <Card className="px-6 py-5">
      <h3 className="mb-3.5 font-heading text-[16px] font-bold">Training activity</h3>
      <div className="flex flex-col">
        {events.map((ev, i) => (
          <div key={`${ev.title}-${i}`} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span
                className="mt-1 h-2.5 w-2.5 flex-none rounded-full"
                style={{ background: ev.dotColor }}
              />
              {i < events.length - 1 && (
                <span className="my-[3px] w-[1.5px] flex-1 bg-border-subtle" />
              )}
            </div>
            <div className="pb-4">
              <div className="text-[13px] font-semibold leading-tight">
                {ev.title}
                {ev.xp && (
                  <span className="ml-1 font-mono text-[10.5px] font-semibold text-accent">
                    {ev.xp}
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-[11.5px] text-text-tertiary">{ev.sub}</div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ── Preserved sub-components ─────────────────────────────────────────────── */

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
          Nothing due &mdash; you&rsquo;re up to date.
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
  const [removing, setRemoving] = useState(false);
  const [draft, setDraft] = useState('');
  const [password, setPassword] = useState('');
  const saved = session.data?.signature ?? null;
  /*
    Changing or clearing an EXISTING saved mark is a step-up act — clearing it
    is the one move that would disarm the sign-off password gate — so it takes
    the password. The first save, and accounts with no password, stay ungated
    (the server enforces the same rule).
  */
  const needsPassword = Boolean(saved && session.data?.hasPassword);

  const reset = () => {
    setEditing(false);
    setRemoving(false);
    setDraft('');
    setPassword('');
  };

  const persist = (signature: string | null, done: string) => {
    save.mutate(
      { signature, ...(needsPassword ? { password } : {}) },
      {
        onSuccess: () => {
          reset();
          toast({ variant: 'success', message: done });
        },
        onError: (err) => {
          const code = err instanceof ApiError ? (err.body as { error?: unknown } | null)?.error : null;
          const message =
            code === 'invalid_credentials'
              ? 'That password is not right. Try again.'
              : code === 'too_many_attempts'
                ? 'Too many attempts. Wait a few minutes and try again.'
                : code === 'too_large'
                  ? 'That signature image is too large. Try a smaller one.'
                  : code === 'not_png_data_url'
                    ? 'That signature could not be saved. It must be a PNG image.'
                    : 'That signature could not be saved. Check your connection and try again.';
          toast({ variant: 'danger', message });
        },
      },
    );
  };

  const passwordField = needsPassword && (
    <Input
      type="password"
      value={password}
      onChange={(e) => setPassword(e.target.value)}
      aria-label="Your password"
      placeholder="Your password"
      className="max-w-[240px]"
    />
  );

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-heading text-[15px] font-bold">My signature</h3>
          <p className="mt-0.5 text-[12.5px] text-text-tertiary">
            Saved once, applied when you sign — you confirm with your password each time it is used.
          </p>
        </div>
        {saved && !editing && !removing && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              Replace
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => (needsPassword ? setRemoving(true) : persist(null, 'Saved signature removed.'))}
            >
              Remove
            </Button>
          </div>
        )}
      </div>

      {removing ? (
        <div className="mt-3 flex max-w-[460px] flex-col gap-2">
          <p className="text-[12.5px] text-text-secondary">
            Enter your password to remove your saved signature.
          </p>
          {passwordField}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="danger"
              disabled={!password || save.isPending}
              onClick={() => persist(null, 'Saved signature removed.')}
            >
              Remove signature
            </Button>
            <Button size="sm" variant="ghost" onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      ) : saved && !editing ? (
        <div className="mt-3 inline-block rounded-lg border border-border-strong bg-surface-card p-2">
          <img src={saved} alt="Your saved signature" className="h-[75px] max-w-full" />
        </div>
      ) : (
        <div className="mt-3 flex max-w-[460px] flex-col gap-2">
          <SignaturePad value={draft} onChange={setDraft} allowUpload aria-label="Your signature" />
          {editing && passwordField}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={!draft || (needsPassword && !password) || save.isPending}
              onClick={() => persist(draft, 'Signature saved to your profile.')}
            >
              Save signature
            </Button>
            {editing && (
              <Button size="sm" variant="ghost" onClick={reset}>
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
          <p className="mt-1 text-[11.5px] text-text-tertiary">Pick a current value for each.</p>
        </div>
      )}
    </Card>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="fai-rise mx-auto grid max-w-[860px] gap-5 p-[30px_28px_60px]">
      {children}
    </div>
  );
}

function WithheldCard({ title }: { title: string }) {
  return (
    <Card className="flex items-center gap-2 p-5 text-sm text-text-tertiary">
      <Icon name="lock" size={15} />
      <span>{title} are not shown to your access level in this organisation.</span>
    </Card>
  );
}

/* ── Fields card (read-only details) ──────────────────────────────────────── */

const DISPLAY_FIELDS = PROFILE_FIELDS.filter(
  (f) => f.storedOn !== 'membership' && f.key !== 'profilePictureKey',
);

function FieldsCard({ profile, access }: { profile: MemberProfile; access: ProfileAccess }) {
  return (
    <Card className="p-5">
      <h3 className="font-ui text-sm font-semibold">Details</h3>
      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {DISPLAY_FIELDS.map((f) => (
          <div
            key={f.key}
            className="flex items-baseline justify-between gap-3 border-b border-border-subtle py-1.5"
          >
            <dt className="flex items-center gap-1.5 text-[12px] text-text-tertiary">
              {f.label}
              {f.presence === 'derived' && <Badge variant="neutral">derived</Badge>}
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

/* ── Profile form (Admin entry / candidate self-edit) ─────────────────────── */

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
      fields.map((f) => [f.key, displayValue(profile, f) || (seeded?.[f.key] ?? '')]),
    ),
  );
  const [missing, setMissing] = useState<string[]>([]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
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
              {f.presence === 'required' && (
                <span aria-hidden className="ml-0.5 text-danger-text">
                  *
                </span>
              )}
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

/* ── Placement card ───────────────────────────────────────────────────────── */

function PlacementCard({ membershipId }: { membershipId: string }) {
  const placement = useMemberPlacement(membershipId);
  const taxonomy = useTaxonomy();

  if (!placement.data || !taxonomy.data) return null;
  const { locations, departments } = taxonomy.data;
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
              {g.items.length === 0 && (
                <span className="text-[12.5px] text-text-tertiary">&mdash;</span>
              )}
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
