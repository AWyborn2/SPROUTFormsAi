import { Children, cloneElement, isValidElement, useId, useMemo, useState } from 'react';
import {
  CHC_ABN,
  CHC_DEPARTMENT_NAMES,
  CHC_DOCUMENT_REF,
  CHC_ETHNICITIES,
  CHC_GENDERS,
  CHC_INTAKE_FORM_NAME,
  CHC_INTAKE_RECIPIENT,
  CHC_LICENCE_CLASSES,
  CHC_ORG_NAME,
  CHC_SITE_SUBTITLE,
  CHC_STARTER_TYPES,
  formatAuDate,
  holidaysCoverThrough,
  nextBookableInductionDate,
} from '@formai/shared';
import { useCreateSubmission, useForms, useSession } from '../../lib/data/hooks.js';
import { ApiError } from '../../lib/data/api-client.js';
import {
  chcFullName,
  chcSubmissionValues,
  emptyChcIntakeState,
  isMultiRoleDepartment,
  rolesForDepartment,
  validateChcIntake,
  type ChcErrors,
  type ChcIntakeState,
} from '../../lib/chc-intake-form.js';
import { CHC_INTAKE_CSS, CHC_BORDER, CHC_NAVY, CHC_RED } from './chc-intake-styles.js';
import { ChcFileField } from './ChcFileField.js';

type View = 'form' | 'sending' | 'document';

/**
 * CHC @ BBM — Induction Intake Request Form.
 *
 * A purpose-built screen reproducing the approved design, alongside the same
 * form as an editable template (`chcIntakeFields()`, reachable from the form
 * library). It exists because three things the design depends on have no
 * expression in the generic field model: the Mondays-only + four-business-days
 * notice rule, department-scoped role lists whose shape changes between single
 * and multi select, and the branded print document at the end.
 *
 * Where the two overlap they share code rather than resembling each other — the
 * department/role map, the date rule and the field ids all come from
 * `@formai/shared/chc-intake`, and the values this screen submits are keyed by
 * the template's own field ids.
 *
 * Submission has two paths, and which one runs depends on real state rather
 * than a flag: if a PUBLISHED CHC template exists in the workspace, the answers
 * are recorded against it as an ordinary submission (pinned to its version, so
 * it appears in Submissions and exports like anything else). If none exists
 * yet, the screen still produces the document to print and email, and says
 * plainly that nothing was recorded — rather than implying a save that did not
 * happen.
 */
