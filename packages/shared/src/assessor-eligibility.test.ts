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
 * location rather than chosen. The failure worth guarding against is the quiet
 * one: a mining assessment accepted from someone whose authority covers raw
 * materials, with nothing anywhere saying so.
 */
import { describe, expect, it } from 'vitest';
import { resolveAssessorRequirements, streamCheckWarning } from './assessor-eligibility.js';

/** The real codes, as ids. */
const CATEGORY = 'Q34666893';
const WORSLEY = 'Q50071833';
const MOBILE_PLANT = 'Q50073293';

/**
 * "Mining", not "Mine" — the spelling the document, the section headings and
 * every other part of this system use. The stream is one free-text value shared
 * with the document's own stream question, so the eligibility rule does not get
 * to pick its own vocabulary.
 */
const TRACK_DOZER = {
  always: [CATEGORY],
  byStream: {
    Mining: [WORSLEY],
    'Raw Materials': [MOBILE_PLANT],
  },
};

describe('resolveAssessorRequirements', () => {
  it('requires the category plus the mining authority at the mine', () => {
    const resolved = resolveAssessorRequirements(TRACK_DOZER, 'Mining');

    expect(resolved.required).toEqual([CATEGORY, WORSLEY]);
    expect(resolved.streamCheck).toBe('matched');
  });

  it('requires the category plus the raw materials authority there', () => {
    // The one that matters: this must NOT accept the Worsley skill set.
    const resolved = resolveAssessorRequirements(TRACK_DOZER, 'Raw Materials');

    expect(resolved.required).toEqual([CATEGORY, MOBILE_PLANT]);
    expect(resolved.required).not.toContain(WORSLEY);
  });

  it('never demands both site authorities at once', () => {
    // A flat AND list of all three would. Nobody holds both, so every case
    // would open carrying a warning that can never be satisfied — and a warning
    // that is always wrong is one people stop reading.
    for (const stream of ['Mining', 'Raw Materials']) {
      const { required } = resolveAssessorRequirements(TRACK_DOZER, stream);
      expect(required).toContain(CATEGORY);
      expect(required.includes(WORSLEY) && required.includes(MOBILE_PLANT)).toBe(false);
    }
  });

  it('matches a stream however it was typed', () => {
    // The case's stream is free text somebody enters by hand. Treating
    // "raw materials" as a different place from "Raw Materials" would skip the
    // check silently.
    for (const typed of ['Raw Materials', 'raw materials', 'RAW MATERIALS', '  Raw Materials  ']) {
      expect(resolveAssessorRequirements(TRACK_DOZER, typed).required).toEqual([
        CATEGORY,
        MOBILE_PLANT,
      ]);
    }
  });

  it('says plainly when the stream is missing, rather than passing the case', () => {
    /*
      Reporting only the always-required half here would present a partial check
      as a complete one. The case still opens — nothing about eligibility ever
      blocks — but whoever reads it has to know the location-specific half went
      unchecked.
    */
    const resolved = resolveAssessorRequirements(TRACK_DOZER, null);

    expect(resolved.required).toEqual([CATEGORY]);
    expect(resolved.streamCheck).toBe('missing');
    expect(resolved.knownStreams).toEqual(['Mining', 'Raw Materials']);
  });

  it('treats blank and whitespace as missing', () => {
    for (const empty of ['', '   ', undefined]) {
      expect(resolveAssessorRequirements(TRACK_DOZER, empty).streamCheck).toBe('missing');
    }
  });

  it('FLAGS a stream it does not recognise instead of waving the case through', () => {
    /*
      THE BUG THIS REPLACES. An earlier version returned a clean result here,
      reasoning that a stream outside the list was a location carrying no extra
      requirement. But this value is free text shared with the document's own
      stream question, so a value outside the list is far more likely to be a
      near-miss spelling of a location the rule DOES cover.

      "Mine" against a tool keyed "Mining" reduced the rule to the category
      alone and reported it as fully checked — so an assessor holding only the
      raw-materials authority signed off a mining assessment with no warning
      anywhere. That is the exact cross-site pass this function exists to stop.
    */
    const resolved = resolveAssessorRequirements(TRACK_DOZER, 'Mine');

    expect(resolved.required).toEqual([CATEGORY]);
    expect(resolved.streamCheck).toBe('unrecognised');
  });

  it('does not flag a tool that has no location-specific requirements', () => {
    // Every tool that existed before this. A missing stream is not a gap when
    // nothing depended on it, and warning here would fire on every case in the
    // system.
    const flat = { always: [CATEGORY] };

    expect(resolveAssessorRequirements(flat, null)).toEqual({
      required: [CATEGORY],
      streamCheck: 'not_applicable',
      knownStreams: [],
    });
    expect(resolveAssessorRequirements(flat, 'Anywhere').streamCheck).toBe('not_applicable');
  });

  it('does not report the same competency twice', () => {
    // A tool may name the category in both halves. Warning about one gap twice
    // reads as two people missing two things.
    const doubled = { always: [CATEGORY], byStream: { Mining: [CATEGORY, WORSLEY] } };

    expect(resolveAssessorRequirements(doubled, 'Mining').required).toEqual([CATEGORY, WORSLEY]);
  });
});

describe('streamCheckWarning', () => {
  const KNOWN = ['Mining', 'Raw Materials'];

  it('names the streams the tool expects when none was given', () => {
    // The fix is to set one, and nobody can guess the spelling the tool wants.
    const warning = streamCheckWarning({ streamCheck: 'missing', knownStreams: KNOWN }, null);

    expect(warning).toContain('only partly checked');
    expect(warning).toContain('Mining');
    expect(warning).toContain('Raw Materials');
  });

  it('quotes the unrecognised value so the typo is visible', () => {
    // "not one this assessment has requirements for" is only actionable if the
    // reader can see what was actually recorded.
    const warning = streamCheckWarning({ streamCheck: 'unrecognised', knownStreams: KNOWN }, 'Mine');

    expect(warning).toContain('only partly checked');
    expect(warning).toContain('"Mine"');
    expect(warning).toContain('Mining');
  });

  it('says nothing when the check was complete', () => {
    for (const streamCheck of ['matched', 'not_applicable'] as const) {
      expect(streamCheckWarning({ streamCheck, knownStreams: KNOWN }, 'Mining')).toBeNull();
    }
  });
});
