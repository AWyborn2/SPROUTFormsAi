import { useState } from 'react';
import { Badge, Button, Card, Icon } from '@formai/ui';
import {
  useRunWorkforceImport,
  useValidateWorkforceImport,
  useWorkforceImportRun,
} from '../../lib/data/hooks.js';
import { store } from '../../lib/data/store.js';
import type { WorkforceImportPreview } from '../../lib/data/types.js';

/**
 * Bulk workforce import (U23, U24).
 *
 * THREE STATES, and the separation is the whole point (R144). Before upload:
 * the template and a file picker. After validation: what the file costs, above
 * the rows it would refuse. Then confirm or abandon — and abandoning writes
 * nothing, because validation never wrote anything to begin with.
 *
 * The file is held in the page between validating and confirming, and sent
 * again on confirm. The server re-validates it rather than trusting a
 * client-supplied list of approved rows, which is also why the Admin can leave
 * the preview open while somebody edits the taxonomy without landing rows
 * against values that have since been retired.
 */
export function WorkforceImportScreen() {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [runId, setRunId] = useState<string | undefined>();

  const validate = useValidateWorkforceImport();
  const run = useRunWorkforceImport();
  const report = useWorkforceImportRun(runId);
  const preview = validate.data;

  async function downloadTemplate() {
    const text = await store.getWorkforceImportTemplate();
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'workforce-import-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    setRunId(undefined);
    validate.mutate(text);
  }

  return (
    <div className="fai-rise mx-auto grid max-w-[900px] gap-5 p-[30px_28px_60px]">
      <div>
        <h2 className="font-heading text-xl font-bold">Import your workforce</h2>
        <p className="mt-1 text-sm text-text-tertiary">
          Fill the template, check what it will cost, then confirm. Nothing is written until you do.
        </p>
      </div>

      {/*
        R172: the ordering is stated BEFORE a run, not discovered afterwards.
        Importing people before their Roles carry requirements assigns nothing,
        which looks like a broken import rather than the correct outcome.
      */}
      <Card className="flex items-start gap-2 p-4">
        <Icon name="info" size={16} className="mt-0.5 text-text-tertiary" />
        <p className="text-[12.5px] text-text-tertiary">
          Configure your Locations, Departments, Roles and each Role&rsquo;s required assessments
          first. People imported before that is done are created correctly but are assigned nothing,
          because there is nothing yet to assign.
        </p>
      </Card>

      {runId ? (
        <RunReport runId={runId} report={report.data} />
      ) : (
        <>
          <Card className="grid gap-3 p-5">
            <h3 className="font-ui text-sm font-semibold">1 · The template</h3>
            <p className="text-[12.5px] text-text-tertiary">
              Two sections in one file: one row per person, then one line per competency they
              already hold.
            </p>
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={downloadTemplate}>
                Download template
              </Button>
              <label className="cursor-pointer text-[12.5px] font-medium text-accent">
                <input type="file" accept=".csv,text/csv" className="hidden" onChange={pick} />
                {fileName || 'Choose a filled file…'}
              </label>
            </div>
          </Card>

          {validate.isPending && (
            <Card className="p-5 text-sm text-text-tertiary">Checking every row…</Card>
          )}
          {validate.isError && (
            <Card className="p-5 text-sm text-danger-text">That file could not be read.</Card>
          )}

          {preview && (
            <>
              <CostPreview preview={preview} />
              {preview.rejected.length > 0 && <RejectionTable preview={preview} />}
              <Card className="flex items-center justify-between gap-3 p-5">
                <p className="text-[12.5px] text-text-tertiary">
                  {preview.validRows} row{preview.validRows === 1 ? '' : 's'} will be imported.
                  {preview.rejected.length > 0 && ' The rejected rows are skipped.'}
                </p>
                <span className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      // Abandoning writes nothing, because validating wrote nothing.
                      setCsv(null);
                      setFileName('');
                      validate.reset();
                    }}
                  >
                    Abandon
                  </Button>
                  <Button
                    disabled={!csv || preview.validRows === 0 || run.isPending}
                    onClick={() =>
                      csv && run.mutate(csv, { onSuccess: (r) => setRunId(r.runId) })
                    }
                  >
                    {run.isPending ? 'Importing…' : 'Confirm and import'}
                  </Button>
                </span>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * What the file costs, per pool (R144).
 *
 * Both are shown even when one is zero: an Admin reading a single figure cannot
 * tell which allocation it came out of, and the two are metered separately.
 */
function CostPreview({ preview }: { preview: WorkforceImportPreview }) {
  const { candidate, staff, blocks, refusedForSeats } = preview.preview;
  const pools = [
    { label: 'Candidate seats', cost: candidate },
    { label: 'Staff seats', cost: staff },
  ];
  return (
    <Card className="grid gap-3 p-5">
      <h3 className="font-ui text-sm font-semibold">2 · What this will cost</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {pools.map((p) => (
          <div key={p.label} className="rounded-md bg-surface-sunken p-3">
            <p className="text-[12px] text-text-tertiary">{p.label}</p>
            <p className="mt-0.5 text-[13.5px] font-semibold tabular-nums">
              {p.cost.needed} needed
              {p.cost.available === null
                ? ' · allocation unlimited'
                : ` · ${p.cost.covered} covered, ${p.cost.overflow} over`}
            </p>
          </div>
        ))}
      </div>
      {blocks.length > 0 && (
        <p className="text-[12.5px] text-warning-text">
          {/* R86: the candidate pool expands rather than refusing, and the
              purchase is quoted here so the confirmation is informed. */}
          {blocks.map((b) => `${b.count} × ${b.size} candidate seats`).join(', ')} will be added and
          charged to cover the overflow.
        </p>
      )}
      {refusedForSeats > 0 && (
        <p className="text-[12.5px] text-danger-text">
          {refusedForSeats} row{refusedForSeats === 1 ? '' : 's'} will be refused for want of a staff
          seat — that pool does not expand.
        </p>
      )}
    </Card>
  );
}

function RejectionTable({ preview }: { preview: WorkforceImportPreview }) {
  function downloadRejected() {
    /*
      Re-exported in the TEMPLATE's own shape so the Admin fixes this file and
      sends it back, rather than hunting the rejected rows through the original.
    */
    const rows = preview.rejected.map((r) => `${r.rowNumber},${r.subject},${r.reason},${r.detail ?? ''}`);
    const text = ['row,subject,reason,detail', ...rows].join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'workforce-import-rejected.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-ui text-sm font-semibold">
          Rows that will be skipped ({preview.rejected.length})
        </h3>
        <Button variant="ghost" onClick={downloadRejected}>
          Download these rows
        </Button>
      </div>
      <ul className="mt-3 flex flex-col gap-1">
        {preview.rejected.map((r) => (
          <li
            key={`${r.rowNumber}-${r.reason}`}
            className="flex items-center justify-between gap-3 rounded-md bg-surface-sunken px-3 py-1.5 text-[12.5px]"
          >
            <span className="w-[46px] shrink-0 tabular-nums text-text-tertiary">#{r.rowNumber}</span>
            <span className="min-w-0 flex-1 truncate font-medium">{r.subject}</span>
            <Badge variant="danger">{r.reason.replace(/_/g, ' ')}</Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * The run report (R171).
 *
 * Polls while the run is in flight, then renders the finished report from the
 * same route — which is what makes it survive the tab being closed.
 */
function RunReport({ runId, report }: { runId: string; report?: ReturnType<typeof useWorkforceImportRun>['data'] }) {
  if (!report) {
    return <Card className="p-5 text-sm text-text-tertiary">Starting the import…</Card>;
  }
  const done = report.completedAt !== null;
  const figures: Array<[string, number]> = [
    ['Profiles created', report.profilesCreated],
    ['People merged', report.peopleMerged],
    ['Memberships added', report.membershipsAdded],
    ['Memberships reactivated', report.membershipsReactivated],
    ['Candidate seats used', report.candidateSeats],
    ['Staff seats used', report.staffSeats],
    ['Competencies recorded', report.competenciesRecorded],
    ['Lines with no date', report.linesFlaggedNoDate],
    ['Assessments assigned', report.assessmentsAssigned],
    ['Profiles flagged incomplete', report.profilesFlaggedIncomplete],
    ['Differences reported', report.differencesReported],
    ['Rows rejected', report.rejected.length],
  ];

  return (
    <>
      <Card className="p-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-ui text-sm font-semibold">{done ? 'Import complete' : 'Importing…'}</h3>
          <span className="text-[12.5px] tabular-nums text-text-tertiary">
            {report.rowsProcessed} of {report.rowsTotal} rows
          </span>
        </div>
        <p className="mt-1 text-[12px] text-text-tertiary">
          Report {runId} — keep this reference; it stays readable after you close this page.
        </p>
        <dl className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {figures.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-3 border-b border-border-subtle py-1">
              <dt className="text-[12px] text-text-tertiary">{label}</dt>
              <dd className="text-[12.5px] font-semibold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {report.differences.length > 0 && (
        <Card className="p-5">
          <h3 className="font-ui text-sm font-semibold">Differences to settle</h3>
          {/*
            R149: a value differing from what an existing ACTIVE membership
            carries is REPORTED, never written over — an import must not be able
            to demote an administrator on the strength of a column. Each links to
            the record where an Admin takes the file's value or keeps theirs.
          */}
          <p className="mt-1 text-[12px] text-text-tertiary">
            These people already had a record. Nothing was overwritten — open each to take the
            file&rsquo;s value or keep what they carry.
          </p>
          <ul className="mt-3 flex flex-col gap-1">
            {report.differences.map((d) => (
              <li
                key={d.rowNumber}
                className="flex items-center justify-between gap-3 rounded-md bg-surface-sunken px-3 py-1.5 text-[12.5px]"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{d.subject}</span>
                <span className="truncate text-text-tertiary">
                  {d.items.map((i) => i.field).join(', ')}
                </span>
                {d.membershipId && (
                  <a className="shrink-0 font-medium text-accent" href={`/app/profile/${d.membershipId}`}>
                    Open record
                  </a>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {report.rejected.length > 0 && (
        <Card className="p-5">
          <h3 className="font-ui text-sm font-semibold">Rows rejected ({report.rejected.length})</h3>
          <ul className="mt-3 flex flex-col gap-1">
            {report.rejected.map((r) => (
              <li
                key={`${r.rowNumber}-${r.reason}`}
                className="flex items-center justify-between gap-3 rounded-md bg-surface-sunken px-3 py-1.5 text-[12.5px]"
              >
                <span className="w-[46px] shrink-0 tabular-nums text-text-tertiary">#{r.rowNumber}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{r.subject}</span>
                <Badge variant="danger">{r.reason.replace(/_/g, ' ')}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