export function ChcIntakeScreen() {
  const { data: session } = useSession();
  const { data: forms = [] } = useForms();
  const createSubmission = useCreateSubmission();

  const [state, setState] = useState<ChcIntakeState>(emptyChcIntakeState);
  const [errors, setErrors] = useState<ChcErrors>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [view, setView] = useState<View>('form');
  const [submissionRef, setSubmissionRef] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState('');

  /** The published CHC template to record against, if the workspace has one. */
  const target = useMemo(
    () =>
      forms.find(
        (f) =>
          f.name === CHC_INTAKE_FORM_NAME &&
          f.status === 'published' &&
          f.currentVersionId !== null,
      ),
    [forms],
  );

  const minDate = useMemo(() => nextBookableInductionDate(), []);

  function set<K extends keyof ChcIntakeState>(key: K, value: ChcIntakeState[K]) {
    setState((s) => ({ ...s, [key]: value }));
    setErrors((e) => {
      if (!(key in e)) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
  }

  function onDepartmentChange(department: string) {
    // Roles are cleared, not carried: the previous department's roles are not
    // offered by the new one, and keeping them would submit a combination the
    // site does not induct (`validateChcIntake` refuses it, but silently
    // dropping is the honest behaviour rather than a late error).
    setState((s) => ({ ...s, department, role: [] }));
    setErrors((e) => {
      const next = { ...e };
      delete next.department;
      delete next.role;
      return next;
    });
  }

  function toggleRole(label: string) {
    setState((s) => ({
      ...s,
      role: s.role.includes(label) ? s.role.filter((r) => r !== label) : [...s.role, label],
    }));
    setErrors((e) => {
      if (!e.role) return e;
      const next = { ...e };
      delete next.role;
      return next;
    });
  }

  async function onSubmit() {
    const found = validateChcIntake(state);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      setSubmitAttempted(true);
      // Put the first problem on screen — on a phone the banner at the bottom
      // is often the only part visible, and it says nothing about which field.
      document.querySelector('[data-chc-error="true"]')?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
      return;
    }

    setErrors({});
    setSubmitAttempted(false);
    setSubmitError('');
    setView('sending');

    if (!target?.currentVersionId) {
      // No published template to pin to. The document is still produced — it is
      // what actually gets emailed — but nothing is claimed to be stored.
      setSubmissionRef(null);
      setView('document');
      return;
    }

    try {
      const row = await createSubmission.mutateAsync({
        templateId: target.id,
        versionId: target.currentVersionId,
        values: chcSubmissionValues(state),
      });
      setSubmissionRef(row.id);
      setView('document');
    } catch (err) {
      setSubmitError(
        err instanceof ApiError && err.status === 422
          ? 'The CHC template is no longer published, so this could not be recorded. The document below is still complete.'
          : err instanceof ApiError && err.status === 403
            ? "You don't have permission to record submissions. The document below is still complete."
            : 'Could not record this submission. The document below is still complete — print or email it, then try again.',
      );
      setSubmissionRef(null);
      setView('document');
    }
  }

  const hasErrors = Object.keys(errors).length > 0 && submitAttempted;
  // Identity comes from the session, never a typed-in claim: the API stamps the
  // submitter server-side anyway, so an editable "submitted by" box on the form
  // would print one name onto the document and record a different one.
  const submitterName = session?.userName ?? '';
  const submitterEmail = session?.userEmail ?? '';

  function emailDocument() {
    const subject = `CHC BBM Intake — ${chcFullName(state)} — ${formatAuDate(state.induction_date)}`;
    const lines = [
      'New Starter / Transfer Intake Submission',
      '',
      `Name: ${chcFullName(state)}`,
      `Gender: ${state.gender}`,
      `Ethnicity: ${state.ethnicity}`,
      `Type: ${state.starter_type}`,
      `Induction date: ${formatAuDate(state.induction_date)}`,
      `Department: ${state.department}`,
      `Role(s): ${state.role.join(', ')}`,
    ];
    {
      lines.push(
        '',
        '--- Additional Details ---',
        `Mobile: ${state.mobile}`,
        `Email: ${state.email}`,
        `DOB: ${formatAuDate(state.dob)}`,
        `Address: ${state.address_street}, ${state.suburb} ${state.postcode}`,
        `Emergency: ${state.emergency_contact_name} (${state.emergency_contact_phone})`,
        `Licence: ${state.licence_class} #${state.licence_number} exp ${formatAuDate(state.licence_expiry)}`,
        `Profile photo: ${state.photo?.fileName ?? '—'}`,
        `Licence image: ${state.drivers_licence?.fileName ?? '—'}`,
      );
    }
    lines.push('', `Submitted by: ${submitterName} (${submitterEmail})`);
    if (submissionRef) lines.push(`Reference: ${submissionRef}`);
    lines.push('', '(Attach the printed PDF to this email.)');

    window.open(
      `mailto:${CHC_INTAKE_RECIPIENT}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`,
      '_blank',
      'noopener,noreferrer',
    );
  }

  return (
    <div className="chc-root">
      <style>{CHC_INTAKE_CSS}</style>

      {/* Always-mounted live region (same rule as the fill surfaces'): a
          `role="status"` node inserted at the moment it gains text is often
          missed by screen readers. Without this, the sending → document swap
          is silent — the respondent is never told the submission completed. */}
      <p role="status" className="sr-only">
        {view === 'sending'
          ? 'Recording your submission.'
          : view === 'document'
            ? submissionRef
              ? 'Submission recorded. The completed intake document is shown.'
              : 'Intake document ready. It was not recorded — print or email it.'
            : ''}
      </p>

      <header
        className="chc-no-print"
        style={{
          backgroundColor: CHC_NAVY,
          padding: '12px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          position: 'sticky',
          top: 0,
          zIndex: 100,
          boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
        }}
      >
        <img src="/chc/logo-white.png" alt="Charles Hull Contracting" style={{ height: 34 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: '#fff', fontSize: 15, fontWeight: 700, lineHeight: 1.3 }}>
            {CHC_ORG_NAME}
          </div>
          <div
            style={{
              color: 'rgba(255,255,255,0.65)',
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.2px',
            }}
          >
            Induction Intake Request Form
          </div>
        </div>
        {view === 'document' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={() => window.print()} style={headerBtn} className="chc-btn-primary">
              <DownloadIcon />
              Download PDF
            </button>
            <button
              type="button"
              onClick={() => setView('form')}
              style={{ ...headerBtn, fontWeight: 500 }}
              className="chc-btn-ghost"
            >
              ← Edit form
            </button>
          </div>
        )}
      </header>

      {view === 'form' && (
        <div style={{ maxWidth: 600, margin: '0 auto', padding: '20px 16px 60px' }}>
          <Card title="Personal Details">
            <Row>
              <Field label="First name" required error={errors.first_name}>
                <input
                  className="chc-input"
                  style={inputStyle}
                  value={state.first_name}
                  placeholder="First name"
                  onChange={(e) => set('first_name', e.target.value)}
                />
              </Field>
              <Field label="Last name" required error={errors.last_name}>
                <input
                  className="chc-input"
                  style={inputStyle}
                  value={state.last_name}
                  placeholder="Last name"
                  onChange={(e) => set('last_name', e.target.value)}
                />
              </Field>
            </Row>

            <Field label="Middle name">
              <input
                className="chc-input"
                style={inputStyle}
                value={state.middle_name}
                onChange={(e) => set('middle_name', e.target.value)}
              />
            </Field>

            <Field label="Gender" required error={errors.gender} group="radiogroup">
              <ChoiceRow
                name="gender"
                options={[...CHC_GENDERS]}
                value={state.gender}
                onChange={(v) => set('gender', v)}
              />
            </Field>

            <Field label="Ethnicity" required error={errors.ethnicity} last>
              <select
                className="chc-select"
                style={{ ...inputStyle, background: '#fff', cursor: 'pointer' }}
                value={state.ethnicity}
                onChange={(e) => set('ethnicity', e.target.value)}
              >
                <option value="">Select an option…</option>
                {CHC_ETHNICITIES.map((eth) => (
                  <option key={eth} value={eth}>
                    {eth}
                  </option>
                ))}
              </select>
            </Field>
          </Card>

          <Card title="Employment Details">
            <Field
              label="New starter or transfer?"
              required
              error={errors.starter_type}
              group="radiogroup"
            >
              <ChoiceRow
                name="starter_type"
                options={[...CHC_STARTER_TYPES]}
                value={state.starter_type}
                onChange={(v) => set('starter_type', v)}
              />
            </Field>

            <Field
              label="Preferred induction date"
              required
              error={errors.induction_date}
              hint="Mondays only (Tuesday after a public holiday) · book by the Thursday before."
            >
              <input
                type="date"
                className="chc-input"
                style={inputStyle}
                value={state.induction_date}
                min={minDate}
                onChange={(e) => set('induction_date', e.target.value)}
              />
            </Field>

            <Field label="Department" required error={errors.department}>
              <select
                className="chc-select"
                style={{ ...inputStyle, background: '#fff', cursor: 'pointer' }}
                value={state.department}
                onChange={(e) => onDepartmentChange(e.target.value)}
              >
                <option value="">Select department…</option>
                {CHC_DEPARTMENT_NAMES.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </Field>

            <RoleField
              department={state.department}
              role={state.role}
              error={errors.role}
              onSingle={(v) => set('role', v ? [v] : [])}
              onToggle={toggleRole}
            />
          </Card>

          {(
            <Card title="Additional Details">
              <Row>
                <Field label="Mobile" required error={errors.mobile}>
                  <input
                    type="tel"
                    className="chc-input"
                    style={inputStyle}
                    value={state.mobile}
                    placeholder="Enter mobile"
                    onChange={(e) => set('mobile', e.target.value)}
                  />
                </Field>
                <Field label="Email" required error={errors.email}>
                  <input
                    type="email"
                    className="chc-input"
                    style={inputStyle}
                    value={state.email}
                    placeholder="Enter email"
                    onChange={(e) => set('email', e.target.value)}
                  />
                </Field>
              </Row>

              <Field label="Date of birth" required error={errors.dob}>
                <input
                  type="date"
                  className="chc-input"
                  style={inputStyle}
                  value={state.dob}
                  onChange={(e) => set('dob', e.target.value)}
                />
              </Field>

              <Field label="Street address" required error={errors.address_street}>
                <input
                  className="chc-input"
                  style={inputStyle}
                  value={state.address_street}
                  placeholder="Enter address"
                  onChange={(e) => set('address_street', e.target.value)}
                />
              </Field>

              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
                <Field label="Suburb" required error={errors.suburb}>
                  <input
                    className="chc-input"
                    style={inputStyle}
                    value={state.suburb}
                    placeholder="Enter suburb"
                    onChange={(e) => set('suburb', e.target.value)}
                  />
                </Field>
                <Field label="Postcode" required error={errors.postcode}>
                  <input
                    inputMode="numeric"
                    className="chc-input"
                    style={inputStyle}
                    value={state.postcode}
                    placeholder="0000"
                    onChange={(e) => set('postcode', e.target.value)}
                  />
                </Field>
              </div>

              <Row>
                <Field
                  label="Emergency contact name"
                  required
                  error={errors.emergency_contact_name}
                >
                  <input
                    className="chc-input"
                    style={inputStyle}
                    value={state.emergency_contact_name}
                    placeholder="Enter emergency contact"
                    onChange={(e) => set('emergency_contact_name', e.target.value)}
                  />
                </Field>
                <Field
                  label="Emergency contact phone"
                  required
                  error={errors.emergency_contact_phone}
                >
                  <input
                    type="tel"
                    className="chc-input"
                    style={inputStyle}
                    value={state.emergency_contact_phone}
                    placeholder="Enter emergency contact number"
                    onChange={(e) => set('emergency_contact_phone', e.target.value)}
                  />
                </Field>
              </Row>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                  gap: 12,
                }}
              >
                <Field label="Licence class" required error={errors.licence_class}>
                  <select
                    className="chc-select"
                    style={{ ...inputStyle, background: '#fff', cursor: 'pointer' }}
                    value={state.licence_class}
                    onChange={(e) => set('licence_class', e.target.value)}
                  >
                    <option value="">–</option>
                    {CHC_LICENCE_CLASSES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Licence expiry" required error={errors.licence_expiry}>
                  <input
                    type="date"
                    className="chc-input"
                    style={inputStyle}
                    value={state.licence_expiry}
                    onChange={(e) => set('licence_expiry', e.target.value)}
                  />
                </Field>
                <Field label="Licence number" required error={errors.licence_number}>
                  <input
                    className="chc-input"
                    style={inputStyle}
                    value={state.licence_number}
                    placeholder="Enter licence number"
                    onChange={(e) => set('licence_number', e.target.value)}
                  />
                </Field>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: 12,
                }}
              >
                <ChcFileField
                  label="Profile photo"
                  hint="JPG or PNG"
                  accept="image/jpeg,image/png"
                  value={state.photo}
                  error={errors.photo}
                  onChange={(ref) => set('photo', ref)}
                />
                <ChcFileField
                  label="Driver's licence image"
                  hint="JPG, PNG or PDF"
                  accept="image/jpeg,image/png,application/pdf"
                  value={state.drivers_licence}
                  error={errors.drivers_licence}
                  onChange={(ref) => set('drivers_licence', ref)}
                />
              </div>
            </Card>
          )}

          {hasErrors && (
            <div
              style={{
                background: '#FEF2F2',
                border: '1px solid #FECACA',
                borderRadius: 8,
                padding: '12px 16px',
                marginBottom: 14,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                color: '#991B1B',
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              <AlertIcon />
              Please fix the highlighted fields above before submitting.
            </div>
          )}

          <button
            type="button"
            className="chc-submit"
            onClick={() => void onSubmit()}
            disabled={createSubmission.isPending}
            style={{
              width: '100%',
              padding: '14px 24px',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontSize: 16,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'inherit',
              letterSpacing: '0.3px',
            }}
          >
            Submit
          </button>

          {!target && (
            <p style={{ marginTop: 12, fontSize: 12, color: '#666', textAlign: 'center' }}>
              No published “{CHC_INTAKE_FORM_NAME}” template in this workspace yet, so this
              submission will produce the document to print and email but will not be recorded.
              Publish the template from the form library to record submissions.
            </p>
          )}
        </div>
      )}

      {view === 'sending' && (
        <div style={{ maxWidth: 600, margin: '0 auto', padding: '80px 16px', textAlign: 'center' }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 64,
              height: 64,
              borderRadius: '50%',
              background: '#EBF5FF',
              marginBottom: 20,
            }}
          >
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke={CHC_NAVY}
              strokeWidth="2"
              strokeLinecap="round"
              className="chc-spin"
            >
              <path d="M12 2a10 10 0 0 1 10 10" strokeDasharray="31.4" strokeDashoffset="10" />
            </svg>
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: CHC_NAVY, marginBottom: 6 }}>
            Recording submission…
          </div>
          <div style={{ fontSize: 14, color: '#666' }}>Preparing the intake document.</div>
        </div>
      )}

      {view === 'document' && (
        <ChcDocument
          state={state}
          submissionRef={submissionRef}
          submitError={submitError}
          submitterName={submitterName}
          submitterEmail={submitterEmail}
          onEmail={emailDocument}
        />
      )}
    </div>
  );
}

