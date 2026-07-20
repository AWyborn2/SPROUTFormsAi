import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, Icon, Input, useToast } from '@formai/ui';
import { ApiError } from '../lib/data/api-client.js';
import { useDeleteAccount, useLogout } from '../lib/data/hooks.js';

export interface AccountMenuProps {
  open: boolean;
  onClose: () => void;
  /** Fired once the session is actually gone (logout, or account deletion) — caller redirects to `/login`. */
  onLoggedOut: () => void;
}

const DELETE_CONFIRM_TEXT = 'DELETE';

/**
 * Popover anchored to `AppShell`'s sidebar user block: "Log out" (immediate)
 * and "Delete account" (opens a type-to-confirm dialog, since it can take
 * the caller's whole organization with it — see `DELETE /account`).
 */
export function AccountMenu({ open, onClose, onLoggedOut }: AccountMenuProps) {
  const { toast } = useToast();
  const logout = useLogout();
  const deleteAccount = useDeleteAccount();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open, onClose]);

  function handleLogout() {
    onClose();
    logout.mutate(undefined, {
      onSuccess: onLoggedOut,
      onError: () => toast({ variant: 'danger', message: 'Could not log out — try again.' }),
    });
  }

  function openDeleteConfirm() {
    onClose();
    setConfirmText('');
    setConfirmOpen(true);
  }

  function handleDelete() {
    deleteAccount.mutate(undefined, {
      onSuccess: ({ orgDeleted }) => {
        setConfirmOpen(false);
        toast({
          variant: 'success',
          message: orgDeleted ? 'Account and organization deleted.' : 'Account deleted.',
        });
        onLoggedOut();
      },
      onError: (err) => {
        const message =
          err instanceof ApiError &&
          typeof err.body === 'object' &&
          err.body !== null &&
          (err.body as { error?: string }).error === 'cannot_delete_last_owner'
            ? "You're the last owner — promote another member first."
            : 'Could not delete your account — try again.';
        toast({ variant: 'danger', message });
      },
    });
  }

  return (
    <>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          className="fai-fade absolute bottom-full left-0 z-40 mb-1 w-full overflow-hidden rounded-md border border-border bg-surface-card py-1 shadow-lg"
        >
          <button
            role="menuitem"
            onClick={handleLogout}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-text-primary hover:bg-surface-hover"
          >
            <Icon name="log-out" size={15} />
            Log out
          </button>
          <button
            role="menuitem"
            onClick={openDeleteConfirm}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-danger hover:bg-surface-hover"
          >
            <Icon name="trash-2" size={15} />
            Delete account
          </button>
        </div>
      )}

      <Dialog
        open={confirmOpen}
        onClose={() => !deleteAccount.isPending && setConfirmOpen(false)}
        title="Delete your account"
        description="This permanently deletes your account. If you're the only member of your organization, the entire organization and all its data — forms, submissions, everything — is deleted with it. This can't be undone."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={deleteAccount.isPending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleDelete}
              disabled={confirmText !== DELETE_CONFIRM_TEXT || deleteAccount.isPending}
            >
              {deleteAccount.isPending ? 'Deleting…' : 'Delete account'}
            </Button>
          </>
        }
      >
        <Input
          label={`Type ${DELETE_CONFIRM_TEXT} to confirm`}
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={DELETE_CONFIRM_TEXT}
        />
      </Dialog>
    </>
  );
}
