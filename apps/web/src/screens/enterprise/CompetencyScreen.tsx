import { useState } from 'react';
import { describeValidity, type CompetencyStatus, type Standing } from '@formai/shared';
import { Badge, Button, Icon, Input, Select, Switch, useToast, type BadgeVariant } from '@formai/ui';
import type { AwardLinkEffects, Competency, UnlinkedTool } from '../../lib/data/types.js';
import { useForm, useForms } from '../../lib/data/hooks.js';
import {
  useAddRule,
  useApplyAwardLink,
  useCompetencies,
  useCompetencyHolders,
  useCompetencyRules,
  useCreateCompetency,
  useGrantCompetency,
  useMembers,
  usePreviewAwardLink,
  useRemoveRule,
  useSession,
  useSetCompetencyValidity,
  useToggleRule,
  useUnlinkedTools,
} from '../../lib/data/hooks.js';
import { useInlineCompetencyCreate } from '../../lib/data/use-inline-competency-create.js';
import { sourcesLine } from '../../lib/competency-sources.js';

/**
 * How each status reads, and how loudly.
 *
 * `grace` is deliberately a WARNING and not a danger: the person still counts,
 * they are inside the window the authority allows for requalifying, and
 * colouring it like a lapse would send someone to stand a worker down who is
 * entitled to keep working. `expiring` is the same colour because it calls for
 * the same action — book them — just with more runway.
 *
 * `undated` is neutral, not a warning: the person genuinely holds this (they
 * count, same as `held`), the record is just missing a date to derive currency
 * from. Colouring it like a lapse would misread a record-keeping gap as a
 * qualification problem.
 */
const STATUS_STYLE: Record<CompetencyStatus, { label: string; variant: BadgeVariant }> = {
  held: { label: 'Current', variant: 'success' },
  expiring: { label: 'Expiring', variant: 'warning' },
  grace: { label: 'In grace', variant: 'warning' },
  expired: { label: 'Expired', variant: 'danger' },
  undated: { label: 'Undated', variant: 'neutral' },
};

/**
 * How each STANDING reads on the register (U7, KTD7) — an EXHAUSTIVE map over
 * the union, not a two-branch ternary. The ternary this replaces rendered the
 * recommended tier as "Optional", which is exactly the by-omission collapse
 * KTD7's required third argument exists to make impossible: a tier the type
 * grows next lands here as a compile error, never as a silently wrong label.
 * Required is the compliance-bearing tier, so it is the louder mark;
 * recommended sits between required and optional in visibility only (R12, R13).
 */
const STANDING_LABEL: Record<Standing, { label: string; className: string }> = {
  required: { label: 'Required', className: 'text-text-secondary' },
  recommended: { label: 'Recommended', className: 'text-text-secondary' },
  optional: { label: 'Optional', className: 'text-text-tertiary' },
};

/** ISO instant → the date alone. Nobody schedules requalification by the hour. */
function onDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

/**
 * Record a grant by hand.
 *
 * `POST /competencies/:id/holders` predates this control and had no client
 * caller, so the only way anyone could come to hold a competency was signing
 * off an assessment that awards it. A PREREQUISITE competency — a driver's
 * licence sighted at induction, a ticket earned with a previous employer — is
 * precisely the kind nobody ever earns here, which left every prerequisite
 * check permanently unsatisfiable: the box read "missing" forever and sign-off
 * refused forever. This is the missing entry point.
 */
