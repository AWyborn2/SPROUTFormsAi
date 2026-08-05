import { useState } from 'react';
import { Badge, Button, Card, Icon, Input, Select, Switch, useToast } from '@formai/ui';
import { DISPLAY_IDENTIFIER_LABELS, type DisplayIdentifier } from '@formai/shared';
import {
  useCreateDepartment,
  useCreateLocation,
  useCreateRole,
  useTaxonomy,
  useUpdateDepartment,
  useUpdateLocation,
  useUpdateRole,
  useUpdateTaxonomySettings,
} from '../../lib/data/hooks.js';
import type { TaxDepartment, TaxLocation, TaxRole } from '../../lib/data/types.js';
import { ApiError } from '../../lib/data/api-client.js';

/**
 * Locations & roles — the organisation's own taxonomy. Departments are the
 * spine (a Role is created inside one, R5); Locations sit beside them flat; the
 * three organisation settings sit in their own panel because they govern the
 * taxonomy rather than being a property of any list. Retired values render
 * struck through with a Return action — nothing here deletes.
 */
export function TaxonomyScreen() {
  const { toast } = useToast();
  const { data, isLoading } = useTaxonomy();

  if (isLoading || !data) {
    return <div className="p-8 text-sm text-text-tertiary">Loading taxonomy…</div>;
  }

  function onError(err: unknown) {
    const message =
      err instanceof ApiError && err.status === 409
        ? 'That name is already in use.'
        : 'Something went wrong.';
    toast({ variant: 'danger', message });
  }

  return (
    <div className="fai-rise mx-auto grid max-w-[900px] gap-5 p-[30px_28px_60px]">
      <div>
        <h2 className="font-heading text-xl font-bold">Locations & roles</h2>
        <p className="mt-1 text-sm text-text-tertiary">
          The Locations you assess at, the Departments you run, and the Roles each Department offers.
          These become the only values a new record may carry.
        </p>
      </div>

      <SettingsPanel settings={data.settings} onError={onError} />
      <LocationsPanel locations={data.locations} onError={onError} />
      <DepartmentsPanel departments={data.departments} onError={onError} />
    </div>
  );
}

// ── Organisation settings (R24, R25, R40) ────────────────────────────────────

function SettingsPanel({
  settings,
  onError,
}: {
  settings: { allowMultipleLocations: boolean; allowMultipleDepartments: boolean; displayIdentifier: DisplayIdentifier };
  onError: (e: unknown) => void;
}) {
  const update = useUpdateTaxonomySettings();
  return (
    <Card className="p-5">
      <h3 className="font-ui text-sm font-semibold">Organisation settings</h3>
      <div className="mt-4 flex flex-col gap-4">
        <label className="flex items-center justify-between gap-4">
          <span className="text-sm">
            Allow a person at several Locations
            <span className="block text-[12px] text-text-tertiary">No ceiling on how many.</span>
          </span>
          <Switch
            checked={settings.allowMultipleLocations}
            aria-label="Allow several Locations"
            onChange={(e) => update.mutate({ allowMultipleLocations: e.target.checked }, { onError })}
          />
        </label>
        <label className="flex items-center justify-between gap-4">
          <span className="text-sm">
            Allow a person in several Departments
            <span className="block text-[12px] text-text-tertiary">Each keeps its own Role rule.</span>
          </span>
          <Switch
            checked={settings.allowMultipleDepartments}
            aria-label="Allow several Departments"
            onChange={(e) => update.mutate({ allowMultipleDepartments: e.target.checked }, { onError })}
          />
        </label>
        <label className="flex items-center justify-between gap-4">
          <span className="text-sm">
            Identify a person by
            <span className="block text-[12px] text-text-tertiary">Shown beside their name.</span>
          </span>
          <div className="w-56">
            <Select
              aria-label="Display identifier"
              value={settings.displayIdentifier}
              options={(Object.keys(DISPLAY_IDENTIFIER_LABELS) as DisplayIdentifier[]).map((id) => ({
                value: id,
                label: DISPLAY_IDENTIFIER_LABELS[id],
              }))}
              onChange={(e) =>
                update.mutate(
                  { displayIdentifier: e.target.value as DisplayIdentifier },
                  { onError },
                )
              }
            />
          </div>
        </label>
      </div>
    </Card>
  );
}

// ── Locations ────────────────────────────────────────────────────────────────

