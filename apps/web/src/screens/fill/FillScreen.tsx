import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Icon, Input, useToast } from '@formai/ui';
import type { SubmissionValue } from '@formai/shared';
import { ApiError } from '../../lib/data/api-client.js';
import { useFillForm, useSubmitFill } from '../../lib/data/hooks.js';
import type { PublicFillForm } from '../../lib/data/types.js';
import { FieldInput } from '../fields/FieldRenderer.js';
import { fillSpanClass, resolveFillSpan } from '../../lib/fill-layout.js';
import {
  EMAIL_RE,
  requiredFieldErrors,
  requiredFieldsMissingIds,
  validateRequired,
  incompleteRowsByFieldFrom,
} from '../../lib/validation.js';
import { ExternalShell } from './ExternalShell.js';

/**
 * Public external fill page — `/fill/:token`, reachable logged OUT. Loads
 * the form via the public `GET /fill/:token` (the token is the only
 * credential), renders the served version's real fields with the shared
 * field renderer, and submits through `POST /fill/:token/submissions`,
 * echoing the served `versionId` so the submission pins exactly what the
 * visitor filled. The page is branded with the serving org's kit from the
 * same payload.
 *
 * Competency gating is deliberately absent on this path (v1): an anonymous
 * token visitor has no competency records to check. The gating rule builder
 * lives on the authed competency screen
 * (`screens/enterprise/CompetencyScreen.tsx`); fill-view gating would
 * return on an authed internal fill surface.
 */
