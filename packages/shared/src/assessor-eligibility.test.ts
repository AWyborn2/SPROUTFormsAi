/**
 * Who may assess this, and where.
 *
 * The rule these pin comes from the Track Dozer document and from the customer:
 *
 *   · Q34666893 ATO Track Dozer is required ALWAYS — it is the category of
 *     assessment, so an assessor must hold the ticket they are assessing
 *   · Q50071833 Worsley Assessor Skill Set authorises MINING assessments
 *   · Q50073293 Authority to Assess Mobile Equipment authorises RAW MATERIALS
 *
 * i.e. `Q34666893 AND (Q50071833 OR Q50073293)`, where the OR is decided by
 * Location rather than chosen. The failure worth guarding against is the quiet
 * one: a mining assessment accepted from someone whose authority covers raw
 * materials, with nothing anywhere saying so.
 *
 * U8: the rule is now keyed by LOCATION ID, and a case records a location_id
 * chosen from the organisation's list. A near-miss is impossible, so a value
 * outside the rule's keys is a Location with no extra requirement, not a typo.
 */
import { describe, expect, it } from 'vitest';
import { resolveAssessorRequirements, streamCheckWarning } from './assessor-eligibility.js';

/** The real competency codes. */
const CATEGORY = 'Q34666893';
const WORSLEY = 'Q50071833';
const MOBILE_PLANT = 'Q50073293';

/** Managed Location ids the rule is keyed by. */
const MINING = 'loc-mining-0000-0000-0000-000000000001';
const RAW_MATERIALS = 'loc-rawmat-0000-0000-0000-000000000002';

const TRACK_DOZER = {
  always: [CATEGORY],
  byStream: {
    [MINING]: [WORSLEY],
    [RAW_MATERIALS]: [MOBILE_PLANT],
  },
};

describe('resolveAssessorRequirements', () => {
  it('requires the category plus the mining authority at the mine', () => {
    const resolved = resolveAssessorRequirements(TRACK_DOZER, MINING);
    expect(resolved.required).toEqual([CATEGORY, WORSLEY]);
    expect(resolved.streamCheck).toBe('matched');
  });

  it('requires the category plus the raw materials authority there', () => {
    // The one that matters: this must NOT accept the Worsley skill set.
    const resolved = resolveAssessorRequirements(TRACK_DOZER, RAW_MATERIALS);
    expect(resolved.required).toEqual([CATEGORY, MOBILE_PLANT]);
    expect(resolved.required).not.toContain(WORSLEY);
  });

  it('never demands both site authorities at once', () => {
    for (const loc of [MINING, RAW_MATERIALS]) {
      const { required } = resolveAssessorRequirements(TRACK_DOZER, loc);
      expect(required).toContain(CATEGORY);
      expect(required.includes(WORSLEY) && required.includes(MOBILE_PLANT)).toBe(false);
    }
  });

  it('matches a Location by exact id', () => {
    // A Location id is chosen from a list, never typed, so there is nothing to
    // normalise — the match is a plain lookup.
    expect(resolveAssessorRequirements(TRACK_DOZER, RAW_MATERIALS).required).toEqual([
      CATEGORY,
      MOBILE_PLANT,
    ]);
  });

  it('says plainly when the Location is missing, rather than passing the case', () => {
    const resolved = resolveAssessorRequirements(TRACK_DOZER, null);
    expect(resolved.required).toEqual([CATEGORY]);
    expect(resolved.streamCheck).toBe('missing');
    expect(resolved.knownLocationIds).toEqual([MINING, RAW_MATERIALS]);
  });

  it('treats blank and undefined as missing', () => {
    for (const empty of ['', undefined, null]) {
      expect(resolveAssessorRequirements(TRACK_DOZER, empty).streamCheck).toBe('missing');
    }
  });

  it('a Location the tool has no rule for is matched with the always half, not flagged (R79)', () => {
    /*
      THE CHANGE FROM THE OLD NEAR-MISS BEHAVIOUR. When the value was free text a
      stream outside the list was probably a typo of a real site, so it was
      flagged. Now the value is a Location id chosen from the managed list — it
      cannot be a near-miss. A Location the tool declares no rule for genuinely
      carries no extra requirement, so the case is `matched` with the
      always-required half and nothing is skipped silently.
    */
    const somewhereElse = 'loc-elsewhere-0000-0000-0000-000000000009';
    const resolved = resolveAssessorRequirements(TRACK_DOZER, somewhereElse);
    expect(resolved.required).toEqual([CATEGORY]);
    expect(resolved.streamCheck).toBe('matched');
  });

  it('does not flag a tool that has no location-specific requirements', () => {
    const flat = { always: [CATEGORY] };
    expect(resolveAssessorRequirements(flat, null)).toEqual({
      required: [CATEGORY],
      streamCheck: 'not_applicable',
      knownLocationIds: [],
    });
    expect(resolveAssessorRequirements(flat, MINING).streamCheck).toBe('not_applicable');
  });

  it('does not report the same competency twice', () => {
    const doubled = { always: [CATEGORY], byStream: { [MINING]: [CATEGORY, WORSLEY] } };
    expect(resolveAssessorRequirements(doubled, MINING).required).toEqual([CATEGORY, WORSLEY]);
  });
});

describe('streamCheckWarning', () => {
  it('names the Locations the tool expects when none was recorded', () => {
    const warning = streamCheckWarning({ streamCheck: 'missing' }, ['Mining', 'Raw Materials']);
    expect(warning).toContain('only partly checked');
    expect(warning).toContain('Mining');
    expect(warning).toContain('Raw Materials');
  });

  it('still warns on a missing Location even without names to list', () => {
    const warning = streamCheckWarning({ streamCheck: 'missing' });
    expect(warning).toContain('records no location');
  });

  it('says nothing when the check was complete', () => {
    for (const streamCheck of ['matched', 'not_applicable'] as const) {
      expect(streamCheckWarning({ streamCheck }, ['Mining'])).toBeNull();
    }
  });
});
