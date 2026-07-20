import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, DataGrid, Icon, Input, Select, useToast, type DataGridColumn } from '@formai/ui';
import type { SubmissionStatus } from '@formai/shared';
import { useForms, useSubmissions } from '../lib/data/hooks.js';
import type { SubmissionRow } from '../lib/data/types.js';
import { SUBMISSION_TABS, SubmissionStatusBadge } from './statusBadges.js';

/** Serialise the current rows to a CSV string and trigger a download. */
function exportCsv(rows: SubmissionRow[]) {
  const header = ['ID', 'Submitted by', 'Email', 'Form', 'Received', 'Status', 'Flag'];
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [
    header.join(','),
    ...rows.map((r) =>
      [r.id, r.who, r.email, r.form, r.date, r.status, r.flag].map((v) => escape(String(v))).join(','),
    ),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'submissions.csv';
  a.click();
  URL.revokeObjectURL(url);
}

/** Submissions table — filter by form + status, search, row-select, export. */
export function SubmissionsScreen() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: submissions = [] } = useSubmissions();
  const { data: forms = [] } = useForms();

  const [tab, setTab] = useState<'all' | SubmissionStatus>('all');
  const [formFilter, setFormFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return submissions.filter((s) => {
      if (tab !== 'all' && s.status !== tab) return false;
      if (formFilter !== 'all' && s.formId !== formFilter) return false;
      if (!q) return true;
      return (
        s.who.toLowerCase().includes(q) ||
        s.email.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q)
      );
    });
  }, [submissions, tab, formFilter, query]);

  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = { all: submissions.length };
    for (const t of SUBMISSION_TABS) {
      if (t.key === 'all') continue;
      counts[t.key] = submissions.filter((s) => s.status === t.key).length;
    }
    return counts;
  }, [submissions]);

  const formOptions = [
    { label: 'All forms', value: 'all' },
    ...forms.map((f) => ({ label: f.name, value: f.id })),
  ];

  const columns: Array<DataGridColumn<SubmissionRow>> = [
    {
      key: 'id',
      header: 'ID',
      width: '84px',
      sortValue: (r) => r.id,
      render: (r) => <span className="font-mono text-[12.5px] text-text-secondary">{r.id}</span>,
    },
    {
      key: 'who',
      header: 'Submitted by',
      sortValue: (r) => r.who,
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-semibold">{r.who}</div>
          <div className="truncate text-xs text-text-tertiary">{r.email}</div>
        </div>
      ),
    },
    {
      key: 'form',
      header: 'Form',
      sortValue: (r) => r.form,
      render: (r) => <span className="text-[13px] text-text-secondary">{r.form}</span>,
    },
    {
      key: 'date',
      header: 'Received',
      width: '160px',
      sortValue: (r) => r.date,
      render: (r) => <span className="text-[12.5px] text-text-secondary">{r.date}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      width: '150px',
      sortValue: (r) => r.status,
      render: (r) => (
        <span className="flex items-center gap-2">
          <SubmissionStatusBadge status={r.status} />
          {r.flag && (
            <span title={r.flag} className="text-warning-text">
              <Icon name="flag" size={12} />
            </span>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="fai-rise mx-auto max-w-[1160px] p-[30px_28px_60px]">
      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-[230px]">
          <Select
            options={formOptions}
            value={formFilter}
            onChange={(e) => setFormFilter(e.target.value)}
            aria-label="Filter by form"
          />
        </div>
        <div className="min-w-[200px] flex-1">
          <Input
            leadingIcon="search"
            placeholder="Search by submitter, email or ID…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search submissions"
          />
        </div>
        <Button variant="outline" size="sm" leadingIcon="download" onClick={() => exportCsv(filtered)}>
          Export CSV
        </Button>
      </div>

      {/* Status tabs */}
      <div className="flex gap-0.5 border-b border-border">
        {SUBMISSION_TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className="relative flex items-center gap-2 px-3.5 py-2.5 text-[13.5px] font-semibold"
              style={{ color: active ? 'var(--text-primary)' : 'var(--text-tertiary)' }}
            >
              {t.label}
              <span
                className="rounded-pill px-[7px] py-px font-mono text-[11px]"
                style={{ background: active ? 'var(--surface-accent-soft)' : 'var(--surface-sunken)' }}
              >
                {tabCounts[t.key] ?? 0}
              </span>
              {active && <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-t bg-accent" />}
            </button>
          );
        })}
      </div>

      {/* Bulk-select bar */}
      {selected.size > 0 && (
        <div className="fai-fade mt-3.5 flex items-center gap-3 rounded-md bg-brand-slate px-4 py-2.5 text-white">
          <Icon name="check-square" size={17} color="#8fd6ad" />
          <span className="text-[13px] font-semibold">{selected.size} selected</span>
          <span className="flex-1" />
          <button
            onClick={() => {
              exportCsv(filtered.filter((r) => selected.has(r.id)));
            }}
            className="rounded-sm border border-white/20 bg-white/5 px-3 py-1.5 text-[12.5px] font-semibold"
          >
            Export
          </button>
          <button
            onClick={() => {
              toast({ message: `${selected.size} submission(s) approved.`, variant: 'success' });
              setSelected(new Set());
            }}
            className="rounded-sm bg-brand-green px-3 py-1.5 text-[12.5px] font-bold text-[#12321f]"
          >
            Approve
          </button>
          <button onClick={() => setSelected(new Set())} className="px-2.5 py-1.5 text-[12.5px] text-white/70">
            Clear
          </button>
        </div>
      )}

      <div className="mt-4">
        <DataGrid
          aria-label="Submissions"
          columns={columns}
          rows={filtered}
          rowKey={(r) => r.id}
          selectable
          selectedKeys={selected}
          onSelectionChange={setSelected}
          onRowActivate={(r) => navigate(`/app/submissions/detail?id=${r.id}`)}
          empty="No submissions match these filters."
        />
        <div className="px-1 pt-3 text-xs text-text-tertiary">
          Showing {filtered.length} of {submissions.length} submissions
        </div>
      </div>
    </div>
  );
}
