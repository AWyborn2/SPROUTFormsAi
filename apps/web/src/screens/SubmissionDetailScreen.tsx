import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, Icon, RepeatingGroup, useToast } from '@formai/ui';
import type { FormField, SubmissionValue } from '@formai/shared';
import { resolveSubmitterIdentity, toDisplayRows } from '../lib/submission-display.js';
import {
  useExportSubmissionPdf,
  useSetSubmissionStatus,
  useSubmission,
  useSubmissions,
} from '../lib/data/hooks.js';
import { canExportSubmission } from '../lib/data/store.js';
import type { SubmissionDetail } from '../lib/data/types.js';
import { SubmissionStatusBadge } from './statusBadges.js';

type DetailView = 'pdf' | 'data';

/**
 * Submission detail. The "Captured data" view renders the submission's real
 * fields and submitted values (from `GET /submissions/:id`). The "PDF
 * round-trip" view is an honest status panel, not a rendered document: a
 * server-side filled-PDF preview is deferred, so it explains whether this
 * submission can round-trip and points at the real "Export filled PDF" button.
 */
export function SubmissionDetailScreen() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [params] = useSearchParams();
  const { data: submissions = [] } = useSubmissions();

  const id = params.get('id') ?? submissions[0]?.id;
  const sub = submissions.find((s) => s.id === id) ?? submissions[0];
  const [view, setView] = useState<DetailView>('data');
  const setStatus = useSetSubmissionStatus();
  // Detail carries the round-trip export handles: the version's stored
  // source-PDF asset and its frozen fields (with sourcePositions if any).
  const { data: detail } = useSubmission(sub?.id);
  const exportPdf = useExportSubmissionPdf();

  if (!sub) {
    return <div className="mx-auto max-w-[1080px] p-8 text-text-tertiary">Submission not found.</div>;
  }

  const decided = sub.status === 'approved' || sub.status === 'rejected';

  // Server-stamped session identity (verified) beats the free-text claim a
  // public fill-link submitter typed (unverified) — R15/KTD5.
  const identity = resolveSubmitterIdentity(sub.submittedBy, sub.who);

  // Exportability is decided by field positions, not asset presence: the AI
  // extraction path stores the PDF but emits no sourcePositions, and the
  // server silently skips positionless fields — only AcroForm imports
  // round-trip in v1. (The asset must also exist for the API call itself.)
  const exportable =
    !!detail && detail.sourcePdfAssetId !== null && canExportSubmission(detail.fields);

  const exportFilledPdf = () => {
    if (!detail) return;
    exportPdf.mutate(detail, {
      onSuccess: (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${sub.form || 'submission'}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast({
          message: 'Filled PDF exported — values overlaid on the original layout.',
          variant: 'success',
        });
      },
      onError: () =>
        toast({ message: 'Export failed — the filled PDF could not be generated.', variant: 'danger' }),
    });
  };

  const decide = (status: 'approved' | 'rejected') =>
    setStatus.mutate(
      { id: sub.id, status },
      {
        onSuccess: () =>
          toast({
            message: status === 'approved' ? 'Submission approved.' : 'Submission rejected.',
            variant: 'success',
          }),
        onError: () =>
          toast({
            message: `Could not ${status === 'approved' ? 'approve' : 'reject'} this submission.`,
            variant: 'danger',
          }),
      },
    );

  return (
    <div className="fai-rise mx-auto max-w-[1080px] p-[30px_28px_60px]">
      <button
        onClick={() => navigate('/app/submissions')}
        className="mb-3.5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-text-secondary hover:text-text-primary"
      >
        <Icon name="arrow-left" size={15} />
        All submissions
      </button>

      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <div className="mb-1.5 flex items-center gap-2.5">
            <span className="font-mono text-[12.5px] text-text-tertiary">{sub.id}</span>
            <SubmissionStatusBadge status={sub.status} />
          </div>
          <div className="mb-1 flex items-center gap-2.5">
            <h3 className="text-[21px]">{identity.name}</h3>
            {/* Badge takes no title, so the explanatory tooltip lives on a wrapper. */}
            <span
              title={
                identity.verified
                  ? 'Identity stamped server-side from the signed-in session'
                  : 'Name claimed by the submitter on a public fill link — not verified'
              }
            >
              <Badge variant={identity.verified ? 'success' : 'neutral'} dot={identity.verified}>
                {identity.verified ? 'Verified' : 'Unverified'}
              </Badge>
            </span>
          </div>
          <div className="text-[13px] text-text-secondary">
            {sub.form} · submitted {sub.date}
          </div>
        </div>
        <div className="flex flex-none gap-2.5">
          {/* Disabled buttons swallow pointer events, so the explanatory tooltip lives on a wrapper. */}
          <span
            title={
              exportable
                ? undefined
                : "This form's source PDF doesn't carry field positions — export is available for AcroForm-imported PDFs"
            }
          >
            <Button
              variant="outline"
              size="sm"
              leadingIcon="file-down"
              disabled={!exportable}
              loading={exportPdf.isPending}
              onClick={exportFilledPdf}
            >
              Export filled PDF
            </Button>
          </span>
          <Button
            variant="danger"
            size="sm"
            leadingIcon="x"
            disabled={decided || setStatus.isPending}
            loading={setStatus.isPending && setStatus.variables?.status === 'rejected'}
            onClick={() => decide('rejected')}
          >
            Reject
          </Button>
          <Button
            size="sm"
            leadingIcon="check"
            disabled={decided || setStatus.isPending}
            loading={setStatus.isPending && setStatus.variables?.status === 'approved'}
            onClick={() => decide('approved')}
          >
            Approve
          </Button>
        </div>
      </div>

      {/* View toggle */}
      <div className="mb-[18px] inline-flex gap-[3px] rounded-md border border-border-subtle bg-surface-sunken p-[3px]">
        {(
          [
            { key: 'data', label: 'Captured data' },
            { key: 'pdf', label: 'PDF round-trip' },
          ] as const
        ).map((t) => {
          const active = view === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setView(t.key)}
              className="rounded-sm px-[15px] py-[7px] text-[13px] font-semibold"
              style={{
                background: active ? 'var(--surface-card)' : 'transparent',
                boxShadow: active ? 'var(--shadow-xs)' : 'none',
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {view === 'pdf' ? (
        <PdfRoundTrip detail={detail} exportable={exportable} />
      ) : (
        <CapturedData detail={detail} />
      )}
    </div>
  );
}

/**
 * Format a single scalar submitted value for read-only display. Repeating
 * groups with column definitions render as a real table (see the
 * `repeating_group` branch in CapturedData); the row-count collapse here is
 * only the fallback for row arrays on fields with no column shape.
 */
function formatValue(value: SubmissionValue | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    if (value.length === 0) return '—';
    if (typeof value[0] === 'object' && value[0] !== null) {
      return `${value.length} row${value.length === 1 ? '' : 's'} captured`;
    }
    return (value as Array<string | number>).join(', ');
  }
  return String(value);
}

/**
 * Honest status for the round-trip export. A server-rendered filled-PDF
 * preview is deferred (v1), so this panel never fabricates a document — it
 * states whether this submission can round-trip and points at the real
 * "Export filled PDF" button in the header.
 */
function PdfRoundTrip({
  detail,
  exportable,
}: {
  detail: SubmissionDetail | null | undefined;
  exportable: boolean;
}) {
  if (detail === undefined) {
    return <LoadingPanel label="Checking round-trip availability…" />;
  }

  return (
    <div className="mx-auto max-w-[640px]">
      {exportable ? (
        <div className="rounded-lg border border-border-accent bg-surface-accent-soft p-[20px_22px]">
          <div className="mb-2 flex items-center gap-2.5">
            <Icon name="file-check" size={18} className="flex-none text-accent" />
            <span className="font-heading text-[15px] font-bold text-success-text">
              This submission can round-trip to a filled PDF
            </span>
          </div>
          <p className="text-[13px] leading-relaxed text-text-secondary">
            The source PDF carries field positions, so the captured values overlay back onto the
            original layout at their exact anchors. Use{' '}
            <strong className="font-semibold text-text-primary">Export filled PDF</strong> above to
            generate and download it.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-surface-card p-[20px_22px] shadow-xs">
          <div className="mb-2 flex items-center gap-2.5">
            <Icon name="file-x" size={18} className="flex-none text-text-tertiary" />
            <span className="font-heading text-[15px] font-bold text-text-primary">
              No filled-PDF round-trip for this form
            </span>
          </div>
          <p className="text-[13px] leading-relaxed text-text-secondary">
            This form's source PDF doesn't carry field positions — it was extracted by AI, which
            reads the fields but not their pixel anchors, so there's nothing to overlay values back
            onto. Round-trip export is available for AcroForm-imported PDFs. The captured answers are
            all in the <strong className="font-semibold text-text-primary">Captured data</strong> tab
            and still export via CSV and the API.
          </p>
        </div>
      )}
    </div>
  );
}

/** Shared skeleton while the submission detail is still loading. */
function LoadingPanel({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-card p-[18px_20px] text-sm text-text-secondary shadow-xs">
      <Icon name="loader-circle" size={16} className="animate-spin" />
      {label}
    </div>
  );
}

function CapturedData({ detail }: { detail: SubmissionDetail | null | undefined }) {
  if (detail === undefined) {
    return <LoadingPanel label="Loading captured data…" />;
  }
  if (!detail) return null;

  const fields = detail.fields;
  const inputFields = fields.filter((f: FormField) => f.type !== 'section_header');
  const answered = inputFields.filter((f) => {
    const v = detail.values[f.id];
    return v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);
  }).length;

  if (fields.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface-card p-[18px_20px] text-sm text-text-secondary shadow-xs">
        This submission's version has no fields.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3.5 text-[12.5px] text-text-tertiary">
        {answered} of {inputFields.length} field{inputFields.length === 1 ? '' : 's'} answered
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-surface-card shadow-xs">
        {fields.map((field: FormField) =>
          field.type === 'section_header' ? (
            <div
              key={field.id}
              className="border-b border-border-subtle bg-surface-sunken p-[12px_20px] font-mono text-[11px] uppercase tracking-wide text-text-tertiary last:border-b-0"
            >
              {field.label}
            </div>
          ) : field.type === 'repeating_group' && (field.columns?.length ?? 0) > 0 ? (
            /* Per-item checklist results, not "N rows captured": a read-only
               table whose fixed-row labels come from the pinned version's
               fixedRows (authoritative — KTD1), never the stored cells. */
            <div key={field.id} className="border-b border-border-subtle p-[11px_20px] last:border-b-0">
              <div className="mb-2 text-[13px] text-text-tertiary">
                {field.label}
                {field.required && <span className="ml-0.5 text-danger">*</span>}
              </div>
              <RepeatingGroup
                columns={field.columns ?? []}
                rows={toDisplayRows(field, detail.values[field.id])}
                fixedRows={field.fixedRows}
                onChange={() => undefined}
                readOnly
              />
            </div>
          ) : (
            <div
              key={field.id}
              className="flex gap-4 border-b border-border-subtle p-[11px_20px] last:border-b-0"
            >
              <span className="w-[200px] flex-none text-[13px] text-text-tertiary">
                {field.label}
                {field.required && <span className="ml-0.5 text-danger">*</span>}
              </span>
              <span className="flex-1 whitespace-pre-wrap text-[13.5px] font-medium text-text-primary">
                {formatValue(detail.values[field.id])}
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
