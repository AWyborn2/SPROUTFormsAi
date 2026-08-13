import { describe, expect, it } from 'vitest';

import {
  decideAssignments,
  type AssignmentInput,
  type AssignmentTool,
  type HeldCompetencyState,
} from './assignment.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

const COMP_A = 'comp-a';
const COMP_B = 'comp-b';
const LOC_1 = 'loc-1';
const LOC_2 = 'loc-2';

function tool(over: Partial<AssignmentTool> & Pick<AssignmentTool, 'toolId'>): AssignmentTool {
  return {
    awardedCompetencyIds: [COMP_A],
    allPartKeys: ['p1', 'p2', 'p3'],
    locationPartKeys: {},
    assessorStreamCompetencyIds: {},
    ...over,
  };
}

function held(
  competencyId: string,
  status: HeldCompetencyState['status'] = 'held',
  revoked = false,
): HeldCompetencyState {
  return { competencyId, status, revoked };
}

function input(over: Partial<AssignmentInput>): AssignmentInput {
  return {
    roleRequirements: [],
    tools: {},
    held: [],
    locationIds: [LOC_1],
    openCaseToolIds: [],
    ...over,
  };
}

// ── the skip rule (R44–R47, R107, KTD16) ─────────────────────────────────────

describe('decideAssignments — the skip rule', () => {
  it('creates a case for each required assessment the person cannot yet meet (R44)', () => {
    const t1 = tool({ toolId: 't1', awardedCompetencyIds: [COMP_A] });
    const t2 = tool({ toolId: 't2', awardedCompetencyIds: [COMP_B] });
    const out = decideAssignments(
      input({ roleRequirements: [['t1', 't2']], tools: { t1, t2 }, held: [] }),
    );
    expect(out.map((d) => d.toolId).sort()).toEqual(['t1', 't2']);
  });

  it('treats a tool that awards NOTHING as vacuously satisfied — no case ever (transition pin, KTD3)', () => {
    /*
      The fact the role-competency links round is built on: an empty awards
      list means `every()` over nothing, which is true, so the tool is skipped
      for EVERYONE — a required-but-unlinked assessment assigns no case until
      its award is linked. That is why linking an award ACTIVATES assignment
      rather than preserving it, and why the award link travels through a
      preview (U2). If this pin breaks, the award-link preview counts are
      counting a different world.
    */
    const t1 = tool({ toolId: 't1', awardedCompetencyIds: [] });
    const out = decideAssignments(input({ roleRequirements: [['t1']], tools: { t1 }, held: [] }));
    expect(out).toEqual([]);
  });

  it('creates no case where every awarded competency is held and current (R45)', () => {
    const t1 = tool({ toolId: 't1', awardedCompetencyIds: [COMP_A, COMP_B] });
    const out = decideAssignments(
      input({ roleRequirements: [['t1']], tools: { t1 }, held: [held(COMP_A), held(COMP_B)] }),
    );
    expect(out).toEqual([]);
  });

  it('creates a case when the person holds every awarded competency but one (R45)', () => {
    const t1 = tool({ toolId: 't1', awardedCompetencyIds: [COMP_A, COMP_B] });
    const out = decideAssignments(
      input({ roleRequirements: [['t1']], tools: { t1 }, held: [held(COMP_A)] }),
    );
    expect(out.map((d) => d.toolId)).toEqual(['t1']);
  });

  it('counts a competency inside its grace period as held (R45)', () => {
    const t1 = tool({ toolId: 't1', awardedCompetencyIds: [COMP_A] });
    const out = decideAssignments(
      input({ roleRequirements: [['t1']], tools: { t1 }, held: [held(COMP_A, 'grace')] }),
    );
    expect(out).toEqual([]);
  });

  it('counts an expiring competency as held', () => {
    const t1 = tool({ toolId: 't1', awardedCompetencyIds: [COMP_A] });
    const out = decideAssignments(
      input({ roleRequirements: [['t1']], tools: { t1 }, held: [held(COMP_A, 'expiring')] }),
    );
    expect(out).toEqual([]);
  });

  it('creates a case when the competency is revoked though its date is fine (R45, R107)', () => {
    // Revocation is decisive over the dated state: a grant the date would call
    // `held` still does not count once revoked.
    const t1 = tool({ toolId: 't1', awardedCompetencyIds: [COMP_A] });
    const out = decideAssignments(
      input({ roleRequirements: [['t1']], tools: { t1 }, held: [held(COMP_A, 'held', true)] }),
    );
    expect(out.map((d) => d.toolId)).toEqual(['t1']);
  });

  it('creates a case when the competency has expired (R46, R47)', () => {
    const t1 = tool({ toolId: 't1', awardedCompetencyIds: [COMP_A] });
    const out = decideAssignments(
      input({ roleRequirements: [['t1']], tools: { t1 }, held: [held(COMP_A, 'expired')] }),
    );
    expect(out.map((d) => d.toolId)).toEqual(['t1']);
  });

  it('creates no second case when an open one for that tool already exists (KTD16)', () => {
    const t1 = tool({ toolId: 't1', awardedCompetencyIds: [COMP_A] });
    const out = decideAssignments(
      input({
        roleRequirements: [['t1']],
        tools: { t1 },
        held: [held(COMP_A, 'expired')], // still unmet…
        openCaseToolIds: ['t1'], // …but already being worked
      }),
    );
    expect(out).toEqual([]);
  });

  it('creates a new case once the open one is closed and the competency is still expired (R46)', () => {
    const t1 = tool({ toolId: 't1', awardedCompetencyIds: [COMP_A] });
    const out = decideAssignments(
      input({
        roleRequirements: [['t1']],
        tools: { t1 },
        held: [held(COMP_A, 'expired')],
        openCaseToolIds: [], // the previous case is closed
      }),
    );
    expect(out.map((d) => d.toolId)).toEqual(['t1']);
  });

  it('takes the deduplicated union across several Roles (R48)', () => {
    const t1 = tool({ toolId: 't1', awardedCompetencyIds: [COMP_A] });
    const t2 = tool({ toolId: 't2', awardedCompetencyIds: [COMP_B] });
    const out = decideAssignments(
      input({
        // Three Roles; t1 required by two of them.
        roleRequirements: [['t1'], ['t1', 't2'], ['t2']],
        tools: { t1, t2 },
        held: [],
      }),
    );
    expect(out.map((d) => d.toolId).sort()).toEqual(['t1', 't2']);
  });

  it('assigns nothing for a Role whose requirements are empty (R49)', () => {
    const out = decideAssignments(input({ roleRequirements: [[]], tools: {}, held: [] }));
    expect(out).toEqual([]);
  });

  it('skips a required tool it was given no definition for', () => {
    const out = decideAssignments(input({ roleRequirements: [['ghost']], tools: {}, held: [] }));
    expect(out).toEqual([]);
  });

  it('assigns nothing when the membership holds no Location', () => {
    const t1 = tool({ toolId: 't1' });
    const out = decideAssignments(
      input({ roleRequirements: [['t1']], tools: { t1 }, held: [], locationIds: [] }),
    );
    expect(out).toEqual([]);
  });
});

