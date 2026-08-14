import { logbookTaskProgress, totalLoggedHours } from '@formai/shared';
import type { AssessmentToolManifest } from '@formai/shared';
import { Icon } from '@formai/ui';

type TaskMinimums = NonNullable<AssessmentToolManifest['parts'][number]['taskMinimums']>;

/**
 * The candidate's live view of where their logbook hours stand — overall and,
 * for a multi-stage logbook, per task type.
 *
 * TARGETS, NOT GATES. Hours never block hand-in; exposure to a task type is an
 * operations matter, not a training sequence, so this only ever SHOWS how far
 * along each type is. It reads the same `logbookTaskProgress` the assessor's
 * readout and the "minimum reached" notice read, so the three can never
 * disagree, and it recomputes from the rows being typed so a total moves as the
 * candidate logs — the point of showing it here rather than after hand-in.
 *
 * A task with no rows yet still shows, at zero: the gap is exactly what a
 * candidate needs to see to go seek that work out.
 */
export function LogbookProgress({
  rows,
  taskMinimums,
  durationColumnKey,
  minimumHours,
}: {
  rows: readonly Record<string, unknown>[];
  taskMinimums: TaskMinimums | null;
  durationColumnKey: string | null;
  minimumHours: number | null;
}) {
  if (!durationColumnKey) return null;
  const perTask = taskMinimums ? logbookTaskProgress(rows, taskMinimums, durationColumnKey) : [];
  // Nothing to meter: not a logbook part, or one with neither an overall nor a
  // per-task target.
  if (minimumHours === null && perTask.length === 0) return null;

  const overall = totalLoggedHours(rows, durationColumnKey);

  return (
    <section
      aria-label="Hours logged"
      className="mb-4 rounded-[10px] border border-border bg-surface-card p-3.5"
    >
      <div className="mb-2.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <Icon name="clock" size={14} className="text-text-tertiary" />
        <h2 className="text-[13px] font-semibold text-text-primary">Hours logged</h2>
        <span className="ml-auto text-[11.5px] text-text-tertiary">
          Targets, not gates — log any task in any order
        </span>
      </div>

      {minimumHours !== null && (
        <HoursRow label="Overall" logged={overall} target={minimumHours} strong />
      )}

      {perTask.length > 0 && (
        <div className="mt-2.5 flex flex-col gap-2.5">
          {perTask.map((t) => (
            <HoursRow key={t.value} label={t.value} logged={t.loggedHours} target={t.minimumHours} />
          ))}
        </div>
      )}
    </section>
  );
}

function HoursRow({
  label,
  logged,
  target,
  strong,
}: {
  label: string;
  logged: number;
  target: number;
  strong?: boolean;
}) {
  const met = logged >= target;
  // Capped width, uncapped number: the bar never overflows, but an operator who
  // logged 14 of 10 hours sees 14 — clamping the figure would hide honest work.
  const pct = target > 0 ? Math.min(100, Math.round((logged / target) * 100)) : 0;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[12.5px]">
        <span
          className={`flex items-center gap-1 ${strong ? 'font-semibold text-text-primary' : 'text-text-primary'}`}
        >
          {met && <Icon name="check" size={12} className="text-accent" aria-label="minimum reached" />}
          {label}
        </span>
        <span className="flex-none tabular-nums text-text-secondary">
          {logged} / {target} hrs
        </span>
      </div>
      <span className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
        <span
          className={`block h-full rounded-full ${met ? 'bg-accent' : 'bg-accent/60'}`}
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
}
