import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, Icon, Input, Select, Switch, useToast } from '@formai/ui';
import {
  DATE_FORMAT_LABELS,
  DISPLAY_IDENTIFIER_LABELS,
  type DateFormat,
  type DisplayIdentifier,
  type RequiredAssessmentsChangeEffects,
} from '@formai/shared';
import {
  useAssessmentTools,
  useCompetencies,
  useCreateCompetency,
  useCreateDepartment,
  useCreateLocation,
  useCreateRole,
  usePreviewLocationTransfer,
  usePreviewRoleRequiredAssessments,
  useRemoveLegacyRequirement,
  useResolveTightening,
  useRetirementReview,
  useRoleRequiredAssessments,
  useSetRoleRequiredAssessments,
  useStopOfferingRole,
  useTaxonomy,
  useTighteningReview,
  useTransferDepartment,
  useTransferLocation,
  useTransferRole,
  useUpdateDepartment,
  useUpdateLocation,
  useUpdateRole,
  useUpdateTaxonomySettings,
} from '../../lib/data/hooks.js';
import type {
  Competency,
  RetiredValueReview,
  Taxonomy,
  TaxDepartment,
  TaxLocation,
  TaxRole,
  TighteningReviewItem,
} from '../../lib/data/types.js';
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

      <RetirementReviewPanel taxonomy={data} onError={onError} />
      <SettingsPanel settings={data.settings} onError={onError} />
      <LocationsPanel locations={data.locations} onError={onError} />
      <DepartmentsPanel departments={data.departments} onError={onError} />
    </div>
  );
}

/**
 * The people still holding a retired value, and the ways out (U18). Shown only
 * when the review has anybody in it — a value returned to active empties it
 * (R123). Every axis offers a bulk transfer to a replacement; a Location transfer
 * additionally chooses what happens to in-flight cases (R133), while a Role or
 * Department transfer leaves cases untouched (R135).
 */
function RetirementReviewPanel({
  taxonomy,
  onError,
}: {
  taxonomy: Taxonomy;
  onError: (e: unknown) => void;
}) {
  const { data: review } = useRetirementReview();
  if (!review) return null;
  const total = review.locations.length + review.departments.length + review.roles.length;
  if (total === 0) return null;

  const activeLocations = taxonomy.locations.filter((l) => l.status === 'active');
  const activeRoles = taxonomy.departments.flatMap((d) => d.roles.filter((r) => r.status === 'active'));
  const activeDepartments = taxonomy.departments.filter((d) => d.status === 'active');

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <Icon name="shield-alert" size={16} className="text-warning-text" />
        <h3 className="font-ui text-sm font-semibold">Retired values still held</h3>
      </div>
      <p className="mt-1 text-[13px] text-text-tertiary">
        These values are retired but people still hold them. Move each person to a replacement, or
        handle them individually on the team screen.
      </p>

      <div className="mt-3 flex flex-col gap-3">
        {review.locations.map((value) => (
          <RetiredValueRow key={`loc-${value.id}`} label="Location" value={value}>
            <LocationTransferControl
              value={value}
              options={activeLocations}
              onError={onError}
            />
          </RetiredValueRow>
        ))}
        {review.roles.map((value) => (
          <RetiredValueRow key={`role-${value.id}`} label="Role" value={value}>
            <RoleTransferControl
              value={value}
              options={activeRoles.filter((r) => r.id !== value.id)}
              onError={onError}
            />
          </RetiredValueRow>
        ))}
        {review.departments.map((value) => (
          <RetiredValueRow key={`dep-${value.id}`} label="Department" value={value}>
            <DepartmentTransferControl
              value={value}
              options={activeDepartments.filter((d) => d.id !== value.id)}
              onError={onError}
            />
          </RetiredValueRow>
        ))}
      </div>
    </Card>
  );
}

