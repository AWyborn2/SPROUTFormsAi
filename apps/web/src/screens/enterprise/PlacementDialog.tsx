import { useEffect, useState } from 'react';
import { Badge, Button, Checkbox, Dialog, useToast } from '@formai/ui';
import {
  useMemberPlacement,
  useSetMemberPlacement,
  useTaxonomy,
} from '../../lib/data/hooks.js';
import { ApiError } from '../../lib/data/api-client.js';

/**
 * Place a member: pick the Locations and Departments they work across, then the
 * Roles from those Departments' offers (R5, R21). The same dialog places every
 * Access level — there is no second surface for staff (R22). Roles narrow to
 * the chosen Departments (R17), and the offer-and-count rules are enforced
 * server-side, so a refused placement surfaces its reason here.
 */
export function PlacementDialog({
  membershipId,
  memberName,
  open,
  onClose,
}: {
  membershipId: string;
  memberName: string;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { data: taxonomy } = useTaxonomy();
  const { data: placement } = useMemberPlacement(open ? membershipId : undefined);
  const save = useSetMemberPlacement();

  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [roleIds, setRoleIds] = useState<string[]>([]);

  // Seed from the member's current placement whenever the dialog (re)opens.
  useEffect(() => {
    if (placement) {
      setLocationIds(placement.locationIds);
      setDepartmentIds(placement.departmentIds);
      setRoleIds(placement.roleIds);
    }
  }, [placement]);

  if (!taxonomy) return null;

  const activeLocations = taxonomy.locations.filter((l) => l.status === 'active' || locationIds.includes(l.id));
  const activeDepartments = taxonomy.departments.filter(
    (d) => d.status === 'active' || departmentIds.includes(d.id),
  );
  // Roles narrow to the chosen Departments' offers (R5, R17).
  const offeredDepartments = activeDepartments.filter((d) => departmentIds.includes(d.id));

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  function onToggleDepartment(id: string) {
    const next = toggle(departmentIds, id);
    setDepartmentIds(next);
    // Drop any selected Roles whose Department is no longer chosen.
    if (!next.includes(id)) {
      const dropped = new Set(
        taxonomy!.departments.find((d) => d.id === id)?.roles.map((r) => r.id) ?? [],
      );
      setRoleIds((rs) => rs.filter((r) => !dropped.has(r)));
    }
  }

  function submit() {
    save.mutate(
      { membershipId, locationIds, departmentIds, roleIds },
      {
        onSuccess: () => {
          toast({ variant: 'success', message: `${memberName} placed.` });
          onClose();
        },
        onError: (err: unknown) => {
          const code = err instanceof ApiError ? (err.body as { code?: string })?.code : undefined;
          toast({ variant: 'danger', message: placementMessage(code) });
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Place ${memberName}`}
      description="Where they work, which Departments they are in, and the Roles they hold."
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={save.isPending || locationIds.length === 0}>
            Save placement
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
        <Column title="Locations">
          {activeLocations.length === 0 && <Empty>No Locations yet.</Empty>}
          {activeLocations.map((loc) => (
            <CheckRow
              key={loc.id}
              label={loc.name}
              retired={loc.status === 'retired'}
              checked={locationIds.includes(loc.id)}
              onChange={() => setLocationIds((l) => toggle(l, loc.id))}
            />
          ))}
          {locationIds.length === 0 && (
            <p className="mt-1 text-[11px] text-danger">At least one Location is required.</p>
          )}
        </Column>

        <Column title="Departments">
          {activeDepartments.length === 0 && <Empty>No Departments yet.</Empty>}
          {activeDepartments.map((dep) => (
            <CheckRow
              key={dep.id}
              label={dep.name}
              retired={dep.status === 'retired'}
              checked={departmentIds.includes(dep.id)}
              onChange={() => onToggleDepartment(dep.id)}
            />
          ))}
        </Column>

        <Column title="Roles">
          {offeredDepartments.length === 0 && <Empty>Choose a Department first.</Empty>}
          {offeredDepartments.map((dep) => (
            <div key={dep.id} className="mb-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
                {dep.name}
              </p>
              {dep.roles
                .filter((r) => r.status === 'active' || roleIds.includes(r.id))
                .map((role) => (
                  <CheckRow
                    key={role.id}
                    label={role.name}
                    retired={role.status === 'retired'}
                    checked={roleIds.includes(role.id)}
                    onChange={() => setRoleIds((rs) => toggle(rs, role.id))}
                  />
                ))}
            </div>
          ))}
        </Column>
      </div>
    </Dialog>
  );
}

function placementMessage(code: string | undefined): string {
  switch (code) {
    case 'no_location':
      return 'A member needs at least one Location.';
    case 'role_not_offered':
      return 'A chosen Role is not offered by any of the chosen Departments.';
    case 'too_many_roles':
      return 'That Department allows only one Role per person.';
    default:
      return 'That placement could not be saved.';
  }
}

function Column({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-2 font-ui text-[13px] font-semibold">{title}</h4>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] text-text-tertiary">{children}</p>;
}

function CheckRow({
  label,
  checked,
  retired,
  onChange,
}: {
  label: string;
  checked: boolean;
  retired?: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[13px]">
      <Checkbox checked={checked} onChange={onChange} />
      <span className={retired ? 'text-text-tertiary line-through' : ''}>{label}</span>
      {retired && <Badge variant="neutral">Retired</Badge>}
    </label>
  );
}
