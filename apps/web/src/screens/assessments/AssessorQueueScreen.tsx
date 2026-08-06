import { Link } from 'react-router-dom';
import { Badge, Card } from '@formai/ui';
import { useAssessorQueue } from '../../lib/data/hooks.js';

/**
 * The shared pool (U13): open cases nobody owns, at Locations this assessor is
 * eligible to assess. Working a case never claims it, so the same case stays
 * here for every eligible assessor until it is signed off. Overdue is derived
 * from each case's age against the organisation's threshold (R63), not stored.
 */
export function AssessorQueueScreen() {
  const { data, isLoading, isError } = useAssessorQueue();

  if (isLoading) {
    return <p className="p-8 text-[13px] text-text-tertiary">Loading the queue…</p>;
  }
  if (isError) {
    return <p className="p-8 text-[13px] text-danger-text">Could not load the assessment queue.</p>;
  }

  const items = data ?? [];

  return (
    <div className="fai-rise mx-auto flex max-w-[900px] flex-col gap-4 p-[30px_28px_60px]">
      <div>
        <h1 className="font-heading text-[22px] font-bold">Assessment queue</h1>
        <p className="mt-1 max-w-[62ch] text-[12.5px] text-text-tertiary">
          Cases waiting for an assessor at the Locations you can assess. Opening one does not claim
          it — it stays here for every eligible assessor until it is signed off.
        </p>
      </div>

      {items.length === 0 ? (
        <Card className="p-6 text-[13px] text-text-tertiary">
          Nothing is waiting for you right now.
        </Card>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface-card shadow-xs">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wide text-text-tertiary">
                <th className="px-4 py-2.5 font-semibold">Assessment</th>
                <th className="px-4 py-2.5 font-semibold">Candidate</th>
                <th className="px-4 py-2.5 font-semibold">Location</th>
                <th className="px-4 py-2.5 font-semibold">Waiting</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} className="border-b border-border-subtle last:border-0 hover:bg-surface-hover">
                  <td className="px-4 py-2.5">
                    <Link to={`/app/assessments/${c.id}`} className="font-medium text-text-primary hover:underline">
                      {c.toolName}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5 text-text-secondary">{c.candidateUserId}</td>
                  <td className="px-4 py-2.5 text-text-secondary">{c.locationName ?? '—'}</td>
                  <td className="px-4 py-2.5">
                    <span className="text-text-secondary">
                      {c.ageDays} day{c.ageDays === 1 ? '' : 's'}
                    </span>
                    {c.overdue && (
                      <Badge variant="danger" className="ml-2">
                        Overdue
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