/** One retired value in the review: its label, name, holder count, and a remediation control. */
function RetiredValueRow({
  label,
  value,
  children,
}: {
  label: string;
  value: RetiredValueReview;
  children: ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-sunken p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="text-[11px] uppercase tracking-wide text-text-tertiary">{label}</span>
          <div className="truncate text-[13px] font-semibold">{value.name}</div>
        </div>
        {children}
      </div>
      <div className="mt-1.5 text-[11px] text-text-tertiary">
        {value.holders.length} still holding: {value.holders.map((h) => h.name).join(', ')}
      </div>
    </div>
  );
}

/** Transfer everyone off a retired Location, choosing what its in-flight cases do (R133). */
function LocationTransferControl({
  value,
  options,
  onError,
}: {
  value: RetiredValueReview;
  options: TaxLocation[];
  onError: (e: unknown) => void;
}) {
  const { toast } = useToast();
  const preview = usePreviewLocationTransfer();
  const transfer = useTransferLocation();
  const replacements = options.filter((l) => l.id !== value.id);
  const [replacementId, setReplacementId] = useState(replacements[0]?.id ?? '');
  const [caseOutcome, setCaseOutcome] = useState<'carry' | 'rewrite'>('carry');
  const [inFlight, setInFlight] = useState<number | null>(null);

  if (replacements.length === 0) {
    return <span className="text-[11px] text-text-tertiary">Add an active Location to transfer to.</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select
        aria-label={`Replacement Location for ${value.name}`}
        value={replacementId}
        onChange={(e) => {
          setReplacementId(e.target.value);
          setInFlight(null);
        }}
        options={replacements.map((l) => ({ label: l.name, value: l.id }))}
      />
      <Select
        aria-label={`In-flight cases for ${value.name}`}
        value={caseOutcome}
        onChange={(e) => setCaseOutcome(e.target.value as 'carry' | 'rewrite')}
        options={[
          { label: 'Carry cases', value: 'carry' },
          { label: 'Rewrite cases', value: 'rewrite' },
        ]}
      />
      <Button
        size="sm"
        variant="ghost"
        disabled={!replacementId || preview.isPending}
        onClick={() =>
          preview.mutate(
            { locationId: value.id, replacementLocationId: replacementId },
            { onSuccess: (r) => setInFlight(r.inFlightCases), onError },
          )
        }
      >
        Preview
      </Button>
      {inFlight !== null && (
        <span className="text-[11px] text-text-tertiary">
          {value.holders.length} moved, {inFlight} in-flight
        </span>
      )}
      <Button
        size="sm"
        disabled={!replacementId || transfer.isPending}
        onClick={() =>
          transfer.mutate(
            { locationId: value.id, replacementLocationId: replacementId, caseOutcome },
            {
              onSuccess: () => toast({ variant: 'success', message: `Moved off ${value.name}.` }),
              onError,
            },
          )
        }
      >
        Transfer
      </Button>
    </div>
  );
}

/** Transfer everyone off a retired Role to a replacement; cases are left untouched (R135). */
function RoleTransferControl({
  value,
  options,
  onError,
}: {
  value: RetiredValueReview;
  options: TaxRole[];
  onError: (e: unknown) => void;
}) {
  const { toast } = useToast();
  const transfer = useTransferRole();
  const [replacementId, setReplacementId] = useState(options[0]?.id ?? '');

  if (options.length === 0) {
    return <span className="text-[11px] text-text-tertiary">Add an active Role to transfer to.</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select
        aria-label={`Replacement Role for ${value.name}`}
        value={replacementId}
        onChange={(e) => setReplacementId(e.target.value)}
        options={options.map((r) => ({ label: r.name, value: r.id }))}
      />
      <Button
        size="sm"
        disabled={!replacementId || transfer.isPending}
        onClick={() =>
          transfer.mutate(
            { roleId: value.id, replacementRoleId: replacementId },
            {
              onSuccess: () => toast({ variant: 'success', message: `Moved off ${value.name}.` }),
              onError,
            },
          )
        }
      >
        Transfer
      </Button>
    </div>
  );
}

/**
 * Transfer everyone off a retired Department to a replacement (R135). Each
 * person's placement moves to the replacement and the retired Department's held
 * Roles are withdrawn from them — they land in the new Department with no Roles,
 * to be given its Roles on the team screen. Cases are left untouched, as with a
 * Role transfer, so there is no case-outcome choice here.
 */
