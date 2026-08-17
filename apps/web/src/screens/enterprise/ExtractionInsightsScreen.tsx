import { Badge, Icon } from '@formai/ui';
import { useCorrectionCandidates } from '../../lib/data/hooks.js';

/**
 * Extraction insights — the human-gated candidate-rules surface (learning loop 2c).
 *
 * As reviewers correct imported PDFs, the corrections that recur are clustered
 * into content-free shapes. This screen lists the ones frequent enough to be
 * worth acting on, each with the rule it points at. It is READ-ONLY on purpose:
 * acting on a candidate means a maintainer writing a general profile rule (or
 * promoting a LEARNED_EXAMPLE) in a reviewed PR — the prompt is never changed
 * from here, or from any runtime path.
 */
export function ExtractionInsightsScreen() {
  const { data, isLoading, isError } = useCorrectionCandidates();
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
    </div>
  );
}