export function FillScreen() {
  const { token } = useParams<{ token: string }>();
  const { toast } = useToast();
  const { data: fill, isLoading, isError } = useFillForm(token);
  const submit = useSubmitFill();

  const [values, setValues] = useState<Record<string, SubmissionValue>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitterName, setSubmitterName] = useState('');
  const [submitterEmail, setSubmitterEmail] = useState('');
  /** Per-field incomplete row indexes from the last failed submit (R10). */
  const [incompleteRows, setIncompleteRows] = useState<Record<string, number[]>>({});
  const [emailError, setEmailError] = useState('');
  const [doneRef, setDoneRef] = useState<string | null>(null);

  function setValue(fieldId: string, value: SubmissionValue) {
    setValues((v) => ({ ...v, [fieldId]: value }));
    setErrors((e) => (e[fieldId] ? { ...e, [fieldId]: '' } : e));
  }

  function onSubmit(form: PublicFillForm) {
    const errs = validateRequired(form.fields, values);
    const email = submitterEmail.trim();
    let emailErr = '';
    if (!email) emailErr = 'Enter your email so we can confirm your submission';
    else if (!EMAIL_RE.test(email)) emailErr = 'Enter a valid email address';
    setEmailError(emailErr);

    if (Object.keys(errs).length || emailErr) {
      setErrors(errs);
      const n = Object.keys(errs).length + (emailErr ? 1 : 0);
      toast({ variant: 'warning', message: `${n} field${n === 1 ? '' : 's'} need attention.` });
      return;
    }

    submit.mutate(
      {
        token: token!,
        versionId: form.versionId,
        submitterName: submitterName.trim() || undefined,
        submitterEmail: email,
        values,
      },
      {
        onSuccess: (row) => setDoneRef(row.id),
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) {
            toast({
              variant: 'warning',
              message: 'This form was updated — refresh to get the latest version.',
            });
          } else if (err instanceof ApiError && err.status === 404) {
            toast({ variant: 'warning', message: 'This form link is no longer active.' });
          } else if (err instanceof ApiError && err.status === 400) {
            // Server-side required enforcement (KTD4): map the named fields
            // into the same per-field errors the client check uses.
            const missingIds = requiredFieldsMissingIds(err.body);
            // Row-level detail travels with the same 400 — surfacing it is what
            // turns "this table is incomplete" into "rows 7 and 14".
            setIncompleteRows(incompleteRowsByFieldFrom(err.body));
            if (missingIds && missingIds.length > 0) {
              setErrors((e) => ({ ...e, ...requiredFieldErrors(missingIds) }));
              const n = missingIds.length;
              toast({
                variant: 'warning',
                message: `${n} required field${n === 1 ? '' : 's'} still need${n === 1 ? 's' : ''} an answer.`,
              });
            } else {
              toast({
                variant: 'danger',
                message: 'Some answers were invalid — check the form and try again.',
              });
            }
          } else {
            toast({
              variant: 'danger',
              message: 'Submission failed — check your connection and try again.',
            });
          }
        },
      },
    );
  }

  if (isLoading) {
    return (
      <ExternalShell orgName="" branding={null}>
        <div className="flex items-center gap-2 pt-16 text-sm text-text-secondary">
          <Icon name="loader-circle" size={16} className="animate-spin" />
          Loading form…
        </div>
      </ExternalShell>
    );
  }

  // Unknown, revoked, and expired tokens all land here (the API serves the
  // identical 404 for each) — a friendly dead end, never a login redirect.
  if (!token || isError || !fill) {
    return (
      <FillNotFound
        message={
          isError
            ? 'Something went wrong loading this form. Try again in a moment.'
            : undefined
        }
      />
    );
  }

  if (doneRef) {
    return (
      <ExternalShell orgName={fill.orgName} branding={fill.orgBranding}>
        <FillDone orgName={fill.orgName} refId={doneRef} email={submitterEmail.trim()} />
      </ExternalShell>
    );
  }

  return (
    <ExternalShell orgName={fill.orgName} branding={fill.orgBranding}>
      <div className="w-full max-w-[600px]">
        <div className="overflow-hidden rounded-lg border border-border bg-white shadow-sm">
          <div className="p-[24px_28px]" style={{ background: 'var(--org-primary)' }}>
            <div className="mb-[7px] font-mono text-[11px] uppercase tracking-wide text-white/60">
              {fill.orgName || 'Form'}
            </div>
            <div
              className="text-[21px] font-bold text-white"
              style={{ fontFamily: 'var(--org-font)' }}
            >
              {fill.formName}
            </div>
            <div className="mt-1.5 text-[13px] text-white/70">
              Fields marked * are required
            </div>
          </div>

          <div
            className="flex flex-col gap-6 p-[26px_28px]"
            style={{ fontFamily: 'var(--org-font)' }}
          >
            {/* Submitter identity — rides along as submitterName/submitterEmail. */}
            <div>
              <div className="mb-3.5 flex items-center gap-2 border-b border-border-subtle pb-2.5 text-sm font-bold text-text-primary">
                Your details
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Input
                  label="Your name"
                  value={submitterName}
                  placeholder="Rebecca Hsu"
                  onChange={(e) => setSubmitterName(e.target.value)}
                />
                <Input
                  label="Email"
                  required
                  type="email"
                  leadingIcon="mail"
                  value={submitterEmail}
                  error={emailError}
                  placeholder="you@company.com"
                  onChange={(e) => {
                    setSubmitterEmail(e.target.value);
                    setEmailError('');
                  }}
                />
              </div>
            </div>

            {/* The served version's real fields, via the shared renderer, on
                the builder's 12-col grid (single column below `sm`). */}
            <div className="grid grid-cols-12 gap-[16px]">
              {fill.fields.map((f) => (
                <div key={f.id} className={fillSpanClass(resolveFillSpan(f, false))}>
                  <FieldInput
                    field={f}
                    value={values[f.id] ?? null}
                    error={errors[f.id] || undefined}
                    incompleteRowIndexes={incompleteRows[f.id]}
                    onChange={(v) => setValue(f.id, v)}
                  />
                </div>
              ))}
              {fill.fields.length === 0 && (
                <div className="col-span-12 py-4 text-center text-[13px] text-text-tertiary">
                  This form has no fields.
                </div>
              )}
            </div>

            <button
              onClick={() => onSubmit(fill)}
              disabled={submit.isPending || fill.fields.length === 0}
              className="fai-lift flex h-12 w-full items-center justify-center gap-2 rounded-md text-[15px] font-bold disabled:opacity-60"
              style={{
                background: 'var(--org-accent)',
                color: 'var(--org-accent-text)',
                fontFamily: 'var(--org-font)',
              }}
            >
              {submit.isPending ? 'Submitting…' : 'Submit'}
              <Icon name="arrow-right" size={17} />
            </button>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-center gap-1.5 text-[11.5px] text-text-tertiary">
          <Icon name="shield-check" size={13} />
          Your responses are encrypted and only shared with {fill.orgName || 'this organisation'}.
        </div>
      </div>
    </ExternalShell>
  );
}

