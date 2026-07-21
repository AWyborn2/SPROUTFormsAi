import { useState } from 'react';
import { Icon, Input } from '@formai/ui';
import type { BrandingKit } from '@formai/shared';
import { useBrandScan } from '../../lib/data/hooks.js';
import type { BrandScanProposal } from '../../lib/data/types.js';
import { buildScanPatch } from '../../lib/brand-scan-apply.js';

interface BrandScanPanelProps {
  branding: BrandingKit;
  onApply: (patch: Partial<BrandingKit>) => void;
  disabled?: boolean;
}

/**
 * "Scan my website" — enter a URL, review what was found, apply what you want.
 *
 * The review step is mandatory by design rather than by convention. Every
 * value shown here comes from a document the org's visitors (and anyone else)
 * can influence, so nothing is written until the owner presses Apply, and the
 * proposal is shown as swatches and a named font rather than as a fait
 * accompli.
 *
 * Partial results are the normal case, not an error: plenty of real sites
 * render their styling in the browser and yield little to a static fetch. The
 * panel surfaces what it did find plus the scan's own notes, so "we got two of
 * the three colours" reads as progress rather than failure.
 */
export function BrandScanPanel({ branding, onApply, disabled }: BrandScanPanelProps) {
  const [url, setUrl] = useState('');
  const [proposal, setProposal] = useState<BrandScanProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scan = useBrandScan();

  const run = () => {
    if (!url.trim()) return;
    setError(null);
    setProposal(null);
    scan.mutate(
      { url },
      {
        onSuccess: (result) => setProposal(result),
        onError: (err) => {
          const detail = (err as { body?: { reason?: string } })?.body?.reason;
          setError(
            detail === 'blocked_address'
              ? 'That address is not reachable from the public internet.'
              : detail === 'blocked_scheme'
                ? 'Enter a normal website address.'
                : 'We could not read that site. Check the address, or set your branding by hand.',
          );
        },
      },
    );
  };

  const patch = proposal ? buildScanPatch(proposal, branding) : null;
  const hasSomething = !!patch && Object.keys(patch).length > 0;

  return (
    <div className="rounded-md border border-dashed border-border-strong p-3.5">
      <div className="mb-1 flex items-center gap-2">
        <Icon name="sparkles" size={14} className="text-accent" />
        <span className="text-[13px] font-semibold">Start from your website</span>
      </div>
      <p className="mb-2.5 text-[12px] text-text-tertiary">
        We&rsquo;ll read your site and suggest colours, a font and a logo. Nothing is saved until
        you apply it.
      </p>

      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Input
            label="Website address"
            placeholder="yourcompany.com"
            value={url}
            disabled={disabled || scan.isPending}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') run();
            }}
          />
        </div>
        <button
          type="button"
          onClick={run}
          disabled={disabled || scan.isPending || !url.trim()}
          className="fai-chip-btn h-9 flex-none rounded-md border border-border bg-surface-card px-3 text-xs font-semibold disabled:opacity-60"
        >
          {scan.isPending ? 'Scanning…' : 'Scan'}
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-danger">
          <Icon name="info" size={13} className="mt-px flex-none" />
          {error}
        </p>
      )}

      {proposal && (
        <div className="mt-3 border-t border-border-subtle pt-3">
          {proposal.empty ? (
            <p className="text-[12.5px] text-text-secondary">
              Nothing usable came back from {proposal.sourceUrl}. Set your branding by hand below —
              it only takes a minute.
            </p>
          ) : (
            <>
              <div className="mb-2 text-[12px] font-semibold text-text-primary">
                Found on {proposal.siteName || proposal.sourceUrl}
              </div>

              {proposal.palette.length > 0 && (
                <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
                  {proposal.palette.map((hex) => (
                    <span key={hex} className="flex items-center gap-1.5">
                      <span
                        className="h-5 w-5 rounded border border-border"
                        style={{ background: hex }}
                      />
                      <span className="font-mono text-[10.5px] text-text-tertiary">{hex}</span>
                    </span>
                  ))}
                </div>
              )}

              {proposal.font && (
                <div className="mb-2.5 text-[12px] text-text-secondary">
                  Font: <span className="font-semibold">{proposal.font}</span>
                </div>
              )}

              {proposal.logoCandidates.length > 0 && (
                <div className="mb-2.5 flex items-center gap-2">
                  <span className="text-[12px] text-text-secondary">Logo:</span>
                  {proposal.logoCandidates.slice(0, 3).map((src) => (
                    <img
                      key={src}
                      src={src}
                      alt="Logo found on your site"
                      className="h-7 w-7 rounded border border-border object-contain p-0.5"
                    />
                  ))}
                  <span className="text-[11px] text-text-tertiary">
                    upload it below to use one
                  </span>
                </div>
              )}

              <button
                type="button"
                disabled={disabled || !hasSomething}
                onClick={() => patch && onApply(patch)}
                className="fai-chip-btn rounded-md border border-border bg-surface-card px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
              >
                Apply these suggestions
              </button>
            </>
          )}

          {proposal.notes.length > 0 && (
            <ul className="mt-2.5 flex flex-col gap-1">
              {proposal.notes.map((note) => (
                <li key={note} className="flex items-start gap-1.5 text-[11.5px] text-text-tertiary">
                  <Icon name="info" size={12} className="mt-px flex-none" />
                  {note}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
