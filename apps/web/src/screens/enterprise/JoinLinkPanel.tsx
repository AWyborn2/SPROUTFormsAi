import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Button, Icon } from '@formai/ui';
import { useCreateJoinLink, useJoinLinks, useRevokeJoinLink } from '../../lib/data/hooks.js';
import type { JoinLink } from '../../lib/data/assessments.js';

/**
 * Self-serve candidate access — a QR code for a toolbox talk.
 *
 * Deliberately separate from the invite dialog above it. An invite is one email
 * to one person; this is one code a room full of operators scan. The controls
 * reflect that difference: an expiry and a use cap are offered up front, because
 * a printed credential cannot be un-printed and refusing it server-side is the
 * only real recall.
 *
 * The role is not selectable. A join link always grants `candidate` — the API
 * pins it regardless of what is asked for — so there is nothing here to choose
 * and nothing to get wrong.
 */
export function JoinLinkPanel() {
  const { data: links = [], isLoading } = useJoinLinks();
  const create = useCreateJoinLink();
  const revoke = useRevokeJoinLink();

  const [label, setLabel] = useState('');
  const [days, setDays] = useState('30');
  const [maxUses, setMaxUses] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showing, setShowing] = useState<JoinLink | null>(null);

  const active = links.filter((l) => l.active);

  async function submit() {
    setError(null);
    const dayCount = Number(days);
    const uses = maxUses.trim() ? Number(maxUses) : null;
    if (maxUses.trim() && (!Number.isInteger(uses) || (uses ?? 0) < 1)) {
      setError('A use limit must be a whole number of at least 1.');
      return;
    }
    try {
      const created = await create.mutateAsync({
        label: label.trim() || undefined,
        expiresAt:
          Number.isFinite(dayCount) && dayCount > 0
            ? new Date(Date.now() + dayCount * 86_400_000).toISOString()
            : null,
        maxUses: uses,
      });
      setLabel('');
      setMaxUses('');
      setShowing(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the link.');
    }
  }

  const field = 'w-full rounded-md border border-border bg-surface-card p-[8px_10px] text-[13px]';
  const labelCls = 'block text-[12.5px] font-semibold text-text-secondary';

  return (
    <section className="mt-6 rounded-md border border-border bg-surface-card p-[18px_20px]">
      <div className="flex items-start gap-2.5">
        <Icon name="qr-code" size={20} className="mt-0.5 flex-none text-text-secondary" />
        <div className="min-w-0">
          <h2 className="font-heading text-[16px] font-bold">Candidate self-enrolment</h2>
          <p className="mt-0.5 text-[13px] text-text-tertiary">
            Share a link or QR code so operators can enrol themselves as candidates. Anyone who opens
            it joins as a candidate only — they see their own assessments and nothing else.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="jl-label" className={labelCls}>What it&rsquo;s for</label>
          <input
            id="jl-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Dozer intake — February"
            className={`${field} mt-1`}
          />
        </div>
        <div>
          <label htmlFor="jl-days" className={labelCls}>Expires in (days)</label>
          <input
            id="jl-days"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            inputMode="numeric"
            className={`${field} mt-1`}
          />
          <p className="mt-1 text-xs text-text-tertiary">Blank or 0 never expires.</p>
        </div>
        <div>
          <label htmlFor="jl-uses" className={labelCls}>Use limit (optional)</label>
          <input
            id="jl-uses"
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
            inputMode="numeric"
            placeholder="Unlimited"
            className={`${field} mt-1`}
          />
        </div>
      </div>

      {error && <p role="alert" className="mt-2.5 text-[13px] text-danger">{error}</p>}

      <div className="mt-3">
        <Button leadingIcon="plus" onClick={submit} disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create join link'}
        </Button>
      </div>

      {showing && <QrCard link={showing} onClose={() => setShowing(null)} />}

      <div className="mt-4 border-t border-border-subtle pt-3.5">
        {isLoading && <p className="text-[13px] text-text-tertiary">Loading links…</p>}
        {!isLoading && active.length === 0 && (
          <p className="text-[13px] text-text-tertiary">No active join links.</p>
        )}
        {active.map((l) => (
          <div key={l.id} className="flex flex-wrap items-center gap-3 border-b border-border-subtle py-2.5 last:border-0">
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-semibold">{l.label || 'Candidate join link'}</div>
              <div className="text-[12px] text-text-tertiary">
                {l.useCount} joined
                {l.maxUses ? ` of ${l.maxUses}` : ''}
                {l.expiresAt ? ` · expires ${new Date(l.expiresAt).toLocaleDateString()}` : ' · no expiry'}
              </div>
            </div>
            <button
              onClick={() => setShowing(l)}
              className="fai-chip-btn rounded-sm border border-border px-2.5 py-1 text-[12px] font-semibold text-text-secondary hover:bg-surface-hover"
            >
              Show QR
            </button>
            <button
              onClick={() => revoke.mutate(l.id)}
              disabled={revoke.isPending}
              className="fai-chip-btn rounded-sm border border-border px-2.5 py-1 text-[12px] font-semibold text-danger hover:bg-surface-hover"
            >
              Revoke
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * The scannable artefact.
 *
 * The QR is rendered from the FULL absolute URL, because a phone camera has no
 * origin to resolve a path against — the API deliberately returns only a path,
 * so the origin is added here where it is actually known.
 */
function QrCard({ link, onClose }: { link: JoinLink; onClose: () => void }) {
  const url = `${window.location.origin}${link.path}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    QRCode.toString(url, { type: 'svg', margin: 1, width: 200, errorCorrectionLevel: 'M' })
      .then((out) => {
        if (!cancelled) setSvg(out);
      })
      .catch(() => {
        if (!cancelled) setSvg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="mt-4 flex flex-wrap items-start gap-5 rounded-md border border-border-accent bg-surface-2 p-[16px_18px]">
      <div className="flex-none rounded-md bg-white p-2.5">
        {svg ? (
          <div
            aria-label="QR code for the candidate join link"
            role="img"
            className="h-[180px] w-[180px] [&>svg]:h-full [&>svg]:w-full"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="grid h-[180px] w-[180px] place-items-center text-[12px] text-text-tertiary">
            QR unavailable — use the link
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold">{link.label || 'Candidate join link'}</div>
        <p className="mt-1 text-[12.5px] text-text-tertiary">
          Print this, or send the link. Whoever opens it signs in and joins as a candidate.
        </p>

        <div className="mt-2.5 break-all rounded-sm border border-border bg-surface-card p-2 font-mono text-[11.5px] text-text-secondary">
          {url}
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            onClick={copy}
            className="fai-chip-btn inline-flex items-center gap-1.5 rounded-sm border border-border px-2.5 py-1 text-[12px] font-semibold text-text-secondary hover:bg-surface-hover"
          >
            <Icon name={copied ? 'check' : 'copy'} size={13} />
            {copied ? 'Copied' : 'Copy link'}
          </button>
          <button onClick={() => window.print()} className="fai-chip-btn inline-flex items-center gap-1.5 rounded-sm border border-border px-2.5 py-1 text-[12px] font-semibold text-text-secondary hover:bg-surface-hover">
            <Icon name="printer" size={13} />
            Print
          </button>
          <button onClick={onClose} className="text-[12.5px] text-text-tertiary">Close</button>
        </div>
      </div>
    </div>
  );
}
