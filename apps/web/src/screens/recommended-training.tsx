import type { ReactElement, ReactNode } from 'react';
import { Button, useToast } from '@formai/ui';
import { useMyRecommended, useRequestTraining } from '../lib/data/hooks.js';
import { sourcesLine } from '../lib/competency-sources.js';

/**
 * Unheld recommendations, shared by the two surfaces that show them — the
 * candidate dashboard's card and the profile record's card (U7, R12). Absent —
 * not an empty shell — when every recommendation is held or none exists:
 * returning null BEFORE `render` runs is what keeps each screen's wrapper
 * chrome from rendering around nothing.
 *
 * "Request this training" needs BOTH facts (R14, AE5): the org's self-start
 * toggle ON and a bookable awarding tool from the KTD2 resolver; toggle OFF
 * leaves the recommendation visible with no start action, and an evidence-only
 * entry names evidence as the route. The request posts the existing voluntary
 * `{ toolId }` body and waits on an admin (R94, R96).
 *
 * The screens own their chrome: `render` receives the rows and wraps them in
 * the screen's own card and list elements, and `row` names the row element so
 * the dashboard's `div` list and the profile's `ul` both stay valid markup.
 */
export function RecommendedTrainingList({
  row: Row,
  render,
}: {
  row: 'div' | 'li';
  render: (rows: ReactNode) => ReactElement;
}) {
  const { toast } = useToast();
  const { data } = useMyRecommended();
  const request = useRequestTraining();
  const unheld = (data?.items ?? []).filter((r) => !r.held);
  if (unheld.length === 0) return null;

  return render(
    unheld.map((r) => (
      <Row
        key={r.competencyId}
        className="flex items-center justify-between gap-3 rounded-md bg-surface-sunken px-3 py-2"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold">{r.name}</span>
            {r.code && (
              <span className="flex-none font-mono text-[10.5px] uppercase tracking-wide text-text-tertiary">
                {r.code}
              </span>
            )}
          </span>
          {/*
            WHO recommends it (AE5, R5): "Recommended — from <Location>". A
            self-scope read, so the sources always arrive — but stay defensive
            about an empty list rather than rendering a dangling "from".
          */}
          {sourcesLine('recommended', r.sources) && (
            <span className="block text-[11px] text-text-tertiary">
              {sourcesLine('recommended', r.sources)}
            </span>
          )}
        </span>
        {data?.selfStartEnabled && r.requestableToolId ? (
          <Button
            size="sm"
            variant="outline"
            disabled={request.isPending}
            onClick={() =>
              request.mutate(r.requestableToolId!, {
                onSuccess: () =>
                  toast({ variant: 'success', message: `Requested training for ${r.name}.` }),
                onError: () =>
                  toast({ variant: 'danger', message: 'Could not send the request.' }),
              })
            }
          >
            Request this training
          </Button>
        ) : (
          <span className="flex-none text-[11px] text-text-tertiary">
            {r.requestableToolId
              ? 'Ask your supervisor'
              : 'Evidence-based — ask your supervisor'}
          </span>
        )}
      </Row>
    )),
  );
}