function DepartmentTransferControl({
  value,
  options,
  onError,
}: {
  value: RetiredValueReview;
  options: TaxDepartment[];
  onError: (e: unknown) => void;
}) {
  const { toast } = useToast();
  const transfer = useTransferDepartment();
  const [replacementId, setReplacementId] = useState(options[0]?.id ?? '');

  if (options.length === 0) {
    return <span className="text-[11px] text-text-tertiary">Add an active Department to transfer to.</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select
        aria-label={`Replacement Department for ${value.name}`}
        value={replacementId}
        onChange={(e) => setReplacementId(e.target.value)}
        options={options.map((d) => ({ label: d.name, value: d.id }))}
      />
      <Button
        size="sm"
        disabled={!replacementId || transfer.isPending}
        onClick={() =>
          transfer.mutate(
            { departmentId: value.id, replacementDepartmentId: replacementId },
            {
              onSuccess: () => toast({ variant: 'success', message: `Moved off ${value.name}.` }),
              onError,
            },
          )
        }
      >
        Transfer
      </Button>
    </div>
  );
}

// ── Organisation settings (R24, R25, R40) ────────────────────────────────────

function SettingsPanel({
  settings,
  onError,
}: {
  settings: {
    allowMultipleLocations: boolean;
    allowMultipleDepartments: boolean;
    allowSelfAssessment: boolean;
    displayIdentifier: DisplayIdentifier;
    pooledCaseOverdueDays: number;
    notificationLeadDays: number;
    dateFormat: DateFormat;
    candidateSelfStartRecommended: boolean;
  };
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
            Assessors can assess themselves
            <span className="block text-[12px] text-text-tertiary">
              A qualified assessor may run and sign off their own case. Off, nobody certifies
              themselves.
            </span>
          </span>
          <Switch
            checked={settings.allowSelfAssessment}
            aria-label="Assessors can assess themselves"
            onChange={(e) => update.mutate({ allowSelfAssessment: e.target.checked }, { onError })}
          />
        </label>
        <label className="flex items-center justify-between gap-4">
          <span className="text-sm">
            Candidates can self-start recommended training
            <span className="block text-[12px] text-text-tertiary">
              Adds a request button beside a Role&rsquo;s recommendations (R14). Off, the
              recommendation is still visible — assessors and admins can always assign it, and a
              required gap can always be requested.
            </span>
          </span>
          <Switch
            checked={settings.candidateSelfStartRecommended}
            aria-label="Candidates can self-start recommended training"
            onChange={(e) =>
              update.mutate({ candidateSelfStartRecommended: e.target.checked }, { onError })
            }
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
        <label className="flex items-center justify-between gap-4">
          <span className="text-sm">
            Read an ambiguous date as
            <span className="block text-[12px] text-text-tertiary">
              Applies to a slash-separated date, such as an imported grant date.
            </span>
          </span>
          <div className="w-56">
            <Select
              aria-label="Date format"
              value={settings.dateFormat}
              options={(Object.keys(DATE_FORMAT_LABELS) as DateFormat[]).map((format) => ({
                value: format,
                label: DATE_FORMAT_LABELS[format],
              }))}
              onChange={(e) => update.mutate({ dateFormat: e.target.value as DateFormat }, { onError })}
            />
          </div>
        </label>
        <label className="flex items-center justify-between gap-4">
          <span className="text-sm">
            A pooled case is overdue after
            <span className="block text-[12px] text-text-tertiary">
              Days waiting in the shared queue before it is flagged.
            </span>
          </span>
          <div className="flex w-56 items-center gap-2">
            <Input
              type="number"
              min={1}
              max={365}
              aria-label="Pooled case overdue days"
              defaultValue={settings.pooledCaseOverdueDays}
              onBlur={(e) => {
                const value = Number(e.target.value);
                if (Number.isInteger(value) && value >= 1 && value <= 365 && value !== settings.pooledCaseOverdueDays) {
                  update.mutate({ pooledCaseOverdueDays: value }, { onError });
                }
              }}
            />
            <span className="text-[12px] text-text-tertiary">days</span>
          </div>
        </label>
        <label className="flex items-center justify-between gap-4">
          <span className="text-sm">
            Notify a person before an expiry
            <span className="block text-[12px] text-text-tertiary">
              Days ahead of a competency lapsing that the sweep warns its holder.
            </span>
          </span>
          <div className="flex w-56 items-center gap-2">
            <Input
              type="number"
              min={1}
              max={365}
              aria-label="Notification lead days"
              defaultValue={settings.notificationLeadDays}
              onBlur={(e) => {
                const value = Number(e.target.value);
                if (Number.isInteger(value) && value >= 1 && value <= 365 && value !== settings.notificationLeadDays) {
                  update.mutate({ notificationLeadDays: value }, { onError });
                }
              }}
            />
            <span className="text-[12px] text-text-tertiary">days</span>
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
  const stopOffering = useStopOfferingRole();
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
          <div key={role.id}>
            <ValueRow
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
              // Stop offering is a HARDER act than retire: it withdraws the Role
              // from everyone who holds it, no choice (R52), where retire leaves
              // them holding it. Distinct action, distinct label.
              extraAction={{
                label: 'Stop offering',
                onClick: () => stopOffering.mutate(role.id, { onError }),
              }}
            />
            <RoleRequirements role={role} onError={onError} />
          </div>
        ))}
      </div>

      {/* Tightening a Department to one Role leaves people holding several — a
          resumable per-person choice (R112). Shown only while the Department is
          set to a single Role. */}
      {!dep.allowsMultipleRoles && <TighteningReview dep={dep} onError={onError} />}

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

