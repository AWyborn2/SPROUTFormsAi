import { useState } from 'react';
import { Badge, Button, Icon, Switch, useToast } from '@formai/ui';
import { PERM_CATEGORIES, ROLE_DESCRIPTIONS } from '../../lib/data/fixtures.js';
import { useMembers, useRoles, useTogglePermission } from '../../lib/data/hooks.js';
import { ROLE_NAMES, type PermAction, type RoleName } from '../../lib/data/types.js';

/** Roles & permissions — role rail + a Switch-driven capability matrix. */
export function RolesScreen() {
  const { toast } = useToast();
  const { data: members = [] } = useMembers();
  const { data: perms } = useRoles();
  const toggle = useTogglePermission();

  const [selected, setSelected] = useState<RoleName>('Builder');
  const locked = selected === 'Owner';

  const counts = ROLE_NAMES.reduce<Record<RoleName, number>>(
    (acc, r) => {
      acc[r] = members.filter((m) => m.role === r).length;
      return acc;
    },
    { Owner: 0, Admin: 0, Builder: 0, Reviewer: 0, Viewer: 0 },
  );

  const rolePerms = perms?.[selected] ?? {};
  const memberCount = counts[selected];

  return (
    <div className="fai-rise mx-auto grid max-w-[1040px] grid-cols-1 items-start gap-5 p-[30px_28px_60px] md:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
      {/* Role rail */}
      <div className="flex flex-col gap-2">
        {ROLE_NAMES.map((r) => {
          const isSel = r === selected;
          return (
            <button
              key={r}
              onClick={() => setSelected(r)}
              aria-pressed={isSel}
              className="fai-chip-btn rounded-md border px-[14px] py-[13px] text-left"
              style={{
                borderColor: isSel ? 'var(--border-accent)' : 'var(--border-subtle)',
                background: isSel ? 'var(--surface-accent-soft)' : 'var(--surface-card)',
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-ui text-sm font-semibold">{r}</span>
                {isSel ? (
                  <Badge variant="accent">{counts[r]}</Badge>
                ) : (
                  <span className="font-mono text-[11px] text-text-tertiary">{counts[r]} people</span>
                )}
              </div>
              <div className="mt-[3px] text-[11.5px] leading-[1.4] text-text-tertiary">
                {ROLE_DESCRIPTIONS[r]}
              </div>
            </button>
          );
        })}
      </div>

      {/* Matrix */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface-card shadow-xs">
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-[18px]">
          <div>
            <div className="font-heading text-base font-bold">{selected} permissions</div>
            <div className="mt-0.5 text-[12.5px] text-text-tertiary">
              {ROLE_DESCRIPTIONS[selected]} · {memberCount} member{memberCount === 1 ? '' : 's'}
            </div>
          </div>
          {locked && (
            <span className="inline-flex items-center gap-1.5 text-xs text-text-tertiary">
              <Icon name="lock" size={13} />
              Locked
            </span>
          )}
        </div>

        <div className="px-5 pb-4 pt-2">
          {PERM_CATEGORIES.map((cat) => (
            <div key={cat.key} className="border-b border-border-subtle py-[14px] last:border-b-0">
              <div className="mb-[11px] font-mono text-[10.5px] uppercase tracking-[0.05em] text-text-tertiary">
                {cat.label}
              </div>
              <div className="flex flex-wrap gap-x-[18px] gap-y-3">
                {cat.actions.map(([action, label]) => {
                  const on = !!rolePerms[cat.key]?.[action];
                  return (
                    <div key={action} className="inline-flex items-center gap-2.5">
                      <span className="text-[13px] text-text-secondary">{label}</span>
                      <Switch
                        checked={on}
                        disabled={locked}
                        aria-label={`${cat.label} · ${label} for ${selected}`}
                        onChange={() =>
                          toggle.mutate({ role: selected, category: cat.key, action: action as PermAction })
                        }
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {locked && (
            <div className="flex items-center gap-2 pb-1 pt-3.5 text-[12.5px] text-text-tertiary">
              <Icon name="info" size={14} />
              The Owner role always has full access and can't be edited.
            </div>
          )}
        </div>

        <div className="flex justify-end border-t border-border-subtle px-5 py-3.5">
          <Button
            size="sm"
            onClick={() =>
              toast({
                variant: 'success',
                message: `“${selected}” updated for ${memberCount} member${memberCount === 1 ? '' : 's'}.`,
              })
            }
          >
            Save changes
          </Button>
        </div>
      </div>
    </div>
  );
}