/* ── Form primitives (CHC palette, not the app theme — see chc-intake-styles) ─ */

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 12px',
  border: `1px solid ${CHC_BORDER}`,
  borderRadius: 6,
  fontSize: 15,
  boxSizing: 'border-box',
  outline: 'none',
  fontFamily: 'inherit',
};

const headerBtn: React.CSSProperties = {
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '8px 16px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        background: '#fff',
        borderRadius: 10,
        padding: 20,
        marginBottom: 14,
        boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
      }}
    >
      <h2
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: CHC_NAVY,
          textTransform: 'uppercase',
          letterSpacing: '0.8px',
          margin: 0,
          marginBottom: subtitle ? 6 : 18,
          paddingBottom: subtitle ? 0 : 8,
          borderBottom: subtitle ? 'none' : `2px solid ${CHC_NAVY}`,
        }}
      >
        {title}
      </h2>
      {subtitle && (
        <p
          style={{
            fontSize: 12,
            color: '#666',
            margin: 0,
            marginBottom: 16,
            paddingBottom: 12,
            borderBottom: '1px solid #E2E8F0',
          }}
        >
          {subtitle}
        </p>
      )}
      {children}
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: 12,
      }}
    >
      {children}
    </div>
  );
}

const fieldLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 13,
  fontWeight: 600,
  color: '#333',
  marginBottom: 6,
};

