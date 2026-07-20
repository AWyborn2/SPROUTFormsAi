import { useState } from 'react';
import { Badge, Button, Icon, useToast } from '@formai/ui';
import { useBilling, useSession, useUpdatePlan } from '../../lib/data/hooks.js';
import type { PlanTier } from '../../lib/data/types.js';

const TIER_LABELS: Record<PlanTier, string> = {
  individual: 'Individual',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
};

const FEATURE_LABELS: Record<string, string> = {
  branding: 'Custom branding',
  sso: 'SSO / SAML',
  auditExport: 'Audit log export',
  competencyGating: 'Competency gating',
};

/** Billing — real plan/seat/feature data. Plan switcher is dev/test only. */
export function BillingScreen() {
  const { toast } = useToast();
  const { data: session } = useSession();
  const { data: billing, isLoading } = useBilling();
  const updatePlan = useUpdatePlan();
  const [switching, setSwitching] = useState<PlanTier | null>(null);

  const isOwner = session?.role === 'owner';

  if (isLoading) {
    return (
      <div className="fai-rise mx-auto max-w-[900px] p-[30px_28px_60px] flex items-center justify-center h-40">
        <span className="text-sm text-text-tertiary">Loading plan info…</span>
      </div>
    );
  }

  if (!billing) return null;

  const seatPct = billing.seatLimit > 0
    ? Math.min(100, Math.round((billing.seatUsed / billing.seatLimit) * 100))
    : 0;
  const seatColor = seatPct >= 90 ? 'var(--danger)' : seatPct >= 70 ? 'var(--warning)' : 'var(--accent)';

  function handleSwitchPlan(tier: PlanTier) {
    if (tier === billing!.planTier) return;
    setSwitching(tier);
    updatePlan.mutate(tier, {
      onSuccess: () => {
        toast({ variant: 'success', message: `Plan switched to ${TIER_LABELS[tier]}.` });
        setSwitching(null);
      },
      onError: () => {
        toast({ variant: 'danger', message: 'Could not switch plan — try again.' });
        setSwitching(null);
      },
    });
  }

  const tiers = Object.keys(billing.planConfig) as PlanTier[];

  return (
    <div className="fai-rise mx-auto max-w-[900px] p-[30px_28px_60px]">

      {/* ── Dev/test notice ─────────────────────────────────────────────── */}
      <div
        className="mb-6 flex items-start gap-3 rounded-lg border px-4 py-3"
        style={{ background: '#fffbeb', borderColor: '#fcd34d' }}
      >
        <span className="mt-0.5 flex-none" style={{ color: '#d97706' }}><Icon name="triangle-alert" size={16} /></span>
        <p className="text-[12.5px] leading-relaxed" style={{ color: '#92400e' }}>
          <strong>Dev/test only:</strong> "Change plan" below writes directly to the database with no payment
          processing. Wire up a real billing provider (Stripe, etc.) before going live.
        </p>
      </div>

      {/* ── Current plan overview ────────────────────────────────────────── */}
      <div className="mb-6 rounded-lg border border-border bg-surface-card p-5 shadow-xs">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="font-heading text-[15px] font-bold mb-0.5">Current plan</div>
            <div className="flex items-center gap-2">
              <span className="font-heading text-[22px] font-bold">{TIER_LABELS[billing.planTier]}</span>
              <Badge variant="accent">{billing.accountKind === 'individual' ? 'Individual' : 'Team'}</Badge>
            </div>
          </div>
        </div>

        {/* Seat usage */}
        <div className="mb-4">
          <div className="mb-1.5 flex justify-between">
            <span className="text-[13px] text-text-secondary">Seats used</span>
            <span className="font-mono text-xs text-text-tertiary">
              {billing.seatUsed} / {billing.seatLimit}
            </span>
          </div>
          <div className="h-[7px] overflow-hidden rounded-pill bg-surface-sunken">
            <div
              className="h-full rounded-pill transition-all"
              style={{ width: `${seatPct}%`, background: seatColor }}
            />
          </div>
          {seatPct >= 100 && (
            <p className="mt-1.5 text-[12px]" style={{ color: 'var(--danger)' }}>
              Seat limit reached — upgrade to invite more people.
            </p>
          )}
        </div>

        {/* Features */}
        <div>
          <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-text-tertiary">
            Included features
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
            {(Object.entries(billing.features) as [string, boolean][]).map(([key, enabled]) => (
              <div key={key} className="flex items-center gap-2">
                <span style={{ color: enabled ? 'var(--accent)' : 'var(--text-tertiary)' }}>
                  <Icon name={enabled ? 'check' : 'x'} size={13} />
                </span>
                <span
                  className="text-[12.5px]"
                  style={{ color: enabled ? 'var(--text-primary)' : 'var(--text-tertiary)' }}
                >
                  {FEATURE_LABELS[key] ?? key}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Plan comparison + dev switcher ───────────────────────────────── */}
      <div className="mb-3 flex items-center gap-2">
        <span className="font-heading text-[15px] font-bold">All plans</span>
        <span
          className="rounded px-1.5 py-0.5 text-[10.5px] font-bold uppercase tracking-wide"
          style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d' }}
        >
          Dev switcher
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiers.map((tier) => {
          const config = billing.planConfig[tier];
          const isCurrent = tier === billing.planTier;
          const isLoading = switching === tier;

          return (
            <div
              key={tier}
              className="flex flex-col rounded-lg border-[1.5px] p-4"
              style={{
                borderColor: isCurrent ? 'var(--border-accent)' : 'var(--border-default)',
                background: isCurrent ? 'var(--surface-accent-soft)' : 'var(--surface-card)',
              }}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="font-heading text-[14px] font-bold">{TIER_LABELS[tier]}</span>
                {isCurrent && <Badge variant="accent" size="sm">Current</Badge>}
              </div>

              <div className="mb-3 text-[12px] text-text-secondary">
                {config.seatLimit} seat{config.seatLimit === 1 ? '' : 's'}
              </div>

              <div className="mb-4 flex-1 space-y-1">
                {(Object.entries(config.features) as [string, boolean][]).map(([key, on]) => (
                  <div key={key} className="flex items-center gap-1.5">
                    <span style={{ color: on ? 'var(--accent)' : 'var(--text-tertiary)', flexShrink: 0 }}>
                      <Icon name={on ? 'check' : 'x'} size={11} />
                    </span>
                    <span
                      className="text-[11.5px] leading-snug"
                      style={{ color: on ? 'var(--text-secondary)' : 'var(--text-tertiary)' }}
                    >
                      {FEATURE_LABELS[key] ?? key}
                    </span>
                  </div>
                ))}
              </div>

              {isOwner && !isCurrent ? (
                <Button
                  size="sm"
                  variant="outline"
                  block
                  disabled={isLoading || updatePlan.isPending}
                  onClick={() => handleSwitchPlan(tier)}
                >
                  {isLoading ? 'Switching…' : `Switch [DEV]`}
                </Button>
              ) : isCurrent ? (
                <div className="text-center text-[11.5px] font-semibold text-text-tertiary py-1">
                  Active plan
                </div>
              ) : (
                <div className="text-center text-[11.5px] text-text-tertiary py-1">
                  Owner only
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