/**
 * The people a tightening still has to resolve (U17, R112). A LIVE list: each
 * person drops off the moment their choice is applied, and an Admin can leave
 * and come back — nothing is a half-finished wizard. Rendered only while the
 * Department offers a single Role and someone still holds several of its Roles.
 */
function TighteningReview({ dep, onError }: { dep: TaxDepartment; onError: (e: unknown) => void }) {
  const { data: affected } = useTighteningReview(dep.id);

  if (!affected || affected.length === 0) return null;

  return (
    <div className="mt-3 rounded-md border border-border bg-surface-sunken p-3">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-warning-text">
        <Icon name="shield-alert" size={13} />
        {affected.length} {affected.length === 1 ? 'person holds' : 'people hold'} several Roles here
      </div>
      <p className="mt-1 text-[11px] text-text-tertiary">
        {dep.name} now offers a single Role. Choose the Role each person keeps — the rest are
        withdrawn from them. You can come back to this later.
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {affected.map((person) => (
          <TighteningRow key={person.membershipId} dep={dep} person={person} onError={onError} />
        ))}
      </ul>
    </div>
  );
}

/** One person in a tightening review: pick the Role they keep, apply the choice (R113). */
function TighteningRow({
  dep,
  person,
  onError,
}: {
  dep: TaxDepartment;
  person: TighteningReviewItem;
  onError: (e: unknown) => void;
}) {
  const resolve = useResolveTightening(dep.id);
  const { toast } = useToast();
  const [survivingRoleId, setSurvivingRoleId] = useState(person.heldRoles[0]?.id ?? '');

  return (
    <li className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{person.name}</span>
      <Select
        aria-label={`Role ${person.name} keeps`}
        value={survivingRoleId}
        onChange={(e) => setSurvivingRoleId(e.target.value)}
        options={person.heldRoles.map((role) => ({ label: role.name, value: role.id }))}
      />
      <Button
        size="sm"
        disabled={!survivingRoleId || resolve.isPending}
        onClick={() =>
          resolve.mutate(
            { membershipId: person.membershipId, survivingRoleId },
            {
              onSuccess: () =>
                toast({ variant: 'success', message: `${person.name}’s Roles resolved.` }),
              onError,
            },
          )
        }
      >
        Keep
      </Button>
    </li>
  );
}

// ── A Role's requirements, in COMPETENCY terms (U6 — R5, R6, R8, KTD9) ───────