function GrantControl({ competency }: { competency: Competency }) {
  const { toast } = useToast();
  const { data: members = [] } = useMembers();
  const grant = useGrantCompetency(competency.id);
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState('');
  const [expires, setExpires] = useState('');

  // A grant is recorded against the USER, and a pending invite has no user
  // yet — there is nothing to attach one to until the invite is accepted.
  const grantable = members.flatMap((m) => (m.userId ? [{ userId: m.userId, name: m.name }] : []));

  function reset() {
    setUserId('');
    setExpires('');
    setOpen(false);
  }

  function onGrant() {
    if (!userId) {
      toast({ variant: 'warning', message: 'Pick who holds it.' });
      return;
    }
    const holder = grantable.find((m) => m.userId === userId);
    grant.mutate(
      {
        userId,
        // End of day, so a licence stays valid THROUGH its printed expiry date
        // instead of lapsing the midnight that date begins.
        ...(expires ? { expiresAt: `${expires}T23:59:59.000Z` } : {}),
      },
      {
        onSuccess: () => {
          toast({
            variant: 'success',
            message: holder
              ? `${holder.name} now holds ${competency.name}.`
              : `Granted ${competency.name}.`,
          });
          reset();
        },
        onError: () => {
          toast({ variant: 'danger', message: 'Could not record the grant.' });
        },
      },
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fai-chip-btn mt-2 inline-flex items-center gap-1 rounded-sm text-[11px] font-medium text-text-accent hover:underline"
      >
        <Icon name="plus" size={12} />
        Record a holder by hand
      </button>
    );
  }

  return (
    <div className="mt-2.5 flex flex-col gap-2 border-t border-border-subtle pt-2.5">
      <Select
        label="Person"
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
        options={[
          { value: '', label: '— pick a person —' },
          ...grantable.map((m) => ({ value: m.userId, label: m.name })),
        ]}
      />
      <Input
        label="Expires (optional)"
        type="date"
        value={expires}
        onChange={(e) => setExpires(e.target.value)}
      />
      <p className="text-[11px] text-text-tertiary">
        Leave the date blank to follow this competency's own validity. Set it when the record has
        its own end date — a licence, a ticket earned elsewhere.
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={onGrant} disabled={grant.isPending}>
          Grant
        </Button>
        <Button size="sm" variant="ghost" onClick={reset}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Who holds this competency, and who has let it lapse.
 *
 * `Competency.holders` can say "12 people hold this" but never which twelve,
 * and being a stored count of grants it cannot say how many are still in date.
 * So an admin could set a validity and then have no way to see who it had just
 * lapsed — this is the answer to that.
 *
 * The order comes from the API and is not re-sorted here: expired first, then
 * grace, then expiring, then current, nearest date leading within each group.
 * The reason to open this list is to find who needs booking.
 */
function HolderRegister({ competency }: { competency: Competency }) {
  const { data: holders, isLoading, isError } = useCompetencyHolders(competency.id);

  if (isLoading) {
    return <div className="px-[18px] pb-3 text-[11px] text-text-tertiary">Loading holders…</div>;
  }
  if (isError) {
    /*
      No grant control on this branch: an errored fetch means the register
      cannot say whether the person already holds it, and "grant into the
      unknown" is how duplicate evidence references happen. Fix the load first.
    */
    return (
      <div className="px-[18px] pb-3 text-[11px] text-danger-text">
        Could not load who holds this.
      </div>
    );
  }
  if (!holders || holders.length === 0) {
    return (
      <div className="border-t border-border-subtle bg-surface-sunken px-[18px] py-2.5">
        <div className="text-[11px] text-text-tertiary">
          Nobody holds this yet. Signing off an assessment that awards it grants it automatically,
          or record a holder by hand — a licence sighted at induction, a ticket earned elsewhere.
        </div>
        <GrantControl competency={competency} />
      </div>
    );
  }

  const lapsed = holders.filter((h) => !h.current).length;

  return (
    <div className="border-t border-border-subtle bg-surface-sunken px-[18px] py-2.5">
      {lapsed > 0 && (
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-danger-text">
          <Icon name="shield-alert" size={12} />
          {lapsed} of {holders.length} no longer current
        </div>
      )}
      <ul className="flex flex-col gap-1.5">
        {holders.map((h) => {
          const style = STATUS_STYLE[h.status];
          // Grace counts as current but its date HAS passed, which is exactly
          // what distinguishes it from expiring.
          const past = h.status === 'expired' || h.status === 'grace';
          return (
            <li key={h.userId} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium">{h.name}</div>
                <div className="text-[10.5px] text-text-tertiary">
                  {/*
                    REVOKED SAYS SO PLAINLY. A revoked grant's date is moot — it
                    was taken away regardless — so the sub-line names the act
                    rather than an expiry that no longer decides anything.

                    UNDATED NEXT, and named for what it actually is — missing a
                    grant date, not missing an expiry. Both end up with no
                    `expiresAt`, but "No expiry set" on an undated record would
                    read as "this never expires", which is a claim the product
                    cannot make without a date to derive from.

                    Otherwise PAST TENSE FOR A DATE THAT HAS PASSED. "Expires
                    2025-01-15" against a lapsed ticket reads as a future event,
                    and the badge beside it having to correct that is one glance
                    too many on a register whose whole job is telling you who is
                    qualified right now. And no date at all on a perpetual
                    competency: an expiry that does not exist should say so, not
                    print a dash the reader has to interpret.
                  */}
                  {h.revoked
                    ? 'Revoked'
                    : h.status === 'undated'
                      ? 'Not yet dated'
                      : !h.expiresAt
                        ? 'No expiry set'
                        : `${past ? 'Expired' : 'Expires'} ${onDate(h.expiresAt)}`}
                </div>
                {/*
                  WHY it stands for this holder (R5, U8): the scopes that
                  require/recommend the viewed competency of them — a member
                  under a location AND a role requirement shows both, comma-
                  joined. Absent where the API withheld sources (the same
                  per-holder gate as the licence columns) — no line, no guess.
                */}
                {sourcesLine(h.standing, h.sources) && (
                  <div className="text-[10.5px] text-text-tertiary">
                    {sourcesLine(h.standing, h.sources)}
                  </div>
                )}
              </div>
              {/*
                STANDING AND CURRENCY, TWO MARKS (R108). Standing — required,
                recommended or optional for this person's Roles — sits beside
                the currency badge, because they answer different questions:
                obligation versus the date. A required competency is the one
                that counts against compliance when it lapses, so it is the
                louder mark; a recommended one is visible and never enforced
                (R12, R13). The map is exhaustive over the union (KTD7).
              */}
              <span
                className={`text-[10px] font-medium uppercase tracking-wide ${STANDING_LABEL[h.standing].className}`}
              >
                {STANDING_LABEL[h.standing].label}
              </span>
              {/*
                Revocation is a MARK, not a status (R104): a revoked grant still
                has a dated state, but what the reader needs to see is that it
                was taken away, so the neutral revoked badge replaces the dated
                one rather than sitting beside it.
              */}
              {h.revoked ? (
                <Badge variant="neutral" dot>
                  Revoked
                </Badge>
              ) : (
                <Badge variant={style.variant} dot>
                  {style.label}
                </Badge>
              )}
            </li>
          );
        })}
      </ul>
      <GrantControl competency={competency} />
    </div>
  );
}

/**
 * How long one competency stays valid, editable in place.
 *
 * This is where expiry becomes real: every competency starts perpetual, and a
 * saved validity applies IMMEDIATELY to everyone who already holds it, because
 * expiry counts from each person's own grant date rather than from today. So
 * setting "3 years" on a ticket the workforce earned years ago lapses the ones
 * that genuinely lapsed — which is the point, and worth saying out loud before
 * an admin presses save.
 *
 * Blank means never expires. Not zero, not "expires today" — a competency
 * nobody has stated a validity for behaves exactly as it did before any of this
 * existed.
 */
type ValidityParse =
  | { ok: true; validForMonths: number | null; gracePeriodDays: number | null }
  | { ok: false; message: string };

/**
 * Years and grace as an admin types them, or what is wrong with them.
 *
 * Shared by the editor and the create form so the two cannot come to disagree
 * about what a blank means. Blank years is a PERPETUAL competency — not zero,
 * not "expires today" — and a grace period with no validity has nothing to be
 * grace for, so it is dropped rather than stored against an expiry that will
 * never arrive.
 */
function parseValidity(years: string, grace: string): ValidityParse {
  const typedYears = years.trim();
  const parsedYears = typedYears === '' ? null : Number(typedYears);
  if (parsedYears !== null && (!Number.isInteger(parsedYears) || parsedYears < 1 || parsedYears > 50)) {
    return { ok: false, message: 'Enter a whole number of years, or leave it blank for no expiry.' };
  }

  const typedGrace = grace.trim();
  const parsedGrace = typedGrace === '' ? null : Number(typedGrace);
  if (parsedGrace !== null && (!Number.isInteger(parsedGrace) || parsedGrace < 0 || parsedGrace > 365)) {
    return { ok: false, message: 'A grace period is a whole number of days, up to 365.' };
  }

  return {
    ok: true,
    validForMonths: parsedYears === null ? null : parsedYears * 12,
    gracePeriodDays: parsedYears === null ? null : parsedGrace,
  };
}

function ValidityEditor({ competency }: { competency: Competency }) {
  const { toast } = useToast();
  const save = useSetCompetencyValidity();
  const [editing, setEditing] = useState(false);
  const [years, setYears] = useState('');
  const [grace, setGrace] = useState('');

  function open() {
    const months = competency.validForMonths;
    setYears(months && months % 12 === 0 ? String(months / 12) : '');
    setGrace(competency.gracePeriodDays ? String(competency.gracePeriodDays) : '');
    setEditing(true);
  }

  function onSave() {
    const parsed = parseValidity(years, grace);
    if (!parsed.ok) {
      toast({ variant: 'warning', message: parsed.message });
      return;
    }
    const parsedYears = parsed.validForMonths === null ? null : parsed.validForMonths / 12;

    save.mutate(
      {
        id: competency.id,
        validForMonths: parsed.validForMonths,
        gracePeriodDays: parsed.gracePeriodDays,
      },
      {
        onSuccess: () => {
          setEditing(false);
          toast({
            variant: 'success',
            message:
              parsedYears === null
                ? `${competency.name} no longer expires.`
                : `${competency.name} is valid for ${parsedYears} year${parsedYears === 1 ? '' : 's'}, counted from each person's grant date.`,
          });
        },
      },
    );
  }

  if (!editing) {
    return (
      <button
        onClick={open}
        aria-label={`Set how long ${competency.name} stays valid`}
        className="fai-chip-btn mt-0.5 rounded-sm text-left text-[11px] text-text-tertiary hover:text-text-accent"
      >
        {describeValidity(competency)}
      </button>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <Input
          label="Valid for (years)"
          placeholder="Never expires"
          value={years}
          onChange={(e) => setYears(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave();
          }}
        />
        <Input
          label="Grace (days)"
          placeholder="0"
          value={grace}
          onChange={(e) => setGrace(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave();
          }}
        />
      </div>
      <p className="text-[11px] text-text-tertiary">
        Applies to everyone who already holds it, counted from the day they earned it.
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={onSave} disabled={save.isPending}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Add a competency to the register.
 *
 * `POST /competencies` has existed since gating shipped and nothing called it,
 * so an org with an empty register could only fill one with hand-written SQL.
 * The first real deployment reached sign-off with zero competencies recorded:
 * every assessment signed off granted nothing, the case still went competent
 * and the certificate still printed, and only the register stayed empty. That
 * is a silent failure of the one record this product exists to keep.
 *
 * NO MATCHING DELETE, deliberately. `competency_holders.competency_id`
 * cascades, so removing a competency erases every record of who ever held it —
 * the exact erasure the revoke path was just fixed to avoid. A one-click
 * control for that does not belong beside a create form.
 */
function NewCompetency({ existing }: { existing: Competency[] }) {
  const { toast } = useToast();
  const create = useCreateCompetency();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [years, setYears] = useState('');
  const [grace, setGrace] = useState('');

  function reset() {
    setName('');
    setCode('');
    setYears('');
    setGrace('');
    setOpen(false);
  }

  function onCreate() {
    const trimmedName = name.trim();
    /*
      A CODE IS OPTIONAL HERE, AND STILL STRONGLY PREFERRED. It is what the
      authoring script and every training-system export match on, so a
      competency without one is invisible to both — but some competencies
      genuinely have none. A contractor endorsement form or an in-house
      equipment induction is not a nationally-coded unit, and the only way past
      a required field was to type an invented code into the column people
      cross-reference against their LMS. The name is still required: a
      competency with neither is nothing at all.
    */
    const trimmedCode = code.trim() || null;
    if (!trimmedName) {
      toast({ variant: 'warning', message: 'A competency needs a name.' });
      return;
    }
    /*
      Nothing in the database stops two competencies sharing a code — there is
      no unique index on (org_id, code). The authoring script resolves a tool's
      competencies through a code→id map built from an unordered select, so a
      duplicate makes which one an assessment awards depend on row order. This
      is a guard, not enforcement, but it catches the way it would actually
      happen: somebody adding the same ticket twice.

      Skipped entirely when there is no code. Two competencies that both have
      none are not a duplicate of anything — absence is not an identifier, and
      matching on it would block the second internal competency an org adds.
    */
    const clash = trimmedCode
      ? existing.find((c) => c.code?.trim().toLowerCase() === trimmedCode.toLowerCase())
      : undefined;
    if (clash) {
      toast({
        variant: 'warning',
        message: `${clash.code} is already on the register as “${clash.name}”.`,
      });
      return;
    }
    const parsed = parseValidity(years, grace);
    if (!parsed.ok) {
      toast({ variant: 'warning', message: parsed.message });
      return;
    }

    create.mutate(
      {
        name: trimmedName,
        code: trimmedCode,
        validForMonths: parsed.validForMonths,
        gracePeriodDays: parsed.gracePeriodDays,
      },
      {
        onSuccess: (added) => {
          reset();
          toast({
            variant: 'success',
            message: added.code
              ? `${added.name} (${added.code}) added to the register.`
              : `${added.name} added to the register.`,
          });
        },
        /*
          Without this the failure is INVISIBLE. The global mutation handler
          only reacts to 401, nothing renders `create.error`, and this route
          403s on a plan without competency gating and 400s on a rejected body —
          so the button would simply re-enable with the form still filled and
          the admin left unsure whether the click registered.
        */
        onError: (err) => {
          toast({
            variant: 'warning',
            message: err instanceof Error ? err.message : 'Could not add the competency.',
          });
        },
      },
    );
  }

  if (!open) {
    return (
      <div className="border-t border-border-subtle px-[18px] py-2.5">
        <Button size="sm" variant="ghost" leadingIcon="plus" onClick={() => setOpen(true)}>
          Add competency
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border-subtle bg-surface-sunken px-[18px] py-3">
      <Input
        label="Name"
        placeholder="ATO - Track Dozer"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Input
        label="Code (optional)"
        placeholder="Q34666893"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <div className="flex items-end gap-2">
        <Input
          label="Valid for (years)"
          placeholder="Never expires"
          value={years}
          onChange={(e) => setYears(e.target.value)}
        />
        <Input
          label="Grace (days)"
          placeholder="0"
          value={grace}
          onChange={(e) => setGrace(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCreate();
          }}
        />
      </div>
      <p className="text-[11px] text-text-tertiary">
        The code must match the one your training system uses — it is what links an assessment to
        the ticket it awards. Leave it blank only for an internal competency that has no code;
        inventing one puts a reference in your register that your training system cannot resolve.
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={onCreate} disabled={create.isPending}>
          Add
        </Button>
        <Button size="sm" variant="ghost" onClick={reset}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * One row of the backfill worklist (U4, R3, KTD5 — AE3).
 *
 * The accept flow is deliberately two-step: pick a competency (the server's
 * suggestion, the picker, or an inline create), PREVIEW what linking it does —
 * "links N role requirements, creates M cases for A people" — and only then
 * apply. Linking ACTIVATES assignment (the tool awarded nothing, so the engine
 * planned no case for anyone until now); a one-click accept would land real
 * cases on real people with nobody having seen the number.
 */
function UnlinkedToolRow({
  tool,
  competencies,
}: {
  tool: UnlinkedTool;
  competencies: Competency[];
}) {
  const { toast } = useToast();
  const preview = usePreviewAwardLink();
  const apply = useApplyAwardLink();
  /**
   * Inline create with the created competency kept locally pickable
   * IMMEDIATELY (the shared hook): the register cache invalidation refetches
   * in the background, and a row whose picker cannot see the competency it
   * just created would strand the admin mid-flow.
   */
  const inlineCreate = useInlineCompetencyCreate(competencies);

  // The suggestion is PRE-PICKED, never pre-applied (R3): an exact
  // name-or-code match is safe to offer as a default, but the preview and the
  // confirm still stand between it and any write.
  const [competencyId, setCompetencyId] = useState(tool.suggestion?.competencyId ?? '');
  /** The previewed effects — only ever for the CURRENTLY picked competency. */
  const [effects, setEffects] = useState<AwardLinkEffects | null>(null);
  const [creating, setCreating] = useState(false);
  // Prefilled from the tool (AE3): "Site Familiarisation v2" the tool almost
  // certainly awards a competency of the same name, so accepting the default
  // is the one-step path. Editable for the cases where it is not.
  const [newName, setNewName] = useState(tool.name);
  const [newCode, setNewCode] = useState('');

  const options = inlineCreate.options;

  function pick(id: string) {
    setCompetencyId(id);
    // A preview belongs to a (tool, competency) PAIR. Keeping it across a
    // re-pick would let "Link award" apply counts the admin never saw.
    setEffects(null);
  }

  function onPreview() {
    if (!competencyId) return;
    preview.mutate(
      { toolId: tool.id, competencyId },
      {
        onSuccess: (result) => setEffects(result),
        onError: () => toast({ variant: 'danger', message: 'Could not preview the link.' }),
      },
    );
  }

  function onApply() {
    if (!competencyId || !effects) return;
    const target = options.find((c) => c.id === competencyId);
    apply.mutate(
      { toolId: tool.id, competencyId },
      {
        onSuccess: (result) => {
          // Report what actually LANDED — the applied counts, not the
          // previewed ones, though KTD10 makes them agree on unchanged data.
          toast({
            variant: 'success',
            message: `${tool.name} now awards ${target?.name ?? 'the competency'} — linked ${result.rolesLinked} role requirement${result.rolesLinked === 1 ? '' : 's'}, created ${result.created} case${result.created === 1 ? '' : 's'}.`,
          });
          // The invalidation sweep refetches the worklist; this row leaves it
          // because the tool no longer has an empty awards list.
        },
        onError: () => toast({ variant: 'danger', message: 'Could not link the award.' }),
      },
    );
  }

  function onCreate() {
    const trimmedName = newName.trim();
    if (!trimmedName) {
      toast({ variant: 'warning', message: 'A competency needs a name.' });
      return;
    }
    // No validity asked here (the shared hook creates perpetual) — this
    // flow's job is the LINK, not the whole record.
    inlineCreate.create(
      trimmedName,
      newCode.trim() || null,
      (added) => {
        pick(added.id);
        setCreating(false);
        toast({ variant: 'success', message: `${added.name} added to the register.` });
      },
      () => toast({ variant: 'warning', message: 'Could not add the competency.' }),
    );
  }

  return (
    <div className="border-b border-border-subtle px-[18px] py-3 last:border-b-0">
      <div className="flex flex-wrap items-end gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold">{tool.name}</div>
          {tool.suggestion ? (
            <div className="mt-0.5 text-[11px] text-text-tertiary">
              Suggested from an exact match: {tool.suggestion.name}
            </div>
          ) : (
            <div className="mt-0.5 text-[11px] text-text-tertiary">
              Nothing on the register matches this name — pick one, or create it.
            </div>
          )}
        </div>
        <div className="w-[220px]">
          <Select
            label={`What ${tool.name} awards`}
            value={competencyId}
            onChange={(e) => pick(e.target.value)}
            options={[
              { value: '', label: '— pick a competency —' },
              ...options.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          aria-label={`Preview link for ${tool.name}`}
          disabled={!competencyId || preview.isPending}
          onClick={onPreview}
        >
          Preview link
        </Button>
        <button
          onClick={() => setCreating((v) => !v)}
          aria-label={`Create a competency for ${tool.name}`}
          className="fai-chip-btn inline-flex items-center gap-1 rounded-sm py-1 text-[11px] font-medium text-text-accent hover:underline"
        >
          <Icon name="plus" size={12} />
          Create competency
        </button>
      </div>

      {creating && (
        <div className="mt-2.5 flex flex-wrap items-end gap-2 border-t border-border-subtle pt-2.5">
          <div className="min-w-[200px] flex-1">
            <Input label="Competency name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          </div>
          <div className="w-[140px]">
            <Input
              label="Competency code (optional)"
              placeholder="Q34666893"
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
            />
          </div>
          <Button size="sm" onClick={onCreate} disabled={inlineCreate.isPending}>
            Add &amp; pick
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
            Cancel
          </Button>
        </div>
      )}

      {effects && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2.5 rounded-md border border-warning bg-warning-soft p-[8px_10px]">
          <p className="min-w-0 flex-1 text-[11.5px] text-warning-text">
            {/*
              THE BLAST RADIUS, before anything lands (KTD5). "Creates 0 cases"
              is a real and reassuring answer — it means everyone covered
              already holds the competency or has a case in flight.
            */}
            Linking this converts and activates: links {effects.rolesLinked} role requirement
            {effects.rolesLinked === 1 ? '' : 's'}, creates {effects.created} case
            {effects.created === 1 ? '' : 's'} for {effects.affected}{' '}
            {effects.affected === 1 ? 'person' : 'people'}.
          </p>
          <Button size="sm" onClick={onApply} disabled={apply.isPending}>
            Link award
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEffects(null)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The one-time backfill panel (U4, R3): assessments created before awards were
 * required at create, still awarding nothing. Absent entirely when the
 * worklist is empty — a permanent empty admin panel would read as a chore that
 * never finishes — and never even FETCHED below admin, because the endpoint
 * 403s there (reading the worklist sits on the same gate as acting on it).
 */
function BackfillPanel({ competencies }: { competencies: Competency[] }) {
  const { data: session } = useSession();
  const isAdmin = session?.role === 'owner' || session?.role === 'admin';
  const { data: unlinked = [] } = useUnlinkedTools({ enabled: isAdmin });

  if (!isAdmin || unlinked.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-warning bg-surface-card shadow-xs md:col-span-2">
      <div className="border-b border-border-subtle px-[18px] py-4">
        <div className="flex items-center gap-2">
          <Icon name="shield-alert" size={15} className="text-warning-text" />
          <span className="font-heading text-[15px] font-bold">
            {unlinked.length} assessment{unlinked.length === 1 ? '' : 's'} awarding nothing
          </span>
        </div>
        <p className="mt-0.5 text-xs text-text-tertiary">
          These were built before an assessment had to name what it awards, so signing them off
          grants nothing and nobody is ever assigned them. Link each one to the competency it
          awards — every link is previewed before it lands, because linking is what switches
          assignment on.
        </p>
      </div>
      {unlinked.map((tool) => (
        <UnlinkedToolRow key={tool.id} tool={tool} competencies={competencies} />
      ))}
    </div>
  );
}

/**
 * Competency gating — the rule builder (which competency unlocks which form
 * section) plus a "how fillers see it" locked-section preview. Rules drive the
 * gated rendering in the external fill view.
 */
export function CompetencyScreen() {
  const { toast } = useToast();
  const { data: forms = [] } = useForms();
  const { data: competencies = [] } = useCompetencies();
  const { data: rules = [] } = useCompetencyRules();
  const addRule = useAddRule();
  const toggleRule = useToggleRule();
  const removeRule = useRemoveRule();

  const [ruleForm, setRuleForm] = useState('f3');

  const [ruleComp, setRuleComp] = useState('c1');
  const [ruleSection, setRuleSection] = useState('');
  /*
    The chosen form's own section headers, so "Section to gate" is picked from
    what the form actually prints instead of typed from memory. A free-text
    reference that matches no printed section is a rule that quietly gates
    nothing — and the author who mistyped it has no way to notice.
  */
  const { data: ruleFormDetail } = useForm(ruleForm || undefined);
  const ruleFormSections = (ruleFormDetail?.fields ?? [])
    .filter((f) => f.type === 'section_header')
    .map((f) => f.label)
    .filter((label, i, all) => label.trim() !== '' && all.indexOf(label) === i);
  /**
   * Which register is open. One at a time, and none by default: each one is a
   * request, and a page of twenty competencies must not fire twenty of them to
   * show a list nobody has asked to see.
   */
  const [openRegister, setOpenRegister] = useState<string | null>(null);

  // Preview: first enabled rule, else first rule, else a placeholder.
  const previewRule = rules.find((r) => r.enabled) ?? rules[0];
  const exSection = previewRule?.section ?? 'a gated section';
  const exComp = previewRule?.competency ?? 'a competency';

  function onAdd() {
    if (!ruleSection.trim()) {
      toast({ variant: 'warning', message: 'Enter the form section this competency should unlock.' });
      return;
    }
    const comp = competencies.find((c) => c.id === ruleComp);
    addRule.mutate(
      { formId: ruleForm, competencyId: ruleComp, section: ruleSection.trim() },
      {
        onSuccess: (rule) => {
          if (!rule) return;
          toast({ variant: 'success', message: `${comp?.name ?? 'Competency'} now unlocks “${rule.section}”.` });
          setRuleSection('');
        },
      },
    );
  }

  return (
    <div className="fai-rise mx-auto grid max-w-[1040px] grid-cols-1 items-start gap-5 p-[30px_28px_60px] md:grid-cols-[minmax(0,290px)_minmax(0,1fr)]">
      {/*
        The backfill worklist spans both columns and leads the page while any
        tool still awards nothing (U4). It renders nothing at all otherwise.
      */}
      <BackfillPanel competencies={competencies} />

      {/* Left: competencies + filler preview */}
      <div className="flex flex-col gap-4">
        <div className="overflow-hidden rounded-lg border border-border bg-surface-card shadow-xs">
          <div className="border-b border-border-subtle px-[18px] py-4">
            <div className="font-heading text-[15px] font-bold">Competencies</div>
            <div className="mt-0.5 text-xs text-text-tertiary">Held records synced from your LMS</div>
          </div>
          {competencies.map((c) => {
            const open = openRegister === c.id;
            return (
              <div key={c.id} className="border-b border-border-subtle last:border-b-0">
                <div className="flex items-start gap-3 px-[18px] py-[13px]">
                  <span
                    className="mt-1 h-2.5 w-2.5 flex-none rounded-[3px]"
                    style={{ background: c.color }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-semibold">{c.name}</div>
                    {/*
                      An em dash, the same absent-value mark this screen already
                      uses for a missing date, rather than an empty line. A
                      competency with no code must read as HAVING no code — a
                      blank gap where a mono code normally sits looks like the
                      row failed to load.
                    */}
                    <div className="font-mono text-[11px] text-text-tertiary">{c.code ?? '—'}</div>
                    <ValidityEditor competency={c} />
                  </div>
                  {/*
                    The count is granted-and-not-revoked, NOT how many are in
                    date — expiry moves with the calendar and a stored integer
                    cannot. So it is the button that opens the register, which
                    IS able to answer the currency question, rather than a
                    number sitting there implying it already has.
                  */}
                  <button
                    onClick={() => setOpenRegister(open ? null : c.id)}
                    aria-expanded={open}
                    aria-label={`${open ? 'Hide' : 'Show'} who holds ${c.name}`}
                    className="fai-chip-btn flex flex-none items-center gap-1 rounded-sm px-1.5 py-1 text-text-secondary hover:bg-surface-hover"
                  >
                    <span className="font-heading text-sm font-bold">{c.holders}</span>
                    <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} />
                  </button>
                </div>
                {open && <HolderRegister competency={c} />}
              </div>
            );
          })}
          <NewCompetency existing={competencies} />
        </div>

        <div className="rounded-lg border border-border-accent bg-surface-accent-soft p-[16px_18px]">
          <div className="mb-2.5 flex items-center gap-[7px]">
            <Icon name="lock" size={14} className="text-accent" />
            <span className="font-mono text-[11px] uppercase tracking-wide text-text-accent">
              How fillers see it
            </span>
          </div>
          <div className="rounded-md border border-border bg-white p-[13px] opacity-95">
            <div className="flex items-center gap-2 opacity-60 grayscale">
              <Icon name="lock" size={14} />
              <span className="text-[12.5px] font-semibold text-[#1a2224]">{exSection}</span>
            </div>
            <div className="mt-2 h-[30px] rounded-md border border-dashed border-border-strong bg-surface-sunken" />
            <div className="mt-2 flex items-center gap-[5px] text-[11px] text-warning-text">
              <Icon name="shield-alert" size={12} />
              Unlocks with {exComp}
            </div>
          </div>
        </div>
      </div>

      {/* Right: rule builder + active rules */}
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-border bg-surface-card p-5 shadow-xs">
          <div className="mb-1 font-heading text-[15px] font-bold">New gating rule</div>
          <p className="mb-4 text-[12.5px] text-text-tertiary">
            Unlock a form section only for people who hold the right competency.
          </p>
          <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Select
              label="Form"
              value={ruleForm}
              onChange={(e) => setRuleForm(e.target.value)}
              options={forms.map((f) => ({ value: f.id, label: f.name }))}
            />
            <Select
              label="Required competency"
              value={ruleComp}
              onChange={(e) => setRuleComp(e.target.value)}
              options={competencies.map((c) => ({ value: c.id, label: c.name }))}
            />
          </div>
          <div className="flex items-end gap-2.5">
            <div className="flex-1">
              {/*
                The form's own headers when it has them; free text only when it
                does not. A built-from-scratch form with no headers still needs
                a way to name its section, so the input is a fallback rather
                than being removed.
              */}
              {ruleFormSections.length > 0 ? (
                <Select
                  label="Section to gate"
                  value={ruleSection}
                  onChange={(e) => setRuleSection(e.target.value)}
                  options={[
                    { value: '', label: '— pick a section —' },
                    ...ruleFormSections.map((label) => ({ value: label, label })),
                  ]}
                />
              ) : (
                <Input
                  label="Section to gate"
                  placeholder="e.g. Roof access items"
                  value={ruleSection}
                  onChange={(e) => setRuleSection(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onAdd();
                  }}
                />
              )}
            </div>
            <Button leadingIcon="plus" onClick={onAdd}>
              Add rule
            </Button>
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-surface-card shadow-xs">
          <div className="border-b border-border-subtle px-5 py-4 font-heading text-[15px] font-bold">
            Active rules · {rules.length}
          </div>
          {rules.map((r) => {
            const dot = competencies.find((c) => c.id === r.competencyId)?.color ?? 'var(--accent)';
            return (
              <div
                key={r.id}
                className="flex items-center gap-[14px] border-b border-border-subtle px-5 py-3.5 last:border-b-0"
              >
                <span className="h-2.5 w-2.5 flex-none rounded-[3px]" style={{ background: dot }} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-semibold">{r.section}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-text-tertiary">
                    <span>{r.form}</span>
                    <Icon name="arrow-right" size={12} />
                    <span className="inline-flex items-center gap-[5px]">
                      <Icon name="graduation-cap" size={13} />
                      {r.competency}
                    </span>
                  </div>
                </div>
                <span
                  className="w-[52px] text-right text-[11.5px] font-semibold"
                  style={{ color: r.enabled ? 'var(--success-text)' : 'var(--text-tertiary)' }}
                >
                  {r.enabled ? 'Active' : 'Paused'}
                </span>
                <Switch
                  checked={r.enabled}
                  onChange={() => toggleRule.mutate(r.id)}
                  aria-label={`Toggle rule ${r.section}`}
                />
                <button
                  onClick={() => removeRule.mutate(r.id)}
                  aria-label={`Remove rule ${r.section}`}
                  className="fai-chip-btn grid h-[30px] w-[30px] flex-none place-items-center rounded-sm text-text-tertiary hover:bg-surface-hover"
                >
                  <Icon name="trash-2" size={14} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
