import { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Icon, Input, useToast } from '@formai/ui';
import type { SmartFillResult, SubmissionValue } from '@formai/shared';
import { resolveTheme } from '@formai/shared';
import { ApiError } from '../../lib/data/api-client.js';
import {
  discardImpactOf,
  discardImpactOfPatch,
  discardWarningMessage,
  isCommittedChange,
} from '../../lib/discard-warning.js';
import { useFillForm, usePublicSmartFill, useSubmitFill } from '../../lib/data/hooks.js';
import { smartFillFailure } from '../../lib/voice/smart-fill.js';
import type { PublicFillForm } from '../../lib/data/types.js';
import { FieldInput } from '../fields/FieldRenderer.js';
import {
  fillSpanClass,
  resolveFillSpan,
  resolveLayout,
  visibleFillFields,
} from '../../lib/fill-layout.js';
import { FormLayoutFrame } from './FormLayoutFrame.js';
import { ConversationalFill } from './ConversationalFill.js';
import {
  EMAIL_RE,
  clearedErrors,
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
 *
 * Voice is offered here in two tiers and is only ever an enhancement: a mic on
 * each field (free, transcribed on-device, no audio leaves the browser) and
 * Smart Fill (paid), which posts one transcript and gets proposed answers back.
 * Neither can submit — the same Submit button below is still the only way.
 */
export function FillScreen() {
  const { token } = useParams<{ token: string }>();
  const { toast } = useToast();
  const { data: fill, isLoading, isError } = useFillForm(token);
  const submit = useSubmitFill();
  const smartFill = usePublicSmartFill();
  /**
   * Entitlement comes from the served payload's `smartFillEnabled` — the one
   * plan detail `GET /fill/:token` discloses, and only as a yes/no. This page
   * is logged out, so there is no `useBilling()` to ask instead.
   *
   * `smartFillRetired` still exists on top of it for the failures a boolean
   * cannot predict: no model configured server-side (422), or a plan that
   * lapsed between the load and the press. Both are fixed for this page load,
   * so the entry point goes away rather than staying to fail again.
   */
  const [smartFillRetired, setSmartFillRetired] = useState(false);
  const smartFillOffered = (fill?.smartFillEnabled ?? false) && !smartFillRetired;

  const [values, setValues] = useState<Record<string, SubmissionValue>>({});
  /**
   * What `applyValues` weighs its discard warning against. Only the paths that
   * resume after an `await` need it — a synchronous change handler's closure is
   * current by definition — and the merge itself is functional either way.
   */
  const latestValues = useRef(values);
  latestValues.current = values;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitterName, setSubmitterName] = useState('');
  const [submitterEmail, setSubmitterEmail] = useState('');
  /** Per-field incomplete row indexes from the last failed submit (R10). */
  const [incompleteRows, setIncompleteRows] = useState<Record<string, number[]>>({});
  const [emailError, setEmailError] = useState('');
  const [doneRef, setDoneRef] = useState<string | null>(null);

  function setValue(fieldId: string, value: SubmissionValue) {
    // R22 — a change that hides an answered section destroys those answers
    // (the server strips hidden values on save), so confirm before applying
    // rather than after. Silent when only empty fields would hide: a prompt
    // that fires on every harmless toggle gets dismissed unread.
    // Only warn on sources whose every change IS a commit. On a free-text or
    // numeric source each keystroke moves the value away from the match, so a
    // per-keystroke modal would make the field uneditable: cancel drops the
    // character, accept wipes the section. Those are re-checked at submit.
    if (isCommittedChange(fill?.fields ?? [], fieldId)) {
      const impact = discardImpactOf(fill?.fields ?? [], values, fieldId, value);
      if (impact.count > 0 && !window.confirm(discardWarningMessage(impact))) return;
    }

    setValues((v) => ({ ...v, [fieldId]: value }));
    setErrors((e) => (e[fieldId] ? { ...e, [fieldId]: '' } : e));
  }

  /**
   * Apply several answers as ONE change — Smart Fill's whole result.
   *
   * Deliberately not a loop over `setValue`. That raised a blocking
   * `window.confirm` per mapping for a single spoken sentence, and every one of
   * them weighed the change against the same pre-merge `values` closure, so
   * each question described a form state that never existed and the later
   * writes clobbered the earlier ones' reasoning. One merge, one discard check
   * against the merged result, one prompt.
   *
   * Returns whether the patch was applied: a respondent who declines the
   * discard warning has changed nothing, and the caller must not go on to
   * report answers as filled.
   */
  function applyValues(patch: Record<string, SubmissionValue>): boolean {
    const ids = Object.keys(patch);
    if (ids.length === 0) return true;

    // Read through the ref, not the closure: unlike `setValue` this is called
    // from a promise the respondent kicked off seconds earlier, so the captured
    // `values` may predate whatever they typed while the model was thinking.
    const impact = discardImpactOfPatch(fill?.fields ?? [], latestValues.current, patch);
    if (impact.count > 0 && !window.confirm(discardWarningMessage(impact))) return false;

    setValues((v) => ({ ...v, ...patch }));
    setErrors((e) => clearedErrors(e, ids));
    return true;
  }

  /**
   * Post one spoken description of the form and resolve the proposed answers.
   * `null` means the attempt failed and the respondent has already been told —
   * the caller applies nothing and the form is exactly as they left it.
   *
   * The transcript is text produced on-device; no audio is uploaded, and the
   * link token stays the only credential this page holds.
   */
  async function runSmartFill(transcript: string): Promise<SmartFillResult | null> {
    try {
      return await smartFill.mutateAsync({ token: token!, transcript });
    } catch (err) {
      // A timed-out request surfaces as `ApiError(0)` (api-client's abort,
      // raised to 60s for this endpoint — see SMART_FILL_TIMEOUT_MS), which
      // lands on the transient branch — the mic stays and the respondent is
      // told to try again or type, rather than the promise rejecting loose.
      const failure = smartFillFailure(err instanceof ApiError ? err.status : 0);
      if (failure.hide) setSmartFillRetired(true);
      toast({ variant: failure.hide ? 'warning' : 'danger', message: failure.message });
      return null;
    }
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

  // Identity is captured the same way in both bodies — the flat page shows it
  // at the top, the stepper shows it on its first screen — so it lives here
  // rather than being written twice and drifting.
  const identityBlock = (
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
  );

  const isConversational = resolveLayout(resolveTheme(fill.orgBranding?.theme).layout) === 'conversational';

  return (
    <ExternalShell orgName={fill.orgName} branding={fill.orgBranding}>
      {/* Arrangement (card / hero / split), container geometry and logo
          placement all come from the resolved theme. The field list and submit
          control below are identical across layouts -- only the framing
          differs, which is what stops the layouts drifting apart. */}
      <div className="flex w-full flex-col items-center">
      <FormLayoutFrame
        orgName={fill.orgName}
        formName={fill.formName}
        branding={fill.orgBranding}
        container={fill.container}
      >
        {/* Both branches filter hidden fields identically. The conversational
            layout paces one question at a time, so an unfiltered list would
            stop the respondent on a question their answers have already ruled
            out -- a worse failure there than a gap in a grid. */}
        {isConversational ? (
          <ConversationalFill
            fields={visibleFillFields(fill.fields, values)}
            allFields={fill.fields}
            values={values}
            errors={errors}
            setValue={setValue}
            applyValues={applyValues}
            onSubmit={() => onSubmit(fill)}
            submitting={submit.isPending}
            header={identityBlock}
            dictation
            smartFill={smartFillOffered ? runSmartFill : undefined}
            uploadPath={`/fill/${token}/uploads`}
          />
        ) : (
          <>
            {identityBlock}

            {/* The served version's real fields, via the shared renderer, on
                the builder's 12-col grid (single column below `sm`). Fields
                hidden by an unmet condition are filtered out before the grid
                is built, so they occupy no cell and leave no gap. */}
            <div className="grid grid-cols-12 gap-[16px]">
              {visibleFillFields(fill.fields, values).map((f) => (
                <div key={f.id} className={fillSpanClass(resolveFillSpan(f, false))}>
                  <FieldInput
                    field={f}
                    value={values[f.id] ?? null}
                    error={errors[f.id] || undefined}
                    incompleteRowIndexes={incompleteRows[f.id]}
                    dictation
                    onChange={(v) => setValue(f.id, v)}
                    uploadPath={`/fill/${token}/uploads`}
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
          </>
        )}
      </FormLayoutFrame>
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
