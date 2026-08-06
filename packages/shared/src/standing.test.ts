/**
 * Standing is derived, never stored, and answers a different question from
 * currency. These pin the two halves the plan flags as most likely to be
 * conflated: an OPTIONAL competency is still a real held ticket (currency's
 * business), and a competency stops being REQUIRED with no write the moment no
 * held Role requires it.
 */
import { describe, expect, it } from 'vitest';
import { requiredCompetencyIds, resolveStanding, standingOf } from './standing.js';

const COMP_DOZER = 'comp-dozer';
const COMP_FIRST_AID = 'comp-first-aid';
const COMP_LEGACY = 'comp-legacy';

const TOOL_DOZER = 'tool-dozer';
const TOOL_FIRST_AID = 'tool-first-aid';

const AWARDS = {
  [TOOL_DOZER]: [COMP_DOZER],
  [TOOL_FIRST_AID]: [COMP_FIRST_AID],
};

describe('resolveStanding', () => {
  it('reads required when a held Role requires a tool that awards it (R88, R90)', () => {
    const standing = resolveStanding({
      heldCompetencyIds: [COMP_DOZER],
      requiredToolIds: [TOOL_DOZER],
      awardsByTool: AWARDS,
    });

    expect(standing[COMP_DOZER]).toBe('required');
  });

  it('reads optional when no held Role requires it (R91)', () => {
    // The person holds the first-aid ticket, but none of their Roles require
    // the tool that awards it — it is a voluntary extra.
    const standing = resolveStanding({
      heldCompetencyIds: [COMP_FIRST_AID],
      requiredToolIds: [TOOL_DOZER],
      awardsByTool: AWARDS,
    });

    expect(standing[COMP_FIRST_AID]).toBe('optional');
  });

  it('turns a once-required competency optional the moment the Role stops being held (R92)', () => {
    // Same held ticket, resolved twice: once while the dozer Role is held, once
    // after it is gone. Nothing about the RECORD changed — only the derivation.
    const heldCompetencyIds = [COMP_DOZER];

    const whileRequired = resolveStanding({
      heldCompetencyIds,
      requiredToolIds: [TOOL_DOZER],
      awardsByTool: AWARDS,
    });
    const afterRoleGone = resolveStanding({
      heldCompetencyIds,
      requiredToolIds: [],
      awardsByTool: AWARDS,
    });

    expect(whileRequired[COMP_DOZER]).toBe('required');
    expect(afterRoleGone[COMP_DOZER]).toBe('optional');
  });

  it('reads a migrated competency nothing requires as optional (R93)', () => {
    // A competency carried over from before Roles had requirements: held, but
    // awarded by no required tool. Optional, not an error.
    const standing = resolveStanding({
      heldCompetencyIds: [COMP_LEGACY],
      requiredToolIds: [TOOL_DOZER, TOOL_FIRST_AID],
      awardsByTool: AWARDS,
    });

    expect(standing[COMP_LEGACY]).toBe('optional');
  });

  it('lets a withdrawn Role contribute nothing — the caller excludes it (R52, R90)', () => {
    // Withdrawn Roles never reach the resolver. A competency awarded only by a
    // withdrawn Role's tool therefore appears in no required tool id and reads
    // optional, exactly as if that Role were never held.
    const standing = resolveStanding({
      heldCompetencyIds: [COMP_DOZER, COMP_FIRST_AID],
      requiredToolIds: [TOOL_FIRST_AID], // the dozer Role was withdrawn, so its tool is absent
      awardsByTool: AWARDS,
    });

    expect(standing[COMP_DOZER]).toBe('optional');
    expect(standing[COMP_FIRST_AID]).toBe('required');
  });

  it('resolves every held competency, required and optional together', () => {
    const standing = resolveStanding({
      heldCompetencyIds: [COMP_DOZER, COMP_FIRST_AID, COMP_LEGACY],
      requiredToolIds: [TOOL_DOZER],
      awardsByTool: AWARDS,
    });

    expect(standing).toEqual({
      [COMP_DOZER]: 'required',
      [COMP_FIRST_AID]: 'optional',
      [COMP_LEGACY]: 'optional',
    });
  });

  it('reads standing without ever consulting currency (R101 vs R105)', () => {
    // The resolver takes no dates, no grant, no revoked flag — it CANNOT read
    // currency, which is the structural guarantee that standing and currency
    // stay two answers to two questions. An expired required ticket is still
    // `required` here (it counts against compliance when it lapses, R101); a
    // current optional ticket is still `optional` (it satisfies a prerequisite
    // on its currency alone, R105) — neither fact leaks into the other.
    const standing = resolveStanding({
      heldCompetencyIds: [COMP_DOZER, COMP_FIRST_AID],
      requiredToolIds: [TOOL_DOZER],
      awardsByTool: AWARDS,
    });

    expect(standing[COMP_DOZER]).toBe('required');
    expect(standing[COMP_FIRST_AID]).toBe('optional');
  });
});

describe('requiredCompetencyIds', () => {
  it('unions the awards of every required tool (R48)', () => {
    const required = requiredCompetencyIds([TOOL_DOZER, TOOL_FIRST_AID], AWARDS);

    expect([...required].sort()).toEqual([COMP_DOZER, COMP_FIRST_AID].sort());
  });

  it('treats a required tool that awards nothing, or is unknown, as adding nothing', () => {
    const required = requiredCompetencyIds(['tool-unknown', TOOL_DOZER], AWARDS);

    expect([...required]).toEqual([COMP_DOZER]);
  });
});

describe('standingOf', () => {
  it('is required exactly when the id is in the required set', () => {
    const required = new Set([COMP_DOZER]);

    expect(standingOf(COMP_DOZER, required)).toBe('required');
    expect(standingOf(COMP_FIRST_AID, required)).toBe('optional');
  });
});
