import { useMemo, useState } from 'react';
import { Button, Icon, Input, useToast } from '@formai/ui';
import { AUDIT_CATEGORY_META, AUDIT_FILTERS } from '../../lib/data/fixtures.js';
import { useAuditLog } from '../../lib/data/hooks.js';
import type { AuditEntry } from '../../lib/data/types.js';

/** Serialise audit entries to CSV and download. */
function exportCsv(rows: AuditEntry[]) {
  const header = ['Actor', 'Action', 'Target', 'Category', 'Time'];
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [
    header.join(','),
    ...rows.map((e) => [e.actor, e.action, e.target, e.category, e.time].map((v) => escape(String(v))).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'audit-log.csv';
  a.click();
  URL.revokeObjectURL(url);
}

/** Audit log — category pills, free-text search, export, live entry list. */
export function AuditScreen() {
  const { toast } = useToast();
  const { data: entries = [] } = useAuditLog();
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      const catOk = filter === 'all' || e.category === filter;
      const qOk = !q || `${e.actor} ${e.action} ${e.target}`.toLowerCase().includes(q);
      return catOk && qOk;
    });
  }, [entries, filter, query]);

  return (
    <div className="fai-rise mx-auto max-w-[880px] p-[30px_28px_60px]">
      {/* Controls */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex flex-1 flex-wrap gap-1.5">
          {AUDIT_FILTERS.map((f) => {
            const active = filter === f.key;
            return (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                aria-pressed={active}
                className="fai-chip-btn rounded-pill border px-3 py-1.5 font-ui text-[12.5px] font-semibold"
                style={{
                  borderColor: active ? 'var(--brand-slate)' : 'var(--border-default)',
                  background: active ? 'var(--brand-slate)' : 'var(--surface-card)',
                  color: active ? '#fff' : 'var(--text-secondary)',
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>
        <div className="w-[200px]">
          <Input
            leadingIcon="search"
            placeholder="Search log…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search audit log"
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          leadingIcon="download"
          onClick={() => {
            exportCsv(filtered);
            toast({ variant: 'success', message: 'Audit log exported as CSV (last 90 days).' });
          }}
        >
          Export
        </Button>
      </div>

      {/* Entry list */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface-card shadow-xs">
        {filtered.map((e) => {
          const meta = AUDIT_CATEGORY_META[e.category] ?? AUDIT_CATEGORY_META.general;
          return (
            <div
              key={e.id}
              className="flex items-center gap-[13px] border-b border-border-subtle px-[18px] py-[13px] last:border-b-0"
            >
              <span className="grid h-[34px] w-[34px] flex-none place-items-center rounded-full bg-surface-sunken">
                <Icon name={e.icon} size={16} className="text-text-secondary" />
              </span>
              <div className="min-w-0 flex-1 text-[13px] leading-[1.45]">
                <span className="font-semibold">{e.actor}</span>{' '}
                <span className="text-text-secondary">{e.action}</span>{' '}
                <span className="font-medium text-text-primary">{e.target}</span>
              </div>
              <span className="inline-flex flex-none items-center gap-1.5 rounded-pill bg-surface-sunken px-[9px] py-0.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />
                <span className="font-mono text-[10.5px] text-text-tertiary">{e.category}</span>
              </span>
              <span className="w-[118px] flex-none text-right text-[11.5px] text-text-tertiary">{e.time}</span>
            </div>
          );
        })}
        <div className="px-[18px] py-3 text-xs text-text-tertiary">
          Showing {filtered.length} of {entries.length} events
        </div>
      </div>
    </div>
  );
}