/**
 * Labelled field wrapper, now with the association a visible label alone does
 * not provide. The single child control receives an `id` the `<label>` points
 * at, plus `aria-invalid` and an `aria-describedby` linking the hint and the
 * error — so a screen reader announces the label on focus and the error the
 * moment it appears, instead of an anonymous input next to an unclaimed alert.
 *
 * `group` switches the wiring for compound controls (the radio rows and the
 * multi-role checkbox list): those have no single labelable element, so the
 * child instead gets `role` + `aria-labelledby` pointing at the caption, which
 * becomes a span — a `<label>` may only reference a labelable element.
 */
function Field({
  label,
  required,
  error,
  hint,
  last,
  group,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  last?: boolean;
  /** Compound-control role; absent for single labelable controls. */
  group?: 'radiogroup' | 'group';
  children: React.ReactNode;
}) {
  const id = useId();
  const controlId = `${id}-control`;
  const labelId = `${id}-label`;
  const describedBy =
    [hint ? `${id}-hint` : null, error ? `${id}-err` : null].filter(Boolean).join(' ') ||
    undefined;

  const only = Children.only(children);
  const control = isValidElement(only)
    ? cloneElement(
        only as React.ReactElement<Record<string, unknown>>,
        group
          ? { role: group, 'aria-labelledby': labelId, 'aria-describedby': describedBy }
          : {
              id: controlId,
              'aria-invalid': error ? true : undefined,
              'aria-describedby': describedBy,
            },
      )
    : children;

  const caption = (
    <>
      {label}
      {required && <span style={{ color: CHC_RED }}> *</span>}
    </>
  );

  return (
    <div style={{ marginBottom: last ? 0 : 16 }} data-chc-error={error ? 'true' : undefined}>
      {group ? (
        <span id={labelId} style={fieldLabelStyle}>
          {caption}
        </span>
      ) : (
        <label htmlFor={controlId} style={fieldLabelStyle}>
          {caption}
        </label>
      )}
      {control}
      {hint && (
        <div id={`${id}-hint`} style={{ fontSize: 11, color: '#767676', marginTop: 3 }}>
          {hint}
        </div>
      )}
      {error && (
        <div id={`${id}-err`} role="alert" style={{ color: CHC_RED, fontSize: 12, marginTop: 3 }}>
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * The prototype's pill-shaped radio row. `rest` carries the `role` and aria
 * attributes `Field` injects for group labelling — forwarded onto the root so
 * the row announces as one named radiogroup rather than loose radios.
 */
function ChoiceRow({
  name,
  options,
  value,
  onChange,
  ...rest
}: {
  name: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
  role?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} {...rest}>
      {options.map((o) => (
        <label
          key={o}
          className="chc-choice"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            cursor: 'pointer',
            fontSize: 14,
            padding: '8px 14px',
            borderRadius: 6,
          }}
        >
          <input
            type="radio"
            name={name}
            value={o}
            checked={value === o}
            onChange={() => onChange(o)}
            style={{ width: 16, height: 16, accentColor: '#2E75B6', margin: 0 }}
          />
          {o}
        </label>
      ))}
    </div>
  );
}

/**
 * Role selection, which changes SHAPE with the department: Operations inducts
 * against more than one machine so it takes a set, every other department takes
 * exactly one. Before a department is chosen there is nothing honest to offer,
 * so it says so rather than presenting an empty dropdown.
 */
function RoleField({
  department,
  role,
  error,
  onSingle,
  onToggle,
}: {
  department: string;
  role: string[];
  error?: string;
  onSingle: (value: string) => void;
  onToggle: (label: string) => void;
}) {
  const roles = rolesForDepartment(department);

  if (!department) {
    // `group`: the placeholder is a div, and a label's `for` may only
    // reference a labelable element — this names it without pretending.
    return (
      <Field label="Role" required group="group" last>
        <div
          style={{
            padding: '10px 12px',
            border: '1px solid #E2E8F0',
            borderRadius: 6,
            fontSize: 14,
            color: '#64748B',
            background: '#FAFBFC',
          }}
        >
          Select a department first
        </div>
      </Field>
    );
  }

  if (!isMultiRoleDepartment(department)) {
    return (
      <Field label="Role" required error={error} last>
        <select
          className="chc-select"
          style={{ ...inputStyle, background: '#fff', cursor: 'pointer' }}
          value={role[0] ?? ''}
          onChange={(e) => onSingle(e.target.value)}
        >
          <option value="">Select role…</option>
          {roles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </Field>
    );
  }

  return (
    <Field
      label="Roles"
      required
      error={error}
      hint="Select one or more — dual roles are permitted for Operations."
      group="group"
      last
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          border: `1px solid ${CHC_BORDER}`,
          borderRadius: 8,
          padding: 4,
          maxHeight: 280,
          overflowY: 'auto',
        }}
      >
        {roles.map((r) => (
          <label
            key={r}
            className="chc-choice"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '9px 10px',
              borderRadius: 5,
              cursor: 'pointer',
              fontSize: 14,
              userSelect: 'none',
            }}
          >
            <input
              type="checkbox"
              checked={role.includes(r)}
              onChange={() => onToggle(r)}
              style={{ width: 17, height: 17, accentColor: '#2E75B6', flexShrink: 0, margin: 0 }}
            />
            <span>{r}</span>
          </label>
        ))}
      </div>
    </Field>
  );
}

