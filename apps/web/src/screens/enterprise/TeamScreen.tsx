import { useState } from 'react';
import { Avatar, Badge, Button, Dialog, Icon, Input, Select, useToast } from '@formai/ui';
import { useBilling, useInviteMember, useMembers, useRemoveMember, useSession, useSetMemberRole } from '../../lib/data/hooks.js';
import { INVITABLE_ROLES, ROLE_NAMES, type Member, type RoleName } from '../../lib/data/types.js';
import { EMAIL_RE } from '../../lib/validation.js';

/** Team management — member list, seat header, and the invite dialog. */
export function TeamScreen() {
  const { toast } = useToast();
  const { data: session } = useSession();
  const { data: members = [] } = useMembers();
  const { data: billing } = useBilling();
  const invite = useInviteMember();
  const setRole = useSetMemberRole();
  const remove = useRemoveMember();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<RoleName>('Builder');

  const active = members.filter((m) => m.status === 'active').length;
  const invited = members.filter((m) => m.status === 'invited').length;

  const seatLimit = billing?.seatLimit ?? null;
  const atSeatLimit = seatLimit !== null && active >= seatLimit;

  function closeInvite() {
    setInviteOpen(false);
    setInviteEmail('');
  }

  function sendInvite() {
    const email = inviteEmail.trim();
    if (!EMAIL_RE.test(email)) {
      toast({ variant: 'warning', message: 'Enter a valid email address to invite.' });
      return;
    }
    invite.mutate(
      { email, role: inviteRole },
      {
        onSuccess: (member) => {
          if (!member) {
            toast({ variant: 'warning', message: `${email} is already on the team.` });
            return;
          }
          if (member.emailSent === false) {
            toast({
              variant: 'warning',
              message: "Invite created — the email couldn't be sent, ask them to sign in with this address directly.",
            });
          } else {
            toast({ variant: 'success', message: `${email} invited as ${inviteRole}.` });
          }
          closeInvite();
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
          <span className="w-[170px]">Role</span>
          <span className="w-24">Status</span>
          <span className="w-[34px]" />
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
          />
        ))}
      </div>

      {/* Invite dialog */}
      <Dialog
        open={inviteOpen}
        onClose={closeInvite}
        title="Invite a teammate"
        description={`They'll get an email invite to join ${session?.orgName ?? 'your organization'}.`}
        size="sm"
      >
        <div className="flex flex-col gap-[15px] pt-1.5">
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
          <Select
            label="Role"
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as RoleName)}
            options={INVITABLE_ROLES}
          />
          <div className="mt-1 flex justify-end gap-2.5">
            <Button variant="outline" onClick={closeInvite}>
              Cancel
            </Button>
            <Button leadingIcon="send" onClick={sendInvite}>
              Send invite
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function MemberRow({
  member,
  onRole,
  onRemove,
}: {
  member: Member;
  onRole: (role: RoleName) => void;
  onRemove: () => void;
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
              aria-label={`Role for ${member.name}`}
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
      <span className="flex w-[34px] justify-end">
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
