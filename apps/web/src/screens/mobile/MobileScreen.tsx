import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, useToast } from '@formai/ui';
import type { SubmissionValue } from '@formai/shared';
import { useForm, useForms, useSession, useSubmissions, useSubmitInspection } from '../../lib/data/hooks.js';
import type { FormDetail, FormSummary, SubmissionRow } from '../../lib/data/types.js';
import { useOnboarding } from '../../lib/onboarding.js';
import { FieldInput } from '../fields/FieldRenderer.js';
import { ApiError } from '../../lib/data/api-client.js';
import { previewSpanClass, resolveFillSpan } from '../../lib/fill-layout.js';
import { answeredCount, publishedForms } from './mobile-fill.js';
import {
  inputFields,
  requiredFieldErrors,
  requiredFieldsMissingIds,
  validateRequired,
} from '../../lib/validation.js';

type Tab = 'home' | 'activity';
type View = 'list' | 'fill' | 'done';

/**
 * Forces light-theme semantic tokens inside the phone regardless of the app's
 * dark toggle. The phone interior renders as a real device with a fixed light
 * palette, but the shared `FieldInput` (and the @formai/ui inputs it wraps)
 * read semantic tokens that flip in dark mode — re-pinning them to their
 * light-theme values here keeps the fields legible. Raw ramps (`--neutral-*`,
 * `--green-*`, …) are theme-invariant, so referencing them is safe.
 */
const PHONE_LIGHT_TOKENS = {
  '--surface-page': 'var(--neutral-25)',
  '--surface-card': 'var(--neutral-0)',
  '--surface-sunken': 'var(--neutral-50)',
  '--surface-raised': 'var(--neutral-0)',
  '--surface-hover': 'var(--neutral-50)',
  '--surface-accent-soft': 'var(--green-50)',
  '--text-primary': 'var(--brand-ink)',
  '--text-secondary': 'var(--neutral-700)',
  '--text-tertiary': 'var(--neutral-500)',
  '--text-disabled': 'var(--neutral-400)',
  '--border-subtle': 'var(--neutral-100)',
  '--border-default': 'var(--neutral-200)',
  '--border-strong': 'var(--neutral-300)',
  '--border-accent': 'var(--green-400)',
  '--accent': 'var(--green-600)',
  '--accent-hover': 'var(--green-700)',
  '--accent-active': 'var(--green-800)',
  '--accent-contrast': 'var(--brand-white)',
  '--accent-ring': 'rgba(110, 199, 146, 0.45)',
  '--solid': 'var(--brand-slate)',
  '--solid-hover': 'var(--neutral-900)',
  '--solid-active': 'var(--brand-ink)',
  '--solid-contrast': 'var(--brand-white)',
  '--success': 'var(--green-600)',
  '--success-soft': 'var(--green-50)',
  '--success-text': 'var(--green-800)',
  '--warning': 'var(--amber-500)',
  '--warning-soft': 'var(--amber-50)',
  '--warning-text': 'var(--amber-700)',
  '--danger': 'var(--red-500)',
  '--danger-soft': 'var(--red-50)',
  '--danger-text': 'var(--red-700)',
  '--info': 'var(--blue-500)',
  '--info-soft': 'var(--blue-50)',
  '--info-text': 'var(--blue-700)',
  '--focus-ring': 'var(--accent-ring)',
} as React.CSSProperties;

/**
 * Mobile field app (responsive web). A device-framed fill flow — home /
 * activity tabs, a picker over the org's real published forms, the shared
 * field renderer for the selected form's fields, and a submit that posts a
 * real submission (`POST /submissions`) into the same web submissions table.
 * The phone interior uses a fixed light device palette (not the app's theme
 * vars) so it renders as a real device regardless of the app's dark toggle;
 * org brand still flows via the `--org-*` variables.
 */