type RequirementTier = 'required' | 'recommended';

/**
 * The competencies a Role requires and recommends (R5, R6). Collapsed by
 * default — a Department can offer many Roles and each carries its own editor.
 * `configured` is read straight from the server so "nobody has set this up"
 * and "set up, requires nothing" read apart (R50) — and it follows the
 * REQUIRED tier alone: a recommended-only save leaves a fresh Role reading
 * never-configured (KTD9).
 *
 * REQUIRED edits travel preview → confirm (R8): the blast radius is shown in
 * competency terms before anything lands. RECOMMENDED-only edits save
 * directly — the tier enforces nothing, so there is no blast radius to
 * confirm (R13). Every write echoes the GET's fingerprint; a 409
 * `requirements_changed` means someone else's change (a backfill conversion,
 * another editor) landed in between, and the editor reloads rather than
 * silently overwriting it (KTD9).
 *
 * A retired Role is shown read-only (R121) — the server enforces the same,
 * this just does not offer the action.
 */
function RoleRequirements({ role, onError }: { role: TaxRole; onError: (e: unknown) => void }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const { data: competencies } = useCompetencies();
  // Tool NAMES for the awaitingLink rows — a legacy row is a tool id, and the
  // editor must not print raw ids.
  const { data: tools } = useAssessmentTools();
  const requirements = useRoleRequiredAssessments(open ? role.id : undefined);
  const current = requirements.data;
  const preview = usePreviewRoleRequiredAssessments(role.id);
  const save = useSetRoleRequiredAssessments(role.id);
  const removeLegacy = useRemoveLegacyRequirement(role.id);
  const create = useCreateCompetency();

  const [draft, setDraft] = useState<{ required: Set<string>; recommended: Set<string> } | null>(
    null,
  );
  // The blast radius of the pending REQUIRED change, once previewed — the
  // confirmation gate (R8, R84–R86). Null means nothing awaits confirmation.
  const [pending, setPending] = useState<RequiredAssessmentsChangeEffects | null>(null);
  // An awaitingLink removal awaiting its confirm — previewed through the same
  // door (KTD9, KTD10).
  const [pendingRemove, setPendingRemove] = useState<{
    toolId: string;
    effects: RequiredAssessmentsChangeEffects;
  } | null>(null);
  // Set when a write 409'd `requirements_changed`: the editor reloaded and the
  // admin re-decides against the fresh state rather than over someone else's
  // change (KTD9).
  const [stale, setStale] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCode, setNewCode] = useState('');
  /**
   * Competencies created inline, kept locally so they are pickable BEFORE the
   * register cache refetches — the same posture the backfill row takes.
   */
  const [createdLocal, setCreatedLocal] = useState<Competency[]>([]);

  const selected = draft ?? {
    required: new Set(current?.required ?? []),
    recommended: new Set(current?.recommended ?? []),
  };
  const dirty = draft !== null;
  const retired = role.status === 'retired';
  const sameSet = (a: ReadonlySet<string>, b: readonly string[]) =>
    a.size === b.length && b.every((id) => a.has(id));
  // Only a REQUIRED-tier change carries a blast radius; a recommended-only
  // edit saves without a preview (R13).
  const requiredChanged = dirty && current !== undefined && !sameSet(selected.required, current.required);

  const register = competencies ?? [];
  const options = [...register, ...createdLocal.filter((c) => !register.some((r) => r.id === c.id))];

  function resetFlow() {
    setPending(null);
    setPendingRemove(null);
  }

  function toggle(tier: RequirementTier, competencyId: string) {
    // Changing the selection abandons any preview shown for the old selection.
    resetFlow();
    setDraft((prev) => {
      const base = prev ?? {
        required: new Set(current?.required ?? []),
        recommended: new Set(current?.recommended ?? []),
      };
      const next = { required: new Set(base.required), recommended: new Set(base.recommended) };
      const other: RequirementTier = tier === 'required' ? 'recommended' : 'required';
      if (next[tier].has(competencyId)) {
        next[tier].delete(competencyId);
      } else {
        next[tier].add(competencyId);
        /*
          THE CLIENT-SIDE OVERLAP BLOCK: one row per (role, competency) — the
          tier is a column (KTD1), so a competency cannot be both. Selecting it
          in one tier moves it out of the other, structurally, instead of
          letting the save find the 400 `tiers_overlap`.
        */
        next[other].delete(competencyId);
      }
      return next;
    });
  }

  /** A write refused because the requirements moved underneath us (KTD9). */
  function isStaleWrite(err: unknown): boolean {
    return (
      err instanceof ApiError &&
      err.status === 409 &&
      (err.body as { error?: string } | undefined)?.error === 'requirements_changed'
    );
  }

  function onWriteError(err: unknown) {
    if (isStaleWrite(err)) {
      // Reload the editor: the fresh GET carries the other change and a new
      // fingerprint, and the notice explains why the draft was dropped.
      setStale(true);
      setDraft(null);
      resetFlow();
      void requirements.refetch();
      return;
    }
    onError(err);
  }

  function onReview() {
    // The blast radius before committing (R8, R84, R85), in competency terms;
    // nothing is written until confirmed.
    resetFlow();
    preview.mutate(
      { required: [...selected.required], recommended: [...selected.recommended] },
      { onSuccess: (r) => setPending(r.effects), onError },
    );
  }

  function doSave() {
    if (!current) return;
    save.mutate(
      {
        required: [...selected.required],
        recommended: [...selected.recommended],
        fingerprint: current.fingerprint,
      },
      {
        onSuccess: () => {
          setDraft(null);
          resetFlow();
          setStale(false);
          toast({ variant: 'success', message: 'Requirements updated.' });
        },
        onError: onWriteError,
      },
    );
  }

  function onRemoveLegacy(toolId: string) {
    if (!current) return;
    // The awaitingLink exit previews through the SAME preview POST (KTD9):
    // current tiers unchanged, this one legacy row removed.
    resetFlow();
    preview.mutate(
      {
        required: current.required,
        recommended: current.recommended,
        removeLegacyToolIds: [toolId],
      },
      { onSuccess: (r) => setPendingRemove({ toolId, effects: r.effects }), onError },
    );
  }

  function onConfirmRemove() {
    if (!current || !pendingRemove) return;
    removeLegacy.mutate(
      { toolId: pendingRemove.toolId, fingerprint: current.fingerprint },
      {
        onSuccess: () => {
          resetFlow();
          setStale(false);
          toast({ variant: 'success', message: 'Legacy requirement removed.' });
        },
        onError: onWriteError,
      },
    );
  }

  function onCreate(tier: RequirementTier) {
    const trimmedName = newName.trim();
    if (!trimmedName) {
      toast({ variant: 'warning', message: 'A competency needs a name.' });
      return;
    }
    create.mutate(
      // No validity asked here — every competency starts perpetual, and the
      // register's validity editor is where expiry gets decided. This flow's
      // job is naming the requirement without leaving it (R5).
      { name: trimmedName, code: newCode.trim() || null, validForMonths: null, gracePeriodDays: null },
      {
        onSuccess: (added) => {
          setCreatedLocal((prev) => [...prev, added]);
          toggle(tier, added.id);
          setCreating(false);
          setNewName('');
          setNewCode('');
          toast({ variant: 'success', message: `${added.name} added to the register.` });
        },
        onError: () => toast({ variant: 'warning', message: 'Could not add the competency.' }),
      },
    );
  }

  const summary = !current
    ? ''
    : !current.configured
      ? 'not set up'
      : current.required.length === 0
        ? 'requires nothing'
        : `${current.required.length} required${
            current.recommended.length > 0 ? ` · ${current.recommended.length} recommended` : ''
          }`;

  const chip = (tier: RequirementTier, c: Competency) => {
    const on = selected[tier].has(c.id);
    return (
      <button
        key={c.id}
        type="button"
        aria-pressed={on}
        aria-label={`${tier === 'required' ? 'Require' : 'Recommend'} ${c.name} for ${role.name}`}
        disabled={retired}
        onClick={() => toggle(tier, c.id)}
        className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[11px] font-medium transition-colors ${
          on
            ? 'border-success bg-success-soft text-success-text'
            : 'border-border bg-surface-card text-text-tertiary'
        } ${retired ? 'cursor-default opacity-60' : 'cursor-pointer'}`}
      >
        {c.name}
        {c.code && <span className="font-mono text-[9.5px] uppercase opacity-70">{c.code}</span>}
      </button>
    );
  };

  return (
    <div className="pl-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Requirements for ${role.name}`}
        className="flex items-center gap-1.5 py-0.5 text-[11.5px] text-text-tertiary hover:text-text-secondary"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
        Required competencies{summary ? ` · ${summary}` : ''}
      </button>

      {open && (
        <div className="mb-1 mt-1 rounded-md border border-border bg-surface-sunken p-2.5">
          {retired && (
            <p className="mb-1.5 text-[11px] text-text-tertiary">
              A retired Role takes on no new requirements.
            </p>
          )}
          {stale && (
            <p className="mb-1.5 rounded-sm border border-warning bg-warning-soft p-[6px_8px] text-[11px] text-warning-text">
              Requirements changed elsewhere — this editor reloaded with the latest state. Re-apply
              your change if it still applies.
            </p>
          )}

          {options.length === 0 ? (
            <p className="text-[11.5px] text-text-tertiary">
              No competencies on the register yet — create one below.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <div>
                <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-text-tertiary">
                  Required — compliance-tracked (R5)
                </div>
                <div className="flex flex-wrap gap-1.5">{options.map((c) => chip('required', c))}</div>
              </div>
              <div>
                <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-text-tertiary">
                  Recommended — worth holding, never enforced (R6, R13)
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {options.map((c) => chip('recommended', c))}
                </div>
              </div>
            </div>
          )}

          {!retired && (
            <div className="mt-2">
              {creating ? (
                <div className="flex flex-wrap items-end gap-2 border-t border-border-subtle pt-2">
                  <div className="min-w-[180px] flex-1">
                    <Input
                      label="Competency name"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                    />
                  </div>
                  <div className="w-[130px]">
                    <Input
                      label="Code (optional)"
                      placeholder="Q34666893"
                      value={newCode}
                      onChange={(e) => setNewCode(e.target.value)}
                    />
                  </div>
                  <Button size="sm" onClick={() => onCreate('required')} disabled={create.isPending}>
                    Create &amp; require
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onCreate('recommended')}
                    disabled={create.isPending}
                  >
                    Create &amp; recommend
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <button
                  onClick={() => setCreating(true)}
                  aria-label={`Create a competency for ${role.name}`}
                  className="fai-chip-btn inline-flex items-center gap-1 rounded-sm py-1 text-[11px] font-medium text-text-accent hover:underline"
                >
                  <Icon name="plus" size={12} />
                  Create competency
                </button>
              )}
            </div>
          )}

          {/* Legacy rows still deriving the old way (R15, KTD9): each exits via
              the backfill (link the award on the register) or the explicit,
              previewed remove below. */}
          {current && current.awaitingLink.length > 0 && (
            <div className="mt-2 border-t border-border-subtle pt-2">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-warning-text">
                <Icon name="shield-alert" size={12} />
                Awaiting link — still counted the old way
              </div>
              <p className="mt-0.5 text-[10.5px] text-text-tertiary">
                These assessments award nothing yet, so this Role still requires them as tools.
                Link each one to its competency on the register, or remove the requirement.
              </p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {current.awaitingLink.map((toolId) => {
                  const name = (tools ?? []).find((t) => t.id === toolId)?.name ?? 'Unknown assessment';
                  return (
                    <li key={toolId} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-[11.5px] font-medium">{name}</span>
                      <span className="flex flex-none items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Link the award for ${name}`}
                          onClick={() => navigate('/app/competency')}
                        >
                          Link the award
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Remove legacy requirement ${name}`}
                          disabled={dirty || preview.isPending}
                          onClick={() => onRemoveLegacy(toolId)}
                        >
                          Remove
                        </Button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {!retired && (
            <div className="mt-2 flex flex-col gap-2">
              {pendingRemove ? (
                <div className="rounded-md border border-border-accent bg-surface-accent-soft p-[9px_11px] text-[11.5px] text-text-secondary">
                  <EffectsSummary effects={pendingRemove.effects} />
                  <div className="mt-2 flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={resetFlow}
                      disabled={removeLegacy.isPending}
                    >
                      Cancel
                    </Button>
                    <Button size="sm" onClick={onConfirmRemove} disabled={removeLegacy.isPending}>
                      Confirm removal
                    </Button>
                  </div>
                </div>
              ) : pending ? (
                <div className="rounded-md border border-border-accent bg-surface-accent-soft p-[9px_11px] text-[11.5px] text-text-secondary">
                  <EffectsSummary effects={pending} />
                  <div className="mt-2 flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={resetFlow} disabled={save.isPending}>
                      Cancel
                    </Button>
                    <Button size="sm" onClick={doSave} disabled={save.isPending}>
                      Confirm change
                    </Button>
                  </div>
                </div>
              ) : requiredChanged ? (
                <div className="flex justify-end">
                  <Button size="sm" onClick={onReview} disabled={preview.isPending}>
                    Review change
                  </Button>
                </div>
              ) : (
                <div className="flex justify-end">
                  {/* A recommended-only edit enforces nothing, so it saves
                      without the preview gate (R13). */}
                  <Button size="sm" onClick={doSave} disabled={!dirty || save.isPending}>
                    {dirty ? 'Save' : 'Saved'}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The blast radius of a pending requirement change, in COMPETENCY terms (U6).
 * An addition says who it affects and how many cases the awarding assessments
 * create (R84) — an evidence-only competency contributes "0 cases", which is a
 * real answer (R7). A removal says who it affects, how many cases already in
 * progress run to completion, and how many standings become optional (R85) —
 * never a creation count. A save that both adds and removes shows both, and an
 * awaitingLink removal of an UNLINKED tool (no competency moves at all) still
 * names its continuing cases.
 */
function EffectsSummary({ effects }: { effects: RequiredAssessmentsChangeEffects }) {
  const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
  const cases = (n: number) => `${n} ${n === 1 ? 'case' : 'cases'}`;
  const competencies = (n: number) => `${n} ${n === 1 ? 'competency' : 'competencies'}`;
  const lines: string[] = [];
  if (effects.addedCompetencyIds.length > 0) {
    lines.push(
      `Adds ${competencies(effects.addedCompetencyIds.length)}: affects ${people(effects.affected)}, creating ${cases(effects.created)}.`,
    );
  }
  if (effects.removedCompetencyIds.length > 0) {
    const demoting = effects.competenciesDemoting;
    lines.push(
      `Removes ${competencies(effects.removedCompetencyIds.length)}: affects ${people(effects.affected)}. ` +
        `${cases(effects.inFlightContinuing)} already in progress will run to completion, and ` +
        `${demoting} competency standing${demoting === 1 ? '' : 's'} become optional.`,
    );
  }
  if (lines.length === 0 && effects.inFlightContinuing > 0) {
    // The unlinked-legacy removal: the tool awarded nothing, so no competency
    // leaves required standing — but its cases keep running (R55).
    lines.push(
      `${cases(effects.inFlightContinuing)} already in progress will run to completion; nothing new is created.`,
    );
  }
  if (lines.length === 0) lines.push('This changes nothing.');
  return (
    <div className="flex flex-col gap-1">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
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
  extraAction,
}: {
  name: string;
  status: 'active' | 'retired';
  dense?: boolean;
  onRename: (next: string) => void;
  onToggleStatus: () => void;
  /** An extra action shown only while the value is active — e.g. a Role's "Stop offering" (U17). */
  extraAction?: { label: string; onClick: () => void };
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
          {extraAction && !retired && (
            <Button size="sm" variant="ghost" onClick={extraAction.onClick}>
              {extraAction.label}
            </Button>
          )}
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
