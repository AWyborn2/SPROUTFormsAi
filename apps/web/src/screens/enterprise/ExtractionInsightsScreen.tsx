import { Badge, Icon } from '@formai/ui';
import { useCorrectionCandidates, usePlacementInsights } from '../../lib/data/hooks.js';
import type { PlacementInsights } from '../../lib/data/types.js';

/**
 * Import insights — the human-gated read surface of BOTH import learning loops.
 *
 * As reviewers correct imported PDFs, the corrections that recur are clustered
 * into content-free shapes; as they fix auto-placed geometry, the placement
 * outcomes are tallied the same way. This screen answers "is the import
 * pipeline getting better" in one place: the extraction candidate rules, and
 * the placement hit-rate beside them. It is READ-ONLY on purpose: acting on
 * either surface means a maintainer writing a profile rule or changing an
 * engine heuristic in a reviewed PR — nothing is ever changed from here, or
 * from any runtime path.
 */
export function ExtractionInsightsScreen() {
  const { data, isLoading, isError } = useCorrectionCandidates();
  const placement = usePlacementInsights();
  const candidates = data?.candidates ?? [];

  return (
    <div className="fai-rise mx-auto max-w-[980px] p-[30px_28px_60px]">
      <div className="mb-[18px]">
        <p className="max-w-[660px] text-sm text-text-secondary">
          When someone corrects a field while reviewing an imported PDF, the loop records what
          changed. Corrections that recur — the same kind of mistake, across papers — surface here as
          candidate rules. Each names the rule worth strengthening. Nothing here changes extraction:
          a maintainer applies a candidate by writing a rule in a reviewed code change.
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-surface-card shadow-xs">
        <div className="flex items-center gap-[14px] border-b border-border-subtle px-[18px] py-[11px] font-mono text-[10.5px] uppercase tracking-[0.06em] text-text-tertiary">
          <span className="w-[70px]">Seen</span>
          <span className="w-[220px]">Shape</span>
          <span className="flex-1">Suggested rule</span>
          <span className="w-[110px]">Document</span>
        </div>

        {isLoading && <p className="px-[18px] py-6 text-sm text-text-tertiary">Loading…</p>}

        {isError && !isLoading && (
          <p className="px-[18px] py-6 text-sm text-text-tertiary">
            These insights are available to admins only.
          </p>
        )}

        {!isLoading && !isError && candidates.length === 0 && (
          <p className="px-[18px] py-6 text-sm text-text-tertiary">
            No recurring correction patterns yet. As reviewers correct imported PDFs, shapes that
            repeat will appear here.
          </p>
        )}

        {candidates.map((c) => (
          <div
            key={`${c.documentType}:${c.shape}`}
            className="fai-row flex items-start gap-[14px] border-b border-border-subtle px-[18px] py-3 last:border-b-0"
          >
            <span className="w-[70px] pt-0.5">
              <Badge variant="info">×{c.count}</Badge>
            </span>
            <span className="w-[220px] min-w-0">
              <span className="block truncate font-mono text-[12.5px] font-semibold" title={c.shape}>
                {c.shape}
              </span>
              {c.sampleCaptureIds.length > 0 && (
                <span className="mt-1 flex items-center gap-1 text-xs text-text-tertiary">
                  <Icon name="file-text" size={12} />
                  {c.sampleCaptureIds.length} example{c.sampleCaptureIds.length === 1 ? '' : 's'}
                </span>
              )}
            </span>
            <span className="flex-1 text-[13px] text-text-secondary">{c.suggestion}</span>
            <span className="w-[110px] pt-0.5 text-xs text-text-tertiary">{c.documentType}</span>
          </div>
        ))}
      </div>

      <PlacementCard
        insights={placement.data}
        isLoading={placement.isLoading}
        isError={placement.isError}
      />
    </div>
  );
}