export function MobileScreen() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { orgName, brandStyle } = useOnboarding();
  const { data: session } = useSession();
  const { data: forms = [], isLoading: formsLoading } = useForms();
  const { data: submissions = [] } = useSubmissions();
  const submit = useSubmitInspection();

  const [tab, setTab] = useState<Tab>('home');
  const [view, setView] = useState<View>('list');
  const [formId, setFormId] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, SubmissionValue>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [lastRef, setLastRef] = useState<string | null>(null);

  const { data: form } = useForm(formId ?? undefined);

  const userName = session?.userName ?? '';
  const firstName = userName.split(' ')[0] ?? userName;
  const initials =
    userName
      .split(' ')
      .map((w) => w[0])
      .slice(0, 2)
      .join('') || '·';

  const published = useMemo(() => publishedForms(forms), [forms]);
  const activity = useMemo(() => submissions.slice(0, 5), [submissions]);

  function openForm(f: FormSummary) {
    setFormId(f.id);
    setValues({});
    setErrors({});
    setView('fill');
  }

  function setValue(fieldId: string, value: SubmissionValue) {
    setValues((v) => ({ ...v, [fieldId]: value }));
    setErrors((e) => (e[fieldId] ? { ...e, [fieldId]: '' } : e));
  }

  function onSubmit(detail: FormDetail) {
    const errs = validateRequired(detail.fields, values);
    if (Object.keys(errs).length) {
      setErrors(errs);
      const n = Object.keys(errs).length;
      toast({ variant: 'warning', message: `${n} required field${n === 1 ? '' : 's'} still need an answer.` });
      return;
    }
    if (!detail.currentVersionId) {
      // Only published forms are listed, so this shouldn't happen — but a
      // fabricated submit against an unpublished form must fail honestly.
      toast({ variant: 'danger', message: 'This form has no published version to submit against.' });
      return;
    }
    submit.mutate(
      {
        templateId: detail.id,
        versionId: detail.currentVersionId,
        values,
        submitterName: session?.userName,
        submitterEmail: session?.userEmail,
      },
      {
        onSuccess: (row) => {
          setLastRef(row.id);
          setView('done');
          toast({ variant: 'success', message: `${detail.name} submitted — your team can review it on web.` });
        },
        onError: (err) => {
          // A 400 is the server rejecting the CONTENT, not a transport
          // failure — never blame the connection for a validation response.
          if (err instanceof ApiError && err.status === 400) {
            const missingIds = requiredFieldsMissingIds(err.body);
            if (missingIds && missingIds.length > 0) {
              // Server-side required enforcement (KTD4): same per-field
              // errors as the client-side pre-check above.
              setErrors((e) => ({ ...e, ...requiredFieldErrors(missingIds) }));
              const n = missingIds.length;
              toast({ variant: 'warning', message: `${n} required field${n === 1 ? '' : 's'} still need an answer.` });
            } else {
              toast({ variant: 'danger', message: 'Some answers were invalid — check the form and try again.' });
            }
          } else {
            toast({ variant: 'danger', message: 'Submission failed — check your connection and try again.' });
          }
        },
      },
    );
  }

  function reset() {
    setFormId(null);
    setValues({});
    setErrors({});
    setView('list');
    setTab('home');
  }

  const showTabs = view === 'list';

  return (
    <div
      className="flex min-h-full flex-col items-center px-5 pb-12 pt-[34px]"
      style={{ background: 'radial-gradient(circle at 50% -10%,#1e2e33,#0f1517 68%)' }}
    >
      {/* Intro */}
      <div className="mb-[26px] flex flex-col items-center gap-3.5 text-center">
        <div
          className="inline-flex items-center gap-2 rounded-pill px-3 py-[5px]"
          style={{ background: 'rgba(110,199,146,.14)', border: '1px solid rgba(110,199,146,.3)' }}
        >
          <Icon name="smartphone" size={13} color="#6ec792" />
          <span className="font-mono text-[11px] tracking-[0.06em]" style={{ color: '#9fdcb7' }}>
            MOBILE FIELD APP
          </span>
        </div>
        <div>
          <div className="font-heading text-[20px] font-bold text-white">FormAI for field teams</div>
          <div className="mt-[5px] max-w-[440px] text-[13px] leading-[1.5] text-white/55">
            Fill any of your published forms on-site — submissions land in the same table your admins
            already see on web.
          </div>
        </div>
      </div>

      {/* Device */}
      <div
        className="relative h-[800px] w-[390px] flex-none rounded-[56px] p-[13px]"
        style={{
          background: '#0c1113',
          boxShadow: '0 40px 80px -20px rgba(0,0,0,.6),0 0 0 2px rgba(255,255,255,.05) inset',
        }}
      >
        <div
          className="absolute left-1/2 top-[26px] z-30 h-[33px] w-[118px] -translate-x-1/2 rounded-[20px]"
          style={{ background: '#000' }}
        />
        <div
          className="relative flex h-full w-full flex-col overflow-hidden rounded-[44px]"
          style={{ background: '#f2f5f4', ...PHONE_LIGHT_TOKENS, ...brandStyle() }}
        >
          {/* Status bar */}
          <div
            className="flex h-[52px] flex-none items-end justify-between px-8 pb-2"
            style={{ background: 'var(--org-primary)' }}
          >
            <span className="font-ui text-[13px] font-bold text-white">9:41</span>
            <span className="flex items-center gap-[7px] text-white">
              <Icon name="signal" size={15} />
              <Icon name="wifi" size={15} />
              <Icon name="battery-medium" size={20} />
            </span>
          </div>

          {view === 'list' && tab === 'home' && (
            <HomeView
              firstName={firstName}
              initials={initials}
              forms={published}
              loading={formsLoading}
              onOpenForm={openForm}
            />
          )}

          {view === 'list' && tab === 'activity' && <ActivityView activity={activity} />}

          {view === 'fill' && (
            <FillView
              form={form ?? null}
              firstName={firstName}
              values={values}
              errors={errors}
              submitting={submit.isPending}
              onBack={reset}
              onChange={setValue}
              onSubmit={onSubmit}
            />
          )}

          {view === 'done' && (
            <DoneView
              orgName={orgName}
              formName={form?.name ?? 'Form'}
              lastRef={lastRef ?? ''}
              onViewWeb={() => navigate(`/app/submissions/detail?id=${lastRef ?? ''}`)}
              onBackHome={reset}
            />
          )}

          {showTabs && (
            <TabBar tab={tab} onHome={() => setTab('home')} onActivity={() => setTab('activity')} onNew={reset} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Views ───────────────────────────────────────────────────────────────── */

function HomeView({
  firstName,
  initials,
  forms,
  loading,
  onOpenForm,
}: {
  firstName: string;
  initials: string;
  forms: FormSummary[];
  loading: boolean;
  onOpenForm: (f: FormSummary) => void;
}) {
  const dateLong = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none px-[22px] pb-5 pt-1 text-white" style={{ background: 'var(--org-primary)' }}>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[12.5px] text-white/60">{dateLong}</div>
            <div className="mt-0.5 text-[23px] font-bold" style={{ fontFamily: 'var(--org-font)' }}>
              Hi {firstName || 'there'}
            </div>
          </div>
          <span className="grid h-[42px] w-[42px] place-items-center rounded-full bg-white/[0.16] font-heading text-[15px] font-bold text-white">
            {initials}
          </span>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-3.5 overflow-auto p-[16px_18px_22px]">
        <div className="mt-0.5 flex items-center justify-between">
          <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-[#7a8586]">
            Published forms
          </span>
          <span className="text-[11.5px] text-[#7a8586]">
            {loading ? 'Loading…' : `${forms.length} available`}
          </span>
        </div>

        {!loading && forms.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-[16px] border border-dashed border-[#dbe1e1] bg-white p-[26px_18px] text-center">
            <Icon name="folder-open" size={26} color="#9aa4a4" />
            <div className="text-[13.5px] font-semibold text-[#1a2224]">No published forms yet</div>
            <div className="text-[12px] leading-[1.5] text-[#7a8586]">
              Publish a form from the web builder and it appears here for field teams.
            </div>
          </div>
        )}

        {forms.map((f) => (
          <button
            key={f.id}
            onClick={() => onOpenForm(f)}
            className="fai-lift flex flex-col gap-3 rounded-[16px] border border-[#e2e7e7] bg-white p-4 text-left"
          >
            <div className="flex items-start gap-3">
              <span className="grid h-11 w-11 flex-none place-items-center rounded-[12px] bg-[#e9f6ee]">
                <Icon name={f.icon} size={22} color="var(--org-accent)" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-heading text-[15px] font-bold text-[#1a2224]">{f.name}</div>
                <div className="mt-0.5 text-[12.5px] text-[#5a6a6b]">
                  {f.dept} · {f.version}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3.5 border-t border-[#eef1f1] pt-[11px]">
              <span className="flex items-center gap-1.5 text-[12px] text-[#7a8586]">
                <Icon name="inbox" size={14} />
                {f.submissions} submission{f.submissions === 1 ? '' : 's'}
              </span>
              <span className="ml-auto flex items-center gap-1.5 text-[12.5px] font-semibold text-[#1f7a4d]">
                Start
                <Icon name="arrow-right" size={14} />
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function ActivityView({ activity }: { activity: SubmissionRow[] }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none px-[22px] pb-[18px] pt-1.5 text-white" style={{ background: 'var(--org-primary)' }}>
        <div className="text-[21px] font-bold" style={{ fontFamily: 'var(--org-font)' }}>
          Activity
        </div>
        <div className="mt-0.5 text-[12px] text-white/60">Latest submissions in your org</div>
      </div>
      <div className="flex flex-1 flex-col gap-2.5 overflow-auto p-[16px_18px]">
        {activity.length === 0 && (
          <div className="mt-8 text-center text-[13px] text-[#7a8586]">No submissions yet.</div>
        )}
        {activity.map((a) => (
          <div key={a.id} className="flex items-center gap-3 rounded-[14px] border border-[#e2e7e7] bg-white p-[13px_14px]">
            <span className="grid h-[38px] w-[38px] flex-none place-items-center rounded-[10px] bg-[#e9f6ee]">
              <Icon name="clipboard-check" size={18} color="var(--org-accent)" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-semibold text-[#1a2224]">{a.form}</div>
              <div className="truncate text-[11.5px] text-[#7a8586]">
                {a.who ? `${a.who} · ` : ''}
                {a.date}
              </div>
            </div>
            <div className="flex flex-none flex-col items-end gap-1">
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: '#1f7a4d' }}>
                <Icon name="cloud-check" size={13} />
                Synced
              </span>
              {a.flag && <span className="text-[10.5px] text-[#a12f1e]">{a.flag}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FillView({
  form,
  firstName,
  values,
  errors,
  submitting,
  onBack,
  onChange,
  onSubmit,
}: {
  form: FormDetail | null;
  firstName: string;
  values: Record<string, SubmissionValue>;
  errors: Record<string, string>;
  submitting: boolean;
  onBack: () => void;
  onChange: (fieldId: string, value: SubmissionValue) => void;
  onSubmit: (form: FormDetail) => void;
}) {
  if (!form) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-[13px] text-[#7a8586]">
        Loading form…
      </div>
    );
  }

  const total = inputFields(form.fields).length;
  const done = answeredCount(form.fields, values);
  const progressPct = `${total === 0 ? 0 : Math.round((done / total) * 100)}%`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none px-4 pb-4 pt-1.5 text-white" style={{ background: 'var(--org-primary)' }}>
        <div className="flex items-center gap-2.5">
          <button
            onClick={onBack}
            aria-label="Back to forms"
            className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-white/[0.12] text-white"
          >
            <Icon name="chevron-left" size={20} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[16px] font-bold" style={{ fontFamily: 'var(--org-font)' }}>
              {form.name}
            </div>
            <div className="truncate text-[11.5px] text-white/60">{form.dept}</div>
          </div>
          <span className="flex-none text-[12.5px] font-bold text-white">
            {done}/{total}
          </span>
        </div>
        <div className="mt-[13px] h-1.5 overflow-hidden rounded-pill bg-white/[0.16]">
          <div
            className="h-full rounded-pill transition-[width] duration-300"
            style={{ width: progressPct, background: 'var(--org-accent)' }}
          />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-[18px] overflow-auto p-[16px_16px_18px]">
        {/* Submitter context */}
        <div className="flex gap-2.5">
          <div className="flex-1 rounded-[12px] border border-[#e2e7e7] bg-white p-[11px_13px]">
            <div className="text-[10.5px] font-bold tracking-[0.04em] text-[#7a8586]">DATE</div>
            <div className="mt-0.5 text-[13px] font-semibold text-[#1a2224]">Today</div>
          </div>
          <div className="flex-1 rounded-[12px] border border-[#e2e7e7] bg-white p-[11px_13px]">
            <div className="text-[10.5px] font-bold tracking-[0.04em] text-[#7a8586]">SUBMITTING AS</div>
            <div className="mt-0.5 truncate text-[13px] font-semibold text-[#1a2224]">{firstName || '—'}</div>
          </div>
        </div>

        {/* Fields — the same shared renderer the builder preview / fill flow uses */}
        <div className="rounded-[14px] border border-[#e2e7e7] bg-white p-[15px_13px]">
          {/* Same 12-col grid path as the other fill surfaces, but the 390px
              frame is a CONTAINER (viewport breakpoints don't apply), so
              `narrow` collapses every span to 12 — effectively stacked. */}
          <div className="grid grid-cols-12 gap-[16px]">
            {form.fields.map((f) => (
              <div key={f.id} className={previewSpanClass(resolveFillSpan(f, true))}>
                <FieldInput
                  field={f}
                  value={values[f.id] ?? null}
                  error={errors[f.id] || undefined}
                  onChange={(v) => onChange(f.id, v)}
                />
              </div>
            ))}
            {form.fields.length === 0 && (
              <div className="col-span-12 py-4 text-center text-[13px] text-[#7a8586]">This form has no fields.</div>
            )}
          </div>
        </div>
      </div>

      <div className="flex-none border-t border-[#e2e7e7] bg-white p-[12px_16px_16px]">
        <button
          onClick={() => onSubmit(form)}
          disabled={submitting || form.fields.length === 0}
          className="fai-lift flex h-[50px] w-full items-center justify-center gap-2 rounded-[14px] text-[15px] font-bold disabled:opacity-60"
          style={{
            background: 'var(--org-accent)',
            color: 'var(--org-accent-text)',
            fontFamily: 'var(--org-font)',
          }}
        >
          <Icon name="cloud-upload" size={18} />
          {submitting ? 'Submitting…' : 'Submit'}
        </button>
      </div>
    </div>
  );
}

function DoneView({
  orgName,
  formName,
  lastRef,
  onViewWeb,
  onBackHome,
}: {
  orgName: string;
  formName: string;
  lastRef: string;
  onViewWeb: () => void;
  onBackHome: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ background: 'var(--org-primary)' }}>
      <div className="flex flex-1 flex-col items-center justify-center overflow-auto p-[28px_24px] text-center">
        <span
          className="fai-rise mb-5 grid h-[76px] w-[76px] place-items-center rounded-full"
          style={{ background: 'var(--org-accent)' }}
        >
          <Icon name="check" size={40} color="var(--org-accent-text)" />
        </span>
        <div className="text-[22px] font-bold text-white" style={{ fontFamily: 'var(--org-font)' }}>
          {formName} submitted
        </div>
        <div className="mt-2 max-w-[280px] text-[13.5px] leading-[1.5] text-white/70">
          Synced to {orgName} — your team can review it now.
        </div>

        <div className="mt-6 w-full rounded-[16px] border border-white/[0.12] bg-white/[0.08] p-4 text-left">
          <div className="flex items-center gap-[11px]">
            <Icon name="cloud-check" size={22} className="flex-none" color="#6ec792" />
            <div className="flex-1">
              <div className="text-[13.5px] font-bold text-white">Uploaded</div>
              <div className="mt-px text-[11.5px] text-white/60">1 submission · synced just now</div>
            </div>
          </div>
        </div>

        <div className="mt-4 inline-flex items-center gap-3 rounded-[12px] bg-white/[0.06] p-[11px_18px]">
          <div className="text-left">
            <div className="font-mono text-[10px] tracking-[0.05em] text-white/50">REFERENCE</div>
            <div className="max-w-[220px] truncate font-heading text-[14px] font-bold text-white">{lastRef}</div>
          </div>
        </div>
      </div>

      <div className="flex flex-none flex-col gap-2.5 p-[14px_20px_18px]">
        <button
          onClick={onViewWeb}
          className="flex h-[46px] w-full items-center justify-center gap-2 rounded-[13px] font-ui text-[14px] font-bold"
          style={{ background: 'var(--org-accent)', color: 'var(--org-accent-text)' }}
        >
          See it in web submissions
          <Icon name="external-link" size={16} />
        </button>
        <button
          onClick={onBackHome}
          className="h-11 w-full rounded-[13px] border border-white/20 bg-transparent font-ui text-[14px] font-semibold text-white"
        >
          Back to forms
        </button>
      </div>
    </div>
  );
}

function TabBar({
  tab,
  onHome,
  onActivity,
  onNew,
}: {
  tab: Tab;
  onHome: () => void;
  onActivity: () => void;
  onNew: () => void;
}) {
  return (
    <div className="flex flex-none items-start border-t border-[#e2e7e7] bg-white p-[9px_22px_18px]">
      <button
        onClick={onHome}
        className="flex flex-1 flex-col items-center gap-[3px]"
        style={{ color: tab === 'home' ? 'var(--org-accent)' : '#9aa4a4' }}
      >
        <Icon name="home" size={22} />
        <span className="text-[10.5px] font-semibold">Home</span>
      </button>
      <button onClick={onNew} aria-label="New submission" className="flex w-[58px] flex-none justify-center">
        <span
          className="-mt-5 grid h-12 w-12 place-items-center rounded-full shadow-md"
          style={{ background: 'var(--org-accent)' }}
        >
          <Icon name="plus" size={25} color="var(--org-accent-text)" />
        </span>
      </button>
      <button
        onClick={onActivity}
        className="flex flex-1 flex-col items-center gap-[3px]"
        style={{ color: tab === 'activity' ? 'var(--org-accent)' : '#9aa4a4' }}
      >
        <Icon name="list" size={22} />
        <span className="text-[10.5px] font-semibold">Activity</span>
      </button>
    </div>
  );
}