function LocationsPanel({
  locations,
  onError,
}: {
  locations: TaxLocation[];
  onError: (e: unknown) => void;
}) {
  const create = useCreateLocation();
  const updateLoc = useUpdateLocation();
  const [name, setName] = useState('');

  function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    create.mutate(trimmed, { onSuccess: () => setName(''), onError });
  }

  return (
    <Card className="p-5">
      <h3 className="font-ui text-sm font-semibold">Locations</h3>
      <div className="mt-3 flex flex-col gap-1.5">
        {locations.length === 0 && (
          <p className="text-[13px] text-text-tertiary">No Locations yet.</p>
        )}
        {locations.map((loc) => (
          <ValueRow
            key={loc.id}
            name={loc.name}
            status={loc.status}
            onRename={(next) => updateLoc.mutate({ id: loc.id, name: next }, { onError })}
            onToggleStatus={() =>
              updateLoc.mutate(
                { id: loc.id, status: loc.status === 'active' ? 'retired' : 'active' },
                { onError },
              )
            }
          />
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <Input
          aria-label="New location name"
          placeholder="Add a Location"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <Button onClick={add} disabled={!name.trim()}>
          Add
        </Button>
      </div>
    </Card>
  );
}

// ── Departments (each carries its Roles — R5) ─────────────────────────────────

function DepartmentsPanel({
  departments,
  onError,
}: {
  departments: TaxDepartment[];
  onError: (e: unknown) => void;
}) {
  const create = useCreateDepartment();
  const [name, setName] = useState('');

  function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    create.mutate({ name: trimmed }, { onSuccess: () => setName(''), onError });
  }

  return (
    <Card className="p-5">
      <h3 className="font-ui text-sm font-semibold">Departments</h3>
      <p className="mt-1 text-[12px] text-text-tertiary">
        A Role is created inside a Department, so add the Department first.
      </p>
      <div className="mt-3 flex flex-col gap-3">
        {departments.length === 0 && (
          <p className="text-[13px] text-text-tertiary">No Departments yet.</p>
        )}
        {departments.map((dep) => (
          <DepartmentCard key={dep.id} dep={dep} onError={onError} />
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <Input
          aria-label="New department name"
          placeholder="Add a Department"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <Button onClick={add} disabled={!name.trim()}>
          Add
        </Button>
      </div>
    </Card>
  );
}

function DepartmentCard({ dep, onError }: { dep: TaxDepartment; onError: (e: unknown) => void }) {
  const updateDep = useUpdateDepartment();
  const createRole = useCreateRole();
  const updateRole = useUpdateRole();
  const [roleName, setRoleName] = useState('');

  function addRole() {
    const trimmed = roleName.trim();
    if (!trimmed) return;
    createRole.mutate({ departmentId: dep.id, name: trimmed }, { onSuccess: () => setRoleName(''), onError });
  }

  const retired = dep.status === 'retired';
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <span className={`text-sm font-semibold ${retired ? 'text-text-tertiary line-through' : ''}`}>
          {dep.name}
        </span>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-[12px] text-text-secondary">
            Several Roles
            <Switch
              checked={dep.allowsMultipleRoles}
              aria-label={`${dep.name} allows several Roles`}
              onChange={(e) => updateDep.mutate({ id: dep.id, allowsMultipleRoles: e.target.checked }, { onError })}
            />
          </label>
          <StatusButton
            status={dep.status}
            onClick={() =>
              updateDep.mutate(
                { id: dep.id, status: retired ? 'active' : 'retired' },
                { onError },
              )
            }
          />
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-1 pl-3">
        {dep.roles.length === 0 && (
          <p className="text-[12px] text-text-tertiary">No Roles offered yet.</p>
        )}
        {dep.roles.map((role: TaxRole) => (
          <ValueRow
            key={role.id}
            name={role.name}
            status={role.status}
            dense
            onRename={(next) => updateRole.mutate({ id: role.id, name: next }, { onError })}
            onToggleStatus={() =>
              updateRole.mutate(
                { id: role.id, status: role.status === 'active' ? 'retired' : 'active' },
                { onError },
              )
            }
          />
        ))}
      </div>

      <div className="mt-2 flex gap-2 pl-3">
        <Input
          aria-label={`New role in ${dep.name}`}
          placeholder="Add a Role"
          value={roleName}
          onChange={(e) => setRoleName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addRole()}
        />
        <Button size="sm" onClick={addRole} disabled={!roleName.trim()}>
          Add Role
        </Button>
      </div>
    </div>
  );
}

// ── Shared row + status control ───────────────────────────────────────────────

function ValueRow({
  name,
  status,
  dense,
  onRename,
  onToggleStatus,
}: {
  name: string;
  status: 'active' | 'retired';
  dense?: boolean;
  onRename: (next: string) => void;
  onToggleStatus: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const retired = status === 'retired';

  return (
    <div className={`flex items-center justify-between gap-2 ${dense ? 'py-0.5' : 'py-1'}`}>
      {editing ? (
        <div className="flex flex-1 gap-2">
          <Input
            aria-label={`Rename ${name}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim()) {
                onRename(draft.trim());
                setEditing(false);
              }
              if (e.key === 'Escape') setEditing(false);
            }}
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (draft.trim()) onRename(draft.trim());
              setEditing(false);
            }}
          >
            Save
          </Button>
        </div>
      ) : (
        <span className={`flex items-center gap-2 text-[13px] ${retired ? 'text-text-tertiary line-through' : ''}`}>
          {name}
          {retired && <Badge variant="neutral">Retired</Badge>}
        </span>
      )}
      {!editing && (
        <div className="flex items-center gap-1">
          <button
            aria-label={`Rename ${name}`}
            className="grid h-7 w-7 place-items-center rounded text-text-tertiary hover:bg-surface-hover"
            onClick={() => {
              setDraft(name);
              setEditing(true);
            }}
          >
            <Icon name="pencil" size={13} />
          </button>
          <StatusButton status={status} onClick={onToggleStatus} />
        </div>
      )}
    </div>
  );
}

function StatusButton({ status, onClick }: { status: 'active' | 'retired'; onClick: () => void }) {
  return (
    <Button size="sm" variant="ghost" onClick={onClick}>
      {status === 'active' ? 'Retire' : 'Return'}
    </Button>
  );
}