/** A rate as a whole percentage — the strip reads at a glance, not to a decimal. */
function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/**
 * The placement loop's half of the screen (R7/R8): the auto-place hit-rate per
 * document type and the recurring placement shapes, each pointing at the
 * engine seam a maintainer would change. Same visual grammar as the
 * extraction card above, and the same contract: it proposes, it changes
 * nothing.
 */
function PlacementCard({
  insights,
  isLoading,
  isError,
}: {
  insights: PlacementInsights | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  const metrics = insights?.metrics ?? [];
  const shapes = insights?.shapes ?? [];

  return (
    <>
      <div className="mb-[18px] mt-[34px]">
        <h2 className="font-heading text-[15px] font-semibold">Placement</h2>
        <p className="mt-1 max-w-[660px] text-sm text-text-secondary">
          When the geometry engine proposes where answers sit on the page, the loop records each
          proposal&rsquo;s tier and what the reviewer did with it — accepted, adjusted, rejected, or
          drawn by hand. Nothing here changes the engine: a maintainer acts on a recurring shape by
          changing an engine heuristic in a reviewed code change, and these numbers say whether it
          worked.
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-surface-card shadow-xs">
        {isLoading && <p className="px-[18px] py-6 text-sm text-text-tertiary">Loading…</p>}

        {isError && !isLoading && (
          <p className="px-[18px] py-6 text-sm text-text-tertiary">
            These insights are available to admins only.
          </p>
        )}

        {!isLoading && !isError && metrics.length === 0 && (
          <p className="px-[18px] py-6 text-sm text-text-tertiary">
            No placement sessions recorded yet. As reviewers save auto-placed geometry, the
            hit-rate per document type will appear here.
          </p>
        )}

        {metrics.map((m) => (
          <div
            key={m.documentType}
            className="flex flex-wrap items-center gap-[18px] border-b border-border-subtle px-[18px] py-3 last:border-b-0"
          >
            <span className="w-[110px] text-[13px] font-semibold">{m.documentType}</span>
            <MetricChip label="Hit rate" value={pct(m.hitRate)} />
            <MetricChip label="Adjusted" value={pct(m.adjustmentRate)} />
            <MetricChip label="No match" value={pct(m.noMatchRate)} />
            <span className="text-xs text-text-tertiary">
              {m.sessions} session{m.sessions === 1 ? '' : 's'} · {m.proposalsAttempted} proposals
            </span>
          </div>
        ))}
      </div>

      {!isLoading && !isError && shapes.length > 0 && (
        <div className="mt-[14px] overflow-hidden rounded-lg border border-border bg-surface-card shadow-xs">
          <div className="flex items-center gap-[14px] border-b border-border-subtle px-[18px] py-[11px] font-mono text-[10.5px] uppercase tracking-[0.06em] text-text-tertiary">
            <span className="w-[70px]">Seen</span>
            <span className="w-[220px]">Shape</span>
            <span className="flex-1">Suggested engine seam</span>
            <span className="w-[110px]">Document</span>
          </div>
          {shapes.map((s) => (
            <div
              key={`${s.documentType}:${s.shape}`}
              className="fai-row flex items-start gap-[14px] border-b border-border-subtle px-[18px] py-3 last:border-b-0"
            >
              <span className="w-[70px] pt-0.5">
                <Badge variant="info">×{s.count}</Badge>
              </span>
              <span className="w-[220px] min-w-0">
                <span className="block truncate font-mono text-[12.5px] font-semibold" title={s.shape}>
                  {s.shape}
                </span>
              </span>
              <span className="flex-1 text-[13px] text-text-secondary">{s.suggestion}</span>
              <span className="w-[110px] pt-0.5 text-xs text-text-tertiary">{s.documentType}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function MetricChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-[15px] font-semibold tabular-nums">{value}</span>
      <span className="text-[11px] uppercase tracking-wide text-text-tertiary">{label}</span>
    </span>
  );
}
