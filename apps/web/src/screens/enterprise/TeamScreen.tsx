import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar, Badge, Button, Dialog, Icon, Input, Select, useToast } from '@formai/ui';
import {
  useBilling,
  useInviteMember,
  useIssuePasswordReset,
  useMembers,
  useRemoveMember,
  useSession,
  useSetMemberRole,
} from '../../lib/data/hooks.js';
import { INVITABLE_ROLES, ROLE_NAMES, type Member, type RoleName } from '../../lib/data/types.js';
import { EMAIL_RE } from '../../lib/validation.js';
import { PlacementDialog } from './PlacementDialog.js';

/** Team management — member list, seat header, and the invite dialog. */
export function TeamScreen() {
  const { toast } = useToast();
  const { data: session } = useSession();
  const { data: members = [] } = useMembers();
  const { data: billing } = useBilling();
  const invite = useInviteMember();
  const setRole = useSetMemberRole();
  const remove = useRemoveMember();
  const issueReset = useIssuePasswordReset();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<RoleName>('Builder');
  /**
   * How the invite reaches the person. Many candidates have no work email, so
   * their invite is printed or shown as a QR code and handed over in person —
   * which is also what makes it safe to skip the address check on acceptance.
   */
  const [delivery, setDelivery] = useState<'email' | 'link'>('email');
  /** Set once an invite exists, so the link can be shown, copied, or scanned. */
  const [created, setCreated] = useState<{ name: string; url: string; emailSent: boolean } | null>(null);
  /** A freshly issued password-reset link, awaiting handover. */
  const [resetLink, setResetLink] = useState<{ name: string; url: string } | null>(null);
  /** The member whose placement is open in the dialog. */
  const [placing, setPlacing] = useState<{ id: string; name: string } | null>(null);

  const active = members.filter((m) => m.status === 'active').length;
  const invited = members.filter((m) => m.status === 'invited').length;

  const seatLimit = billing?.seatLimit ?? null;
  const atSeatLimit = seatLimit !== null && active >= seatLimit;

  function closeInvite() {
    setInviteOpen(false);
    setInviteEmail('');
    setInviteName('');
    setCreated(null);
    setDelivery('email');
  }

  function sendInvite() {
    const email = inviteEmail.trim();
    const name = inviteName.trim();

    if (delivery === 'email' && !EMAIL_RE.test(email)) {
      toast({ variant: 'warning', message: 'Enter a valid email address to invite.' });
      return;
    }
    // A link invite carries no address, so the name is the only thing that will
    // identify the pending row in this list until it's accepted.
    if (delivery === 'link' && !name) {
      toast({ variant: 'warning', message: "Enter the person's name so you can tell invites apart." });
      return;
    }

    invite.mutate(
      {
        ...(delivery === 'email' ? { email } : {}),
        ...(name ? { name } : {}),
        role: inviteRole,
      },
      {
        onSuccess: (member) => {
          if (!member) {
            toast({ variant: 'warning', message: `${email} is already on the team.` });
            return;
          }
          // Stay open on the created invite: the link is shown ONCE, and for a
          // link invite it is the only way the person can ever get in.
          setCreated({ name: member.name, url: member.acceptUrl, emailSent: member.emailSent });
          if (delivery === 'email' && member.emailSent) {
            toast({ variant: 'success', message: `${email} invited as ${inviteRole}.` });
          }
        },
        onError: (err: unknown) => {
          const errObj = err as { status?: number; body?: { message?: string } };
          if (errObj?.status === 403 && errObj?.body?.message?.includes('seat')) {
            toast({ variant: 'danger', message: errObj.body?.message ?? 'Seat limit reached.' });
          } else {
            toast({ variant: 'danger', message: 'Could not send the invite — try again.' });
          }
        },
      },
    );
  }

  return (
    <div className="fai-rise mx-auto max-w-[980px] p-[30px_28px_60px]">
      {/* Seat header */}
      <div className="mb-[18px] flex items-center justify-between gap-4">
        <p className="text-sm text-text-secondary">
          <strong className="text-text-primary">{active}</strong> active ·{' '}
          <strong className="text-text-primary">{invited}</strong> invited · seats used{' '}
          {members.length} of{' '}
          {seatLimit !== null ? seatLimit : <span className="text-text-tertiary">…</span>}
          {atSeatLimit && (
            <span className="ml-2 text-[12px]" style={{ color: 'var(--danger)' }}>
              · Seat limit reached
            </span>
          )}
        </p>
        <div className="flex items-center gap-2">
          {atSeatLimit && (
            <span className="text-[12px] text-text-tertiary hidden sm:inline">
              Upgrade plan to add more
            </span>
          )}
          <Button
            size="sm"
            leadingIcon="user-plus"
            onClick={() => {
              if (atSeatLimit) {
                toast({
                  variant: 'warning',
                  message: `Seat limit of ${seatLimit} reached. Remove a member or upgrade your plan to invite more.`,
                });
                return;
              }
              setInviteOpen(true);
            }}
            disabled={atSeatLimit}
          >
            Invite people
          </Button>
        </div>
      </div>

      {/* Member table */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface-card shadow-xs">
        <div className="flex items-center gap-[14px] border-b border-border-subtle px-[18px] py-[11px] font-mono text-[10.5px] uppercase tracking-[0.06em] text-text-tertiary">
          <span className="flex-1">Member</span>
          <span className="w-[170px]">Access level</span>
          <span className="w-24">Status</span>
          {/* Mirrors the body row's counts and action slots so the labels sit
              over the columns they name. */}
          <span className="w-[170px]">Competencies</span>
          <span className="w-[98px]" />
        </div>
        {members.map((m) => (
          <MemberRow
            key={m.id}
            member={m}
            onRole={(role) =>
              setRole.mutate(
                { id: m.id, role },
                {
                  onSuccess: (updated) => {
                    if (updated) toast({ variant: 'success', message: `${updated.name} is now ${role}.` });
                  },
                },
              )
            }
            onRemove={() => remove.mutate(m.id)}
            onPlace={m.status === 'active' ? () => setPlacing({ id: m.id, name: m.name }) : undefined}
            onResetPassword={
              // Only for accepted members: someone still holding an unaccepted
              // invite has no account yet, so there is nothing to reset.
              m.status === 'active'
                ? () =>
                    issueReset.mutate(m.id, {
                      onSuccess: (r) => setResetLink({ name: r.name || m.name, url: r.resetUrl }),
                      onError: () =>
                        toast({ variant: 'danger', message: 'Could not create a reset link.' }),
                    })
                : undefined
            }
          />
        ))}
      </div>

      {placing && (
        <PlacementDialog
          membershipId={placing.id}
          memberName={placing.name}
          open
          onClose={() => setPlacing(null)}
        />
      )}

      {/* Invite dialog */}
      <Dialog
        open={inviteOpen}
        onClose={closeInvite}
        title={created ? 'Invite created' : 'Invite someone'}
        description={
          created
            ? undefined
            : `They'll join ${session?.orgName ?? 'your organization'} with the role you choose.`
        }
        size="sm"
      >
        {created ? (
          <LinkHandover
            url={created.url}
            qrLabel={`Invite QR code for ${created.name}`}
            onDone={closeInvite}
            blurb={
              created.emailSent ? (
                <>
                  Emailed to <strong className="text-text-primary">{created.name}</strong>. They can also
                  scan this.
                </>
              ) : (
                <>
                  Show or print this for <strong className="text-text-primary">{created.name}</strong>.
                  They'll create their account and set their own password.
                </>
              )
            }
          />
        ) : (
          <div className="flex flex-col gap-[15px] pt-1.5">
            {/* Delivery choice first: it decides which field below is required. */}
            <div className="flex gap-2">
              {(
                [
                  { key: 'email', label: 'Email invite', icon: 'mail' },
                  { key: 'link', label: 'QR code or link', icon: 'qr-code' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setDelivery(opt.key)}
                  aria-pressed={delivery === opt.key}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border px-3 py-2 text-[13px] font-medium transition-colors ${
                    delivery === opt.key
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                      : 'border-[var(--border)] text-text-secondary'
                  }`}
                >
                  <Icon name={opt.icon} size={15} />
                  {opt.label}
                </button>
              ))}
            </div>

            {delivery === 'email' ? (
              <Input
                label="Email address"
                type="email"
                leadingIcon="mail"
                placeholder="name@company.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') sendInvite();
                }}
              />
            ) : (
              <Input
                label="Their name"
                leadingIcon="user"
                placeholder="Dale Rivers"
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
                help="No email needed — hand them the QR code or link. They'll set their own password."
                onKeyDown={(e) => {
                  if (e.key === 'Enter') sendInvite();
                }}
              />
            )}

            <Select
              label="Access level"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as RoleName)}
              options={INVITABLE_ROLES}
            />
            <div className="mt-1 flex justify-end gap-2.5">
              <Button variant="outline" onClick={closeInvite}>
                Cancel
              </Button>
              <Button
                leadingIcon={delivery === 'email' ? 'send' : 'qr-code'}
                onClick={sendInvite}
                disabled={invite.isPending}
              >
                {delivery === 'email' ? 'Send invite' : 'Create invite'}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      {/* Password-reset handover. Note there is no field here for an admin to
          type a password into: they hand over a link and the person sets their
          own, which is what stops an assessor signing in as a candidate. */}
      <Dialog
        open={resetLink !== null}
        onClose={() => setResetLink(null)}
        title="Password reset link"
        size="sm"
      >
        {resetLink && (
          <LinkHandover
            url={resetLink.url}
            qrLabel={`Password reset QR code for ${resetLink.name}`}
            onDone={() => setResetLink(null)}
            blurb={
              <>
                Show or print this for <strong className="text-text-primary">{resetLink.name}</strong>.
                They'll choose a new password themselves — you won't see it.
              </>
            }
          />
        )}
      </Dialog>
    </div>
  );
}

function MemberRow({
  member,
  onRole,
  onRemove,
  onPlace,
  onResetPassword,
}: {
  member: Member;
  onRole: (role: RoleName) => void;
  onRemove: () => void;
  /** Absent for a member with no membership yet (a pending invite). */
  onPlace?: () => void;
  /** Absent for a member with no account yet — nothing to reset. */
  onResetPassword?: () => void;
}) {
  const isOwner = member.role === 'Owner';
  return (
    <div className="fai-row flex items-center gap-[14px] border-b border-border-subtle px-[18px] py-3 last:border-b-0">
      <span className="flex-none">
        <Avatar name={member.name} size="sm" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-semibold">{member.name}</span>
        <span className="block truncate text-xs text-text-tertiary">{member.email}</span>
      </span>
      <span className="w-[170px]">
        {isOwner ? (
          <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-text-secondary">
            <Icon name="crown" size={14} className="text-warning" />
            Owner
          </span>
        ) : (
          <div className="w-[150px]">
            <Select
              aria-label={`Access level for ${member.name}`}
              value={member.role}
              onChange={(e) => onRole(e.target.value as RoleName)}
              options={ROLE_NAMES as unknown as string[]}
            />
          </div>
        )}
      </span>
      <span className="w-24">
        {member.status === 'invited' ? (
          <Badge variant="warning">Invited</Badge>
        ) : (
          <Badge variant="success" dot>
            Active
          </Badge>
        )}
      </span>
      {/*
        Competency counts (R1, R3). The slot keeps its width even when this row
        has no counts — an invited row beside an active one must not shift the
        action buttons out of column. The whole group is the way into the
        member's record, where the underlying competencies are listed.
      */}
      <span className="w-[170px] flex-none">
        {member.counts && (
          <Link
            to={`/app/profile/${member.id}`}
            aria-label={`Competencies for ${member.name}: ${member.counts.requiredCurrent} required current, ${member.counts.requiredAttention} needing attention, ${member.counts.optionalLapsed} optional lapsed`}
            title="Open this member's record"
            className="fai-chip-btn inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-surface-hover"
          >
            {/* Zero is "nothing measured", not "all clear" — a green badge on a
                person whose Roles require nothing would assert compliance
                nobody checked. */}
            <Badge variant={member.counts.requiredCurrent > 0 ? 'success' : 'neutral'}>
              {member.counts.requiredCurrent} current
            </Badge>
            {member.counts.requiredAttention > 0 && (
              <Badge variant="warning">{member.counts.requiredAttention} due</Badge>
            )}
            {member.counts.optionalLapsed > 0 && (
              <span className="text-[11px] text-text-tertiary">
                {member.counts.optionalLapsed} optional
              </span>
            )}
          </Link>
        )}
      </span>
      <span className="flex w-[98px] justify-end gap-0.5">
        {onPlace && (
          <button
            onClick={onPlace}
            aria-label={`Place ${member.name}`}
            title="Set Locations, Departments and Roles"
            className="fai-chip-btn grid h-[30px] w-[30px] place-items-center rounded-sm text-text-tertiary hover:bg-surface-hover"
          >
            <Icon name="map-pin" size={15} />
          </button>
        )}
        {onResetPassword && (
          <button
            onClick={onResetPassword}
            aria-label={`Reset password for ${member.name}`}
            title="Issue a password reset link"
            className="fai-chip-btn grid h-[30px] w-[30px] place-items-center rounded-sm text-text-tertiary hover:bg-surface-hover"
          >
            <Icon name="key-round" size={15} />
          </button>
        )}
        {!isOwner && (
          <button
            onClick={onRemove}
            aria-label={`Remove ${member.name}`}
            className="fai-chip-btn grid h-[30px] w-[30px] place-items-center rounded-sm text-text-tertiary hover:bg-surface-hover"
          >
            <Icon name="x" size={15} />
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * What an admin hands over: a scannable code and a copyable link.
 *
 * Used for both invites and password resets, because both are the same shape of
 * secret — a URL that is the entire credential, shown once to the person who
 * just created it, to be handed over in person or printed.
 *
 * Note what is NOT here, in either case: any way to set someone else's
 * password. They choose it themselves at the far end of the link, so nobody who
 * administers or marks their assessments can sign in as them.
 */
function LinkHandover({
  url,
  blurb,
  qrLabel,
  onDone,
}: {
  url: string;
  blurb: React.ReactNode;
  qrLabel: string;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    // Imported lazily: the QR encoder is only needed once an invite exists,
    // and it should not sit in the bundle every admin loads.
    void import('qrcode').then((qr) => {
      if (cancelled || !canvasRef.current) return;
      void qr.toCanvas(canvasRef.current, url, { width: 190, margin: 1 });
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div className="flex flex-col items-center gap-3 pt-1.5">
      <p className="text-center text-[13px] text-text-secondary">{blurb}</p>

      <div className="rounded-[12px] border border-[var(--border)] bg-white p-3">
        <canvas ref={canvasRef} aria-label={qrLabel} />
      </div>

      <code className="w-full break-all rounded-[8px] bg-[var(--surface-2)] px-2.5 py-2 text-center text-[11px] text-text-secondary">
        {url}
      </code>

      <div className="mt-1 flex w-full justify-end gap-2.5">
        <Button
          variant="outline"
          leadingIcon="copy"
          onClick={() => {
            void navigator.clipboard
              .writeText(url)
              .then(() => toast({ variant: 'success', message: 'Link copied.' }))
              .catch(() => toast({ variant: 'warning', message: 'Copy failed — select the link above.' }));
          }}
        >
          Copy link
        </Button>
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}
