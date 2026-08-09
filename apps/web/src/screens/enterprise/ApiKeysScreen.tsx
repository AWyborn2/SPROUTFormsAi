import { useState } from 'react';
import { Badge, Button, Dialog, Icon, IconButton, Input, Select, useToast } from '@formai/ui';
import { useApiKeys, useCreateApiKey, useRevokeApiKey, useSession } from '../../lib/data/hooks.js';
import { API_KEY_ROLES, type ApiKey, type RoleName } from '../../lib/data/types.js';

/**
 * API keys — the org's machine credentials.
 *
 * The plaintext is shown once, in a panel that says so plainly, and is never
 * retrievable afterwards. Revoked keys stay listed rather than disappearing:
 * an audit conversation about what an agent did needs to be able to see the
 * key that did it.
 */
export function ApiKeysScreen() {
  const { toast } = useToast();
  const { data: session } = useSession();
  const { data: keys = [], isLoading } = useApiKeys();
  const create = useCreateApiKey();
  const revoke = useRevokeApiKey();

  const canManage = session?.role === 'owner' || session?.role === 'admin';

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState<RoleName>('Reviewer');
  const [issued, setIssued] = useState<{ name: string; key: string } | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  function closeCreate() {
    setCreateOpen(false);
    setName('');
  }

  function submitCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast({ variant: 'warning', message: 'Give the key a name so you can recognise it later.' });
      return;
    }
    create.mutate(
      { name: trimmed, role },
      {
        onSuccess: (key) => {
          closeCreate();
          setIssued({ name: key.name, key: key.key });
        },
        onError: (err: unknown) => {
          const status = (err as { status?: number }).status;
          toast({
            variant: 'danger',
            message:
              status === 403
                ? 'You cannot issue a key with more authority than your own role.'
                : 'Could not create the key — try again.',
          });
        },
      },
    );
  }

  function confirmRevoke() {
    const target = revoking;
    if (!target) return;
    revoke.mutate(target.id, {
      onSuccess: () => {
        setRevoking(null);
        toast({ variant: 'success', message: `${target.name} revoked.` });
      },
      onError: () => toast({ variant: 'danger', message: 'Could not revoke the key — try again.' }),
    });
  }

  return (
    <div className="fai-rise mx-auto max-w-[980px] p-[30px_28px_60px]">
      <div className="mb-[18px] flex items-center justify-between gap-4">
        <p className="max-w-[620px] text-sm text-text-secondary">
          Keys let an agent — such as the induction MCP server — read induction data and record
          bookings without a browser session. A key reaches the induction endpoints only, and is
          shown in full exactly once.
        </p>
        {canManage && (
          <Button size="sm" leadingIcon="key" onClick={() => setCreateOpen(true)}>
            New key
          </Button>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-surface-card shadow-xs">
        <div className="flex items-center gap-[14px] border-b border-border-subtle px-[18px] py-[11px] font-mono text-[10.5px] uppercase tracking-[0.06em] text-text-tertiary">
          <span className="flex-1">Key</span>
          <span className="w-[110px]">Role</span>
          <span className="w-[130px]">Last used</span>
          <span className="w-[34px]" />
        </div>

        {isLoading && (
          <p className="px-[18px] py-6 text-sm text-text-tertiary">Loading keys…</p>
        )}
        {!isLoading && keys.length === 0 && (
          <p className="px-[18px] py-6 text-sm text-text-tertiary">
            No API keys yet.{canManage ? ' Create one to connect an agent.' : ''}
          </p>
        )}

        {keys.map((key) => (
          <div
            key={key.id}
            className="fai-row flex items-center gap-[14px] border-b border-border-subtle px-[18px] py-3 last:border-b-0"
          >
            <span className="min-w-0 flex-1">
              <span
                className={`block truncate text-[13.5px] font-semibold ${key.revokedAt ? 'text-text-tertiary line-through' : ''}`}
              >
                {key.name}
              </span>
              <span className="block truncate font-mono text-xs text-text-tertiary">
                fai_{key.prefix}…
              </span>
              {/*
                The issuer has left and still holds a copy of this key's
                plaintext (R65). The key is the organisation's, so it keeps
                working — revoking it on somebody's departure would take down
                whatever integration it drives, unannounced — but rotating it is
                a decision only an Admin can make, and only if they are told.
              */}
              {!key.revokedAt && key.issuerDeactivatedName && (
                <span className="mt-1 flex items-center gap-1 text-xs text-warning-text">
                  <Icon name="key-round" size={12} />
                  Issued by {key.issuerDeactivatedName}, since deactivated — consider rotating
                </span>
              )}
            </span>
            <span className="w-[110px]">
              {key.revokedAt ? (
                <Badge variant="neutral">Revoked</Badge>
              ) : (
                <Badge variant="info">{key.role}</Badge>
              )}
            </span>
            <span className="w-[130px] text-xs text-text-tertiary">
              {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : 'Never used'}
            </span>
            <span className="w-[34px]">
              {canManage && !key.revokedAt && (
                <IconButton
                  icon="trash-2"
                  aria-label={`Revoke ${key.name}`}
                  variant="ghost"
                  onClick={() => setRevoking(key)}
                />
              )}
            </span>
          </div>
        ))}
      </div>

      <Dialog
        open={createOpen}
        onClose={closeCreate}
        title="Create an API key"
        description="The key is shown once. Store it in your agent's configuration before closing."
        size="sm"
      >
        <div className="flex flex-col gap-[15px] pt-1.5">
          <Input
            label="Name"
            placeholder="Induction booking agent"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCreate();
            }}
          />
          <Select
            label="Role"
            value={role}
            onChange={(e) => setRole(e.target.value as RoleName)}
            options={API_KEY_ROLES}
          />
          <p className="-mt-2 text-xs text-text-tertiary">
            Reviewer can read inductions and record bookings. Viewer is read-only.
          </p>
          <div className="mt-1 flex justify-end gap-2.5">
            <Button variant="outline" onClick={closeCreate}>
              Cancel
            </Button>
            <Button leadingIcon="key" onClick={submitCreate} disabled={create.isPending}>
              Create key
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={issued !== null}
        onClose={() => setIssued(null)}
        title="Copy your key now"
        description="This is the only time it will be shown. If you lose it, revoke the key and create another."
        size="sm"
      >
        <div className="flex flex-col gap-[15px] pt-1.5">
          <code className="block break-all rounded-md border border-border bg-surface-sunken px-3 py-2.5 font-mono text-xs">
            {issued?.key}
          </code>
          <div className="mt-1 flex justify-end gap-2.5">
            <Button
              variant="outline"
              leadingIcon="copy"
              onClick={() => {
                if (issued) void navigator.clipboard?.writeText(issued.key);
                toast({ variant: 'success', message: 'Key copied to the clipboard.' });
              }}
            >
              Copy
            </Button>
            <Button onClick={() => setIssued(null)}>Done</Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title="Revoke this key?"
        description="Any agent using it stops working immediately. This cannot be undone."
        size="sm"
      >
        <div className="flex flex-col gap-[15px] pt-1.5">
          <p className="flex items-center gap-2 text-sm text-text-secondary">
            <Icon name="key" size={14} className="text-text-tertiary" />
            {revoking?.name} · fai_{revoking?.prefix}…
          </p>
          <div className="mt-1 flex justify-end gap-2.5">
            <Button variant="outline" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmRevoke} disabled={revoke.isPending}>
              Revoke key
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
