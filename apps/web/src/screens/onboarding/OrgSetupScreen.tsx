import { Link, useNavigate } from 'react-router-dom';
import { Button, Icon, Input, Select, useToast } from '@formai/ui';
import type { Role } from '@formai/shared';
import { BrandMark } from '../../components/BrandMark.js';
import { useUpdateOrg } from '../../lib/data/hooks.js';
import { useOnboarding } from '../../lib/onboarding.js';
import { Stepper } from './Stepper.js';

const TEAM_SIZES = ['1–10', '10–50', '50–200', '200+'];
const INVITE_ROLES: Array<{ label: string; value: Role }> = [
  { label: 'Admin', value: 'admin' },
  { label: 'Builder', value: 'builder' },
  { label: 'Reviewer', value: 'reviewer' },
  { label: 'Viewer', value: 'viewer' },
];

/** Step 1 — create the organisation and invite the first teammates. */
export function OrgSetupScreen() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { orgName, teamSize, invites, patch, addInvite, updateInvite } = useOnboarding();
  const updateOrg = useUpdateOrg();

  /**
   * Persist the org identity before moving on. Step 2 is where people abandon,
   * and the finish-branding nudge reopens Step 2 only — so a rename and team
   * size typed here would otherwise be lost with no way back to them. Invite
   * rows stay local until "Finish setup" sends them. An empty name is dropped
   * rather than overwriting the auto-provisioned one with ''.
   */
  const continueToBranding = () => {
    const name = orgName.trim();
    updateOrg.mutate(name ? { name, teamSize } : { teamSize }, {
      onSuccess: () => navigate('/setup/branding'),
      onError: () =>
        toast({
          variant: 'danger',
          message: 'Could not save your organisation details — try again.',
        }),
    });
  };

  return (
    <div className="fai-fade flex min-h-screen flex-col items-center px-6 py-12">
      <div className="w-full max-w-[560px]">
        <div className="mb-[30px] flex items-center gap-3">
          <BrandMark size={26} />
          <span className="font-heading text-lg font-bold tracking-tight">FormAI</span>
        </div>
        <Stepper active={0} />

        <div className="rounded-xl border border-border bg-surface-card p-[34px] shadow-sm">
          <div className="mb-2.5 font-mono text-[11px] uppercase tracking-wide text-text-tertiary">
            Step 1 · Organisation
          </div>
          <h3 className="mb-1.5 text-[26px]">Create your organisation</h3>
          <p className="mb-6 text-[14.5px] text-text-secondary">
            This is the workspace your team shares. You can rename it later.
          </p>

          <div className="flex flex-col gap-[18px]">
            <Input
              label="Organisation name"
              placeholder="Acme Corp"
              required
              value={orgName}
              onChange={(e) => patch({ orgName: e.target.value })}
            />
            <Select
              label="Team size"
              options={TEAM_SIZES}
              value={teamSize}
              onChange={(e) => patch({ teamSize: e.target.value })}
            />

            <div>
              <div className="mb-[9px] text-sm font-semibold">
                Invite your first teammates{' '}
                <span className="font-normal text-text-tertiary">— optional</span>
              </div>
              <div className="flex flex-col gap-[9px]">
                {invites.map((inv, i) => (
                  <div key={i} className="flex items-center gap-[9px]">
                    <div className="flex-1">
                      <Input
                        type="email"
                        placeholder="teammate@company.com"
                        value={inv.email}
                        onChange={(e) => updateInvite(i, { email: e.target.value })}
                      />
                    </div>
                    <div className="w-[140px]">
                      <Select
                        options={INVITE_ROLES}
                        value={inv.role}
                        onChange={(e) => updateInvite(i, { role: e.target.value as Role })}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <button
                onClick={addInvite}
                className="fai-chip-btn mt-[11px] inline-flex items-center gap-1.5 rounded-md border border-dashed border-border-strong px-3 py-[7px] font-ui text-[13px] font-medium text-text-secondary"
              >
                <Icon name="plus" size={15} />
                Add another
              </button>
            </div>
          </div>

          <div className="mt-[30px] flex items-center justify-between border-t border-border-subtle pt-[22px]">
            <Link to="/login" className="text-[13.5px] text-text-tertiary">
              Back
            </Link>
            <Button onClick={continueToBranding} loading={updateOrg.isPending}>
              Continue to branding
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