/* ── The printed document ────────────────────────────────────────────────── */

function ChcDocument({
  state,
  submissionRef,
  submitError,
  submitterName,
  submitterEmail,
  onEmail,
}: {
  state: ChcIntakeState;
  submissionRef: string | null;
  submitError: string;
  submitterName: string;
  submitterEmail: string;
  onEmail: () => void;
}) {
  // Every intake now carries these — the Beakon exemption is gone.
  const showAdditional = true;
  const today = new Date();
  const printedOn = formatAuDate(
    `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
  );
  const recorded = submissionRef !== null;

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '20px 16px 60px' }}>
      <div
        className="chc-no-print"
        style={{
          background: recorded ? '#D4E7D4' : '#FEF7E0',
          borderRadius: 8,
          padding: '14px 16px',
          marginBottom: 16,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: recorded ? '#1B5E20' : '#7A5B00',
            fontSize: 14,
            fontWeight: 600,
            marginBottom: 8,
          }}
        >
          {recorded ? <CheckIcon /> : <AlertIcon />}
          {recorded
            ? `Recorded — ${chcFullName(state)}`
            : `Document ready — ${chcFullName(state)}`}
        </div>
        <div style={{ fontSize: 12, color: recorded ? '#2E7D32' : '#7A5B00', marginBottom: 10 }}>
          {submitError ||
            (recorded
              ? `Saved to Submissions · reference ${submissionRef}`
              : 'Not recorded in this workspace — print or email the document below.')}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onEmail}
            className="chc-btn-green"
            style={{ ...smallBtn, color: '#fff' }}
          >
            <MailIcon />
            Open in email client
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="chc-btn-green-soft"
            style={{ ...smallBtn, color: '#1B5E20' }}
          >
            <DownloadIcon />
            Save PDF locally
          </button>
        </div>
      </div>

      <article
        className="chc-doc"
        style={{
          background: '#fff',
          borderRadius: 4,
          boxShadow: '0 2px 12px rgba(0,0,0,0.1)',
          // Padding comes from .chc-doc (chc-intake-styles) so the phone
          // breakpoint can shrink it — inline padding would always win.
          color: '#1A202C',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6 }}>
          <img src="/chc/logo-dark.png" alt="" style={{ height: 38 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: CHC_NAVY }}>{CHC_ORG_NAME}</div>
            <div style={{ fontSize: 10, color: '#666', fontWeight: 500 }}>{CHC_ABN}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div
              style={{
                fontSize: 9,
                color: '#767676',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                fontWeight: 600,
              }}
            >
              Document ref
            </div>
            <div style={{ fontSize: 10, color: '#444', fontWeight: 500 }}>{CHC_DOCUMENT_REF}</div>
          </div>
        </div>
        <div style={{ borderBottom: `3px solid ${CHC_NAVY}`, marginBottom: 16 }} />
        <div style={{ fontSize: 18, fontWeight: 700, color: CHC_NAVY, marginBottom: 4 }}>
          Induction Intake Request Form
        </div>
        <div style={{ fontSize: 11, color: '#666', marginBottom: 20 }}>{CHC_SITE_SUBTITLE}</div>

        <DocSection title="Personal Details" />
        <DocGrid columns={3}>
          <DocCell label="First name" value={state.first_name.trim()} />
          <DocCell label="Middle name" value={state.middle_name.trim()} />
          <DocCell label="Last name" value={state.last_name.trim()} />
          <DocCell label="Gender" value={state.gender} />
          <DocCell label="Ethnicity" value={state.ethnicity} span={2} />
        </DocGrid>

        <DocSection title="Employment Details" />
        <DocGrid columns={2}>
          <DocCell label="Starter type" value={state.starter_type} />
          <DocCell label="Induction date" value={formatAuDate(state.induction_date)} />
          <DocCell label="Department" value={state.department} />
          <DocCell label="Role(s)" value={state.role.join(', ')} span={2} />
        </DocGrid>

        {showAdditional && (
          <>
            <DocSection title="Additional Details" />
            <DocGrid columns={2}>
              <DocCell label="Mobile" value={state.mobile.trim()} />
              <DocCell label="Email" value={state.email.trim()} />
              <DocCell label="Date of birth" value={formatAuDate(state.dob)} />
              <DocCell label="Street address" value={state.address_street.trim()} />
              <DocCell label="Suburb" value={state.suburb.trim()} />
              <DocCell label="Postcode" value={state.postcode.trim()} />
              <DocCell label="Emergency name" value={state.emergency_contact_name.trim()} />
              <DocCell label="Emergency phone" value={state.emergency_contact_phone.trim()} />
              <DocCell label="Licence class" value={state.licence_class} />
              <DocCell label="Licence expiry" value={formatAuDate(state.licence_expiry)} />
              <DocCell label="Licence number" value={state.licence_number.trim()} />
              <DocCell label="Attachments" value={attachmentSummary(state)} />
            </DocGrid>
          </>
        )}

        <DocSection title="Submitted by" />
        <DocGrid columns={3}>
          <DocCell label="Name" value={submitterName} />
          <DocCell label="Email" value={submitterEmail} />
          <DocCell label="Date" value={printedOn} />
        </DocGrid>

        {recorded && (
          <div style={{ fontSize: 9, color: '#767676', marginTop: 10 }}>
            Submission reference: {submissionRef}
          </div>
        )}

        <div
          style={{
            fontSize: 8,
            color: '#767676',
            textAlign: 'center',
            paddingTop: 8,
            marginTop: 14,
            borderTop: '1px solid #E2E8F0',
          }}
        >
          CHC @ BBM — Induction Intake Request Form · Confidential
        </div>
      </article>
    </div>
  );
}

/**
 * Attachments are named on the document rather than embedded. The stored bytes
 * are behind an authenticated route, so inlining them would either leak them
 * into a printed page that gets emailed around, or render as broken images for
 * anyone opening the PDF outside the app.
 */
function attachmentSummary(state: ChcIntakeState): string {
  const parts = [
    state.photo ? `Photo: ${state.photo.fileName}` : null,
    state.drivers_licence ? `Licence: ${state.drivers_licence.fileName}` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

function DocSection({ title }: { title: string }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 700,
        color: CHC_NAVY,
        textTransform: 'uppercase',
        letterSpacing: '0.8px',
        marginBottom: 8,
        paddingBottom: 4,
        borderBottom: `1.5px solid ${CHC_NAVY}`,
      }}
    >
      {title}
    </div>
  );
}

/**
 * Cell separators are drawn as a 1px GAP over a border-coloured background
 * rather than as per-cell borders. Per-cell borders double up against the
 * container's own frame at the first row and last column — a 2px edge on two
 * sides of every table, which on a printed document reads as a mistake. The gap
 * technique gives exactly one hairline everywhere, including between spanning
 * cells. It assumes full rows, which every table on this document has.
 */
function DocGrid({ columns, children }: { columns: number; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gap: 1,
        background: CHC_BORDER,
        marginBottom: 14,
        border: `1px solid ${CHC_BORDER}`,
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      {children}
    </div>
  );
}

function DocCell({ label, value, span }: { label: string; value: string; span?: number }) {
  return (
    <div
      style={{
        padding: '6px 10px',
        background: '#fff',
        gridColumn: span ? `span ${span}` : undefined,
      }}
    >
      <div
        style={{
          fontSize: 8,
          fontWeight: 700,
          color: '#767676',
          textTransform: 'uppercase',
          letterSpacing: '0.4px',
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 12, fontWeight: 500, minHeight: 15 }}>{value || '—'}</div>
    </div>
  );
}

const smallBtn: React.CSSProperties = {
  border: 'none',
  borderRadius: 6,
  padding: '7px 14px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
  display: 'flex',
  alignItems: 'center',
  gap: 5,
};

/* Inline SVGs, matching the prototype's glyphs exactly. */

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2E7D32" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