// ── the case's Location, R58–R60 ─────────────────────────────────────────────

describe('decideAssignments — Location resolution', () => {
  it('takes the Location from a single-Location membership (R57)', () => {
    const t1 = tool({ toolId: 't1' });
    const out = decideAssignments(
      input({ roleRequirements: [['t1']], tools: { t1 }, locationIds: [LOC_1] }),
    );
    expect(out[0]!.locationId).toBe(LOC_1);
  });

  it('records the Location contributing more parts (R58)', () => {
    // LOC_1 requires one part, LOC_2 requires two — LOC_2 contributes more.
    const t1 = tool({
      toolId: 't1',
      allPartKeys: ['p1', 'p2', 'p3'],
      locationPartKeys: { [LOC_1]: ['p1'], [LOC_2]: ['p1', 'p2'] },
    });
    const out = decideAssignments(
      input({ roleRequirements: [['t1']], tools: { t1 }, locationIds: [LOC_1, LOC_2] }),
    );
    expect(out[0]!.locationId).toBe(LOC_2);
  });

  it('breaks a parts tie by the more demanding assessor requirement (R59)', () => {
    // Both Locations require the same parts; LOC_2 needs an extra assessor ticket.
    const t1 = tool({
      toolId: 't1',
      locationPartKeys: { [LOC_1]: ['p1', 'p2'], [LOC_2]: ['p1', 'p2'] },
      assessorStreamCompetencyIds: { [LOC_1]: [COMP_A], [LOC_2]: [COMP_A, COMP_B] },
    });
    const out = decideAssignments(
      input({ roleRequirements: [['t1']], tools: { t1 }, locationIds: [LOC_1, LOC_2] }),
    );
    expect(out[0]!.locationId).toBe(LOC_2);
  });

  it('breaks a full tie by the first Location on the membership (R60)', () => {
    // Identical on parts and on assessor demand — order decides.
    const t1 = tool({
      toolId: 't1',
      locationPartKeys: { [LOC_1]: ['p1'], [LOC_2]: ['p1'] },
      assessorStreamCompetencyIds: { [LOC_1]: [COMP_A], [LOC_2]: [COMP_A] },
    });
    const out = decideAssignments(
      input({ roleRequirements: [['t1']], tools: { t1 }, locationIds: [LOC_2, LOC_1] }),
    );
    // LOC_2 is first on the membership.
    expect(out[0]!.locationId).toBe(LOC_2);
  });

  it('resolves to the first Location when no parts rule is declared anywhere (R60, R75)', () => {
    // No rule → every Location contributes every part → a full tie on step one.
    const t1 = tool({ toolId: 't1', locationPartKeys: {}, assessorStreamCompetencyIds: {} });
    const out = decideAssignments(
      input({ roleRequirements: [['t1']], tools: { t1 }, locationIds: [LOC_1, LOC_2] }),
    );
    expect(out[0]!.locationId).toBe(LOC_1);
  });
});
