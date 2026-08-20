/**
 * The matrix assembly's cell rules (U2, KTD3) — pure, no database, no app
 * boot: the module takes batched reads as plain data, so these tests hand it
 * exactly what the route (U3) would and pin what each cell SAYS. The one
 * structural invariant worth naming up front: `cells[i]` speaks about
 * `competencies[i]`, on every row, whatever the member holds.
 */
import { describe, expect, it } from 'vitest';
import {
  assembleTrainingMatrix,
  matrixCell,
  requiredCounts,
  type MatrixCompetency,
  type MatrixGrant,
  type MatrixMember,
  type MemberStandingSets,
  type TrainingMatrixInput,
} from './training-matrix.js';

const NOW = new Date('2026-08-20T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * DAY_MS);

const competency = (id: string, over: Partial<MatrixCompetency> = {}): MatrixCompetency => ({
  id,
  name: `Competency ${id}`,
  code: null,
  ...over,
});

const member = (userId: string, over: Partial<MatrixMember> = {}): MatrixMember => ({
  membershipId: `m-${userId}`,
  userId,
  name: `Member ${userId}`,
  role: 'member',
  locations: [],
  departments: [],
  roles: [],
  hasPlacementRows: true,
  ...over,
});

const grant = (competencyId: string, over: Partial<MatrixGrant> = {}): MatrixGrant => ({
  competencyId,
  grantedAt: new Date('2026-06-01T00:00:00Z'),
  expiresAt: null,
  revokedAt: null,
  ...over,
});

/** The resolver's source-map shape: only the KEYS matter to assembly, which is
 * the contract these tests pin — values stay opaque provenance. */
const standingSets = (required: string[] = [], recommended: string[] = []): MemberStandingSets => ({
  required: new Map(required.map((id) => [id, [{ scope: 'org', scopeId: null, scopeName: 'Org' }]])),
  recommended: new Map(recommended.map((id) => [id, []])),
});

const assemble = (over: Partial<TrainingMatrixInput>) =>
  assembleTrainingMatrix({
    competencies: [],
    members: [],
    standingByUser: new Map(),
    grantsByUser: new Map(),
    awardingToolByCompetency: new Map(),
    now: NOW,
    ...over,
  });

describe('assembleTrainingMatrix — cell status and standing', () => {
  it('renders a held required grant as {status: held, standing: required} and counts it compliant', () => {
    const payload = assemble({
      competencies: [competency('c1', { validForMonths: 36 })],
      members: [member('u1')],
      standingByUser: new Map([['u1', standingSets(['c1'])]]),
      grantsByUser: new Map([['u1', [grant('c1')]]]),
    });

    const row = payload.members[0]!;
    expect(row.cells[0]).toMatchObject({ status: 'held', standing: 'required' });
    // Derived expiry (grant + validity) passes through for the client to sort by.
    expect(row.cells[0]?.expiresAt).toBeInstanceOf(Date);
    expect(requiredCounts(row.cells)).toEqual({ requiredTotal: 1, requiredHeld: 1 });
  });

  it('flags a grant inside the ASSESSOR horizon as expiring, with the date passed through (90 days, not 30)', () => {
    // 60 days out: outside the candidate window (30), inside the assessor one
    // (90) — the grid reader plans other people's bookings, so the longer
    // horizon is the correct audience and this date must read `expiring`.
    const expiresAt = daysFromNow(60);
    const payload = assemble({
      competencies: [competency('c1')],
      members: [member('u1')],
      standingByUser: new Map([['u1', standingSets(['c1'])]]),
      grantsByUser: new Map([['u1', [grant('c1', { expiresAt })]]]),
    });

    expect(payload.members[0]!.cells[0]).toMatchObject({
      status: 'expiring',
      standing: 'required',
      expiresAt,
    });
  });

  it('renders an expired required grant as expired, and still counts the column against the row', () => {
    const payload = assemble({
      competencies: [competency('c1')],
      members: [member('u1')],
      standingByUser: new Map([['u1', standingSets(['c1'])]]),
      grantsByUser: new Map([['u1', [grant('c1', { expiresAt: daysFromNow(-10) })]]]),
    });

    const row = payload.members[0]!;
    expect(row.cells[0]).toMatchObject({ status: 'expired', standing: 'required' });
    expect(requiredCounts(row.cells)).toEqual({ requiredTotal: 1, requiredHeld: 0 });
  });

  it('still emits a lapsed grant on a NON-required competency, with standing optional/recommended', () => {
    // The null rule is "nothing required AND nothing conferred" — an expired
    // optional grant confers a history the client renders distinctly from
    // never-relevant, so it must not disappear into a null cell.
    const lapsed = grant('c1', { expiresAt: daysFromNow(-10) });
    const optional = assemble({
      competencies: [competency('c1')],
      members: [member('u1')],
      grantsByUser: new Map([['u1', [lapsed]]]),
    });
    const recommended = assemble({
      competencies: [competency('c1')],
      members: [member('u1')],
      standingByUser: new Map([['u1', standingSets([], ['c1'])]]),
      grantsByUser: new Map([['u1', [lapsed]]]),
    });

    expect(optional.members[0]!.cells[0]).toMatchObject({ status: 'expired', standing: 'optional' });
    expect(recommended.members[0]!.cells[0]).toMatchObject({
      status: 'expired',
      standing: 'recommended',
    });
  });

  it('renders required-never-held as a gap cell: standing only, no grant-derived fields', () => {
    const payload = assemble({
      competencies: [competency('c1')],
      members: [member('u1')],
      standingByUser: new Map([['u1', standingSets(['c1'])]]),
    });

    // noAward rides along here (empty awarding map — evidence-only, R7);
    // everything grant-derived is absent because there is no grant.
    expect(payload.members[0]!.cells[0]).toEqual({ standing: 'required', noAward: true });
  });

  it('renders recommended-not-held as {standing: recommended} with no status (R13 — never a gap)', () => {
    const payload = assemble({
      competencies: [competency('c1')],
      members: [member('u1')],
      standingByUser: new Map([['u1', standingSets([], ['c1'])]]),
    });

    expect(payload.members[0]!.cells[0]).toEqual({ standing: 'recommended' });
  });

  it('never lets a revoked grant count: required renders as a marked gap, recommended as not-held (R106/R107)', () => {
    const revoked = grant('c1', { revokedAt: new Date('2026-07-01T00:00:00Z') });
    const required = assemble({
      competencies: [competency('c1')],
      members: [member('u1')],
      standingByUser: new Map([['u1', standingSets(['c1'])]]),
      grantsByUser: new Map([['u1', [revoked]]]),
      awardingToolByCompetency: new Map([['c1', 't1']]),
    });
    const recommended = assemble({
      competencies: [competency('c1')],
      members: [member('u1')],
      standingByUser: new Map([['u1', standingSets([], ['c1'])]]),
      grantsByUser: new Map([['u1', [revoked]]]),
    });

    // Standing present, NO status — and `revoked` marks it apart from
    // never-held, because "taken away" and "never trained" differ in remedy.
    expect(required.members[0]!.cells[0]).toEqual({ standing: 'required', revoked: true });
    expect(requiredCounts(required.members[0]!.cells)).toEqual({ requiredTotal: 1, requiredHeld: 0 });
    expect(recommended.members[0]!.cells[0]).toEqual({ standing: 'recommended', revoked: true });
  });

  it('reads an undated grant (null grantedAt, no expiresAt) as undated — flagged but counting (R153 reversed)', () => {
    const payload = assemble({
      competencies: [competency('c1', { validForMonths: 36 })],
      members: [member('u1')],
      standingByUser: new Map([['u1', standingSets(['c1'])]]),
      grantsByUser: new Map([['u1', [grant('c1', { grantedAt: null })]]]),
    });

    const row = payload.members[0]!;
    expect(row.cells[0]).toMatchObject({ status: 'undated', standing: 'required' });
    expect(row.cells[0]?.expiresAt).toBeUndefined(); // nothing to derive from
    expect(requiredCounts(row.cells)).toEqual({ requiredTotal: 1, requiredHeld: 1 });
  });

  it('emits null for not-required, not-held — nothing to say', () => {
    const payload = assemble({
      competencies: [competency('c1')],
      members: [member('u1')],
    });

    expect(payload.members[0]!.cells[0]).toBeNull();
  });

  it('reads the person by their BEST grant: a fresh held row beside an old expired one is held (renewal rule)', () => {
    const payload = assemble({
      competencies: [competency('c1', { validForMonths: 36 })],
      members: [member('u1')],
      standingByUser: new Map([['u1', standingSets(['c1'])]]),
      grantsByUser: new Map([
        ['u1', [grant('c1', { expiresAt: daysFromNow(-400) }), grant('c1')]],
      ]),
    });

    expect(payload.members[0]!.cells[0]).toMatchObject({ status: 'held', standing: 'required' });
  });
});

describe('assembleTrainingMatrix — evidence kind of the best counting grant', () => {
  const cellFor = (over: Partial<MatrixGrant>) =>
    matrixCell(
      competency('c1'),
      'required',
      [grant('c1', over)],
      new Map([['c1', 't1']]),
      NOW,
    );

  it('names the provenance: sourceCaseId → assessment, licence fields → licence, importedAt → import', () => {
    expect(cellFor({ sourceCaseId: 'case-1' })?.evidence).toBe('assessment');
    expect(cellFor({ licenceNumber: 'HR-12345' })?.evidence).toBe('licence');
    expect(cellFor({ licenceClass: 'HR' })?.evidence).toBe('licence');
    expect(cellFor({ importedAt: new Date('2026-01-01T00:00:00Z') })?.evidence).toBe('import');
  });

  it('omits evidence on a hand-recorded grant, and on a grant that no longer counts', () => {
    expect(cellFor({})?.evidence).toBeUndefined();
    // Expired: the gap cell's question is "how do they requalify", which the
    // lapsed grant's provenance does not answer.
    const lapsedImport = cellFor({
      importedAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: daysFromNow(-10),
    });
    expect(lapsedImport?.evidence).toBeUndefined();
  });
});

describe('assembleTrainingMatrix — noAward and the awarding map as given input', () => {
  it('marks a required gap noAward ONLY when the awarding map does not name the competency (R7)', () => {
    const payload = assemble({
      competencies: [competency('c-bookable'), competency('c-evidence-only')],
      members: [member('u1')],
      standingByUser: new Map([['u1', standingSets(['c-bookable', 'c-evidence-only'])]]),
      awardingToolByCompetency: new Map([['c-bookable', 't1']]),
    });

    const cells = payload.members[0]!.cells;
    expect(cells[0]).toEqual({ standing: 'required' }); // bookable: no flag
    expect(cells[1]).toEqual({ standing: 'required', noAward: true });
  });

  it('never sets noAward on a SATISFIED required cell — the flag describes gaps, not columns', () => {
    const payload = assemble({
      competencies: [competency('c1')],
      members: [member('u1')],
      standingByUser: new Map([['u1', standingSets(['c1'])]]),
      grantsByUser: new Map([['u1', [grant('c1')]]]),
      // Evidence-only competency, but the person holds it: no gap to flag.
    });

    expect(payload.members[0]!.cells[0]?.noAward).toBeUndefined();
  });
});

describe('assembleTrainingMatrix — placement and member rows', () => {
  it('sets noLocationPlacement true only when the member has ZERO raw placement rows', () => {
    const payload = assemble({
      competencies: [competency('c1')],
      members: [member('u-unplaced', { hasPlacementRows: false })],
      standingByUser: new Map([['u-unplaced', standingSets(['c1'])]]),
    });

    expect(payload.members[0]!.noLocationPlacement).toBe(true);
  });

  it('keeps noLocationPlacement FALSE for a member placed only at a retired location (raw rows count)', () => {
    // The review-corrected compliance rule: the scope expansion drops retired
    // locations (they confer no requirements), but the ASSIGNMENT ENGINE reads
    // placement rows unfiltered and books a case at the retired site anyway —
    // so the route passes raw-row presence and the flag stays off. Note the
    // empty display `locations`: metadata and the placement fact are separate
    // inputs precisely because they answer different questions.
    const payload = assemble({
      competencies: [],
      members: [member('u1', { locations: [], hasPlacementRows: true })],
    });

    expect(payload.members[0]!.noLocationPlacement).toBe(false);
  });

  it('takes the resolver source maps AS GIVEN — display roles/departments derive no requirement', () => {
    // The member's metadata names a (withdrawn) role and a (retired)
    // department, but the resolver already excluded their requirements from
    // the source maps — assembly must not re-derive obligation from display
    // metadata, or the grid would disagree with compliance and assignment.
    const payload = assemble({
      competencies: [competency('c-from-withdrawn-role')],
      members: [
        member('u1', {
          roles: [{ id: 'r-withdrawn', name: 'Dozer Operator' }],
          departments: [{ id: 'dep-retired', name: 'Closed Pit' }],
        }),
      ],
      standingByUser: new Map([['u1', standingSets()]]),
    });

    expect(payload.members[0]!.cells[0]).toBeNull();
  });

  it('carries identity and placement metadata through unchanged', () => {
    const locations = [{ id: 'loc1', name: 'North Pit' }];
    const payload = assemble({
      members: [member('u1', { name: 'Ash Wyborn', role: 'admin', locations })],
    });

    expect(payload.members[0]).toMatchObject({
      membershipId: 'm-u1',
      userId: 'u1',
      name: 'Ash Wyborn',
      role: 'admin',
      locations,
    });
  });
});

describe('assembleTrainingMatrix — structural invariants', () => {
  it('aligns cells to competencies: cells.length === competencies.length on every row', () => {
    const competencies = [competency('c1'), competency('c2'), competency('c3')];
    const payload = assemble({
      competencies,
      members: [member('u1'), member('u2', { hasPlacementRows: false })],
      standingByUser: new Map([['u1', standingSets(['c2'])]]),
      grantsByUser: new Map([['u2', [grant('c3')]]]),
    });

    expect(payload.competencies).toHaveLength(3);
    for (const row of payload.members) {
      expect(row.cells).toHaveLength(payload.competencies.length);
    }
    // And alignment, not just length: u1's requirement sits in column 1 (c2),
    // u2's grant in column 2 (c3).
    expect(payload.members[0]!.cells.map((c) => c?.standing ?? null)).toEqual([
      null,
      'required',
      null,
    ]);
    expect(payload.members[1]!.cells.map((c) => c?.status ?? null)).toEqual([null, null, 'held']);
  });

  it('handles a user absent from every input map: all-null cells, nothing thrown', () => {
    const payload = assemble({
      competencies: [competency('c1'), competency('c2')],
      members: [member('u-unknown')],
    });

    expect(payload.members[0]!.cells).toEqual([null, null]);
  });
});

describe('requiredCounts', () => {
  it('counts required columns and how many currently count as held — expiring and grace included', () => {
    expect(
      requiredCounts([
        { standing: 'required', status: 'held' },
        { standing: 'required', status: 'expiring' },
        { standing: 'required', status: 'grace' },
        { standing: 'required', status: 'undated' },
        { standing: 'required', status: 'expired' },
        { standing: 'required' }, // never held
        { standing: 'required', revoked: true },
        { standing: 'recommended', status: 'held' }, // not required: not counted
        { standing: 'optional', status: 'expired' },
        null,
      ]),
    ).toEqual({ requiredTotal: 7, requiredHeld: 4 });
  });
});
