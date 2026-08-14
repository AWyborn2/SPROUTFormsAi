import { Card, Icon } from '@formai/ui';
import { useSearchParams } from 'react-router-dom';
import { useComplianceReport } from '../../lib/data/hooks.js';
import type { ComplianceGap, UnreachableMember } from '../../lib/data/types.js';

/**
 * Compliance reporting (U20) — how the workforce stands, as an auditor reads it:
 * required competencies EXPIRED, required competencies EXPIRING inside the
 * planning window, required competencies NEVER HELD (different problems,
 * different remedies, so reported apart), and members no notification can
 * reach. An optional lapse is informational only, and an overdue pooled case is
 * a backlog that belongs on the working list.
 *
 * `?status=expired|expiring` narrows the page to that one section — the
 * dashboard tile's click-through lands here, and dropping somebody who clicked
 * "expiring" onto the full report would make them hunt for the number they
 * clicked. The narrow view says what it hid and offers the way back.
 */
export function ComplianceScreen() {
  const { data: report, isLoading, isError } = useComplianceReport();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusParam = searchParams.get('status');
  const focus = statusParam === 'expired' || statusParam === 'expiring' ? statusParam : null;

  return (
    <div className="fai-rise mx-auto grid max-w-[860px] gap-5 p-[30px_28px_60px]">
      <div>
        <h2 className="font-heading text-xl font-bold">Compliance</h2>
        <p className="mt-1 text-sm text-text-tertiary">
          Where the workforce stands against what its Roles require. Only required competencies
          count — a voluntary lapse is not a compliance failure.
        </p>
      </div>

      {focus && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-card px-4 py-2.5">
          <span className="text-[12.5px] text-text-secondary">
            Showing {focus === 'expired' ? 'expired' : 'expiring or in-grace'} required competencies
            only.
          </span>
          <button
            onClick={() => setSearchParams({}, { replace: true })}
            className="text-[12.5px] font-semibold text-text-accent hover:underline"
          >
            Show full report
          </button>
        </div>
      )}

      {isLoading && <div className="p-6 text-sm text-text-tertiary">Loading…</div>}
      {isError && <div className="p-6 text-sm text-danger-text">Could not load the report.</div>}
      {report && (
        <>
          {(!focus || focus === 'expired') && (
            <GapSection
              title="Required competencies expired"
              hint="A ticket a Role requires has lapsed on its date — book a refresher."
              gaps={report.expired}
              icon="clock-alert"
              countPeople
            />
          )}
          {(!focus || focus === 'expiring') && (
            <GapSection
              title="Required competencies expiring or in grace"
              hint="Still counting, but the clock is running — inside the 90-day window or already past the date in grace. Book the reassessment now."
              gaps={report.expiring}
              icon="calendar-clock"
              tone="warning"
              countPeople
            />
          )}
          {!focus && (
            <>
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
  /** Expiring is runway, not failure — it warns where the others alarm. */
  tone = 'danger',
  /*
    The dashboard tile counts PEOPLE (one person with two lapsing tickets is
    one person to book), so the sections its cards land on must lead with the
    same number — a click that shows different arithmetic than the card gets
    questioned, and this is an auditor-facing page.
  */
  countPeople = false,
}: {
  title: string;
  hint: string;
  gaps: ComplianceGap[];
  icon: string;
  tone?: 'danger' | 'warning';
  countPeople?: boolean;
}) {
  const people = new Set(gaps.map((g) => g.userId)).size;
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon
            name={icon}
            size={16}
            className={
              gaps.length > 0
                ? tone === 'warning'
                  ? 'text-warning-text'
                  : 'text-danger-text'
                : 'text-text-tertiary'
            }
          />
          <h3 className="font-ui text-sm font-semibold">{title}</h3>
        </div>
        <span className="text-[13px] font-semibold tabular-nums">
          {!countPeople || people === gaps.length
            ? gaps.length
            : `${people} people · ${gaps.length} tickets`}
        </span>
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
              <span className="flex min-w-0 flex-none items-center gap-2">
                <span className="truncate text-text-tertiary">{g.competencyName}</span>
                {/*
                  EVIDENCE-ONLY GAPS SAY SO (U8, R7). The section hint says
                  "book the assessment", but no assessment awards this
                  competency — a licence-type requirement — so booking is a
                  dead end and the way out is recording evidence: an imported
                  or manual grant (R11). Read from the KTD2 resolver
                  server-side, never guessed here.
                */}
                {!g.hasAwardingAssessment && (
                  <span
                    className="flex-none rounded-sm bg-surface-card px-1.5 py-0.5 text-[10.5px] font-medium text-text-secondary"
                    title="No assessment awards this competency. Clear the gap by recording evidence — an imported or manual grant."
                  >
                    Evidence-based — record evidence
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
