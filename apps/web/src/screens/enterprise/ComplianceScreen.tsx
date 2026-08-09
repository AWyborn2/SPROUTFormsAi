import { Card, Icon } from '@formai/ui';
import { useComplianceReport } from '../../lib/data/hooks.js';
import type { ComplianceGap, UnreachableMember } from '../../lib/data/types.js';

/**
 * Compliance reporting (U20) — how the workforce stands, as an auditor reads it.
 * Three sections and no faked total: required competencies EXPIRED, required
 * competencies NEVER HELD (different problems, different remedies, so reported
 * apart), and members no notification can reach. An optional lapse is not here,
 * and an overdue pooled case is a backlog that belongs on the working list.
 */
export function ComplianceScreen() {
  const { data: report, isLoading, isError } = useComplianceReport();

  return (
    <div className="fai-rise mx-auto grid max-w-[860px] gap-5 p-[30px_28px_60px]">
      <div>
        <h2 className="font-heading text-xl font-bold">Compliance</h2>
        <p className="mt-1 text-sm text-text-tertiary">
          Where the workforce stands against what its Roles require. Only required competencies
          count — a voluntary lapse is not a compliance failure.
        </p>
      </div>

      {isLoading && <div className="p-6 text-sm text-text-tertiary">Loading…</div>}
      {isError && <div className="p-6 text-sm text-danger-text">Could not load the report.</div>}
      {report && (
        <>
          <GapSection
            title="Required competencies expired"
            hint="A ticket a Role requires has lapsed on its date — book a refresher."
            gaps={report.expired}
            icon="clock-alert"
          />
          <GapSection
            title="Required competencies never held"
            hint="A Role requires a competency the person has never held — book the assessment."
            gaps={report.neverHeld}
            icon="user-x"
          />
          <GapSection
            title="Optional lapses"
            hint="A held ticket has lapsed that no Role requires — informational, not a compliance failure."
            gaps={report.optionalLapses}
            icon="info"
          />
          <UnreachableSection members={report.unreachable} />
        </>
      )}
    </div>
  );
}

/**
 * Its own section because an unreachable member is a PERSON, not a competency
 * gap (U36, R99) — there is no ticket to name in a second column, and rendering
 * one through `GapSection` printed an empty cell beside every name.
 */
function UnreachableSection({ members }: { members: UnreachableMember[] }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon
            name="mail-x"
            size={16}
            className={members.length > 0 ? 'text-danger-text' : 'text-text-tertiary'}
          />
          <h3 className="font-ui text-sm font-semibold">Members no notification can reach</h3>
        </div>
        <span className="text-[13px] font-semibold tabular-nums">{members.length}</span>
      </div>
      <p className="mt-1 text-[12px] text-text-tertiary">
        No login and an address marked unreachable — an expiry notice reaches them by neither
        route, so somebody has to tell them in person.
      </p>
      {members.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1">
          {members.map((m) => (
            <li
              key={m.membershipId}
              className="flex items-center justify-between gap-3 rounded-md bg-surface-sunken px-3 py-1.5 text-[12.5px]"
            >
              <span className="truncate font-medium">{m.name}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function GapSection({
  title,
  hint,
  gaps,
  icon,
}: {
  title: string;
  hint: string;
  gaps: ComplianceGap[];
  icon: string;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon name={icon} size={16} className={gaps.length > 0 ? 'text-danger-text' : 'text-text-tertiary'} />
          <h3 className="font-ui text-sm font-semibold">{title}</h3>
        </div>
        <span className="text-[13px] font-semibold tabular-nums">{gaps.length}</span>
      </div>
      <p className="mt-1 text-[12px] text-text-tertiary">{hint}</p>
      {gaps.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1">
          {gaps.map((g) => (
            <li
              key={`${g.userId}-${g.competencyId}`}
              className="flex items-center justify-between gap-3 rounded-md bg-surface-sunken px-3 py-1.5 text-[12.5px]"
            >
              <span className="truncate font-medium">{g.name}</span>
              <span className="truncate text-text-tertiary">{g.competencyName}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