/** Friendly dead-end for unknown/revoked/expired tokens (or a load failure). */
function FillNotFound({ message }: { message?: string }) {
  return (
    <ExternalShell orgName="" branding={null}>
      <div className="fai-rise w-full max-w-[440px] pt-14 text-center">
        <span className="mb-4 inline-grid h-14 w-14 place-items-center rounded-full bg-surface-sunken">
          <Icon name="link-2-off" size={26} className="text-text-tertiary" />
        </span>
        <h2 className="mb-2 text-[22px]">This form link isn't available</h2>
        <p className="mx-auto max-w-[380px] text-sm leading-relaxed text-text-secondary">
          {message ??
            'The link may have been revoked, expired, or mistyped. Ask the organisation that sent it for a fresh one.'}
        </p>
      </div>
    </ExternalShell>
  );
}

/**
 * Post-submit thank-you (the former FillConfirmScreen, folded in so it keeps
 * the org branding and the real submission id without a routed hand-off).
 */
function FillDone({ orgName, refId, email }: { orgName: string; refId: string; email: string }) {
  const org = orgName || 'The organisation';
  const steps = [
    `${org} reviews your submission — you'll hear back if anything needs clarification.`,
    email ? `A confirmation reference has been recorded against ${email}.` : 'Keep your reference number handy if you need to follow up.',
    'You can close this page — nothing else is needed from you.',
  ];

  return (
    <div className="fai-rise w-full max-w-[520px] pt-5 text-center">
      <span
        className="mb-5 inline-grid h-[66px] w-[66px] place-items-center rounded-full"
        style={{ background: 'var(--org-accent)' }}
      >
        <Icon name="check" size={34} color="var(--org-accent-text)" />
      </span>
      <h2 className="mb-2 text-[28px]">Submission received</h2>
      <p className="mx-auto mb-[26px] max-w-[420px] text-[15px] leading-relaxed text-text-secondary">
        Thank you — <strong>{org}</strong> has your details
        {email ? (
          <>
            , submitted as <strong>{email}</strong>
          </>
        ) : null}
        .
      </p>

      <div className="mb-7 inline-flex items-center gap-3.5 rounded-md border border-border bg-white p-[14px_20px] shadow-xs">
        <div className="text-left">
          <div className="font-mono text-[11px] text-text-tertiary">REFERENCE</div>
          <div className="max-w-[260px] truncate font-heading text-[18px] font-bold">{refId}</div>
        </div>
        <span className="h-[34px] w-px bg-border" />
        <div className="text-left">
          <div className="font-mono text-[11px] text-text-tertiary">SUBMITTED</div>
          <div className="text-sm font-semibold">Just now</div>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-white p-[20px_22px] text-left shadow-xs">
        <div className="mb-3.5 font-heading text-sm font-bold">What happens next</div>
        <div className="flex flex-col gap-[13px]">
          {steps.map((step, i) => (
            <div key={i} className="flex gap-[11px]">
              <span className="grid h-6 w-6 flex-none place-items-center rounded-full bg-surface-accent-soft font-mono text-[11px] font-semibold text-text-accent">
                {i + 1}
              </span>
              <span className="text-[13px] leading-relaxed text-text-secondary">{step}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
