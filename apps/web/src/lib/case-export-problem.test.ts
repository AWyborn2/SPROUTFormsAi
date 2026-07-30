/**
 * Turning an export failure into something a training officer can act on.
 *
 * The evidence export fails six distinct ways and each needs a DIFFERENT next
 * step: place geometry, re-author the tool, ask an admin, or wait. What these
 * tests pin is that the six stay distinguishable — a single "export failed"
 * would leave someone stuck on the one document they need for an audit with no
 * idea which of those to do.
 *
 * The server-named `problems` are also pinned to survive intact. "3 problems"
 * tells a reader nothing they can fix.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from './data/api-client.js';
import { caseExportFilename, caseExportProblem } from './case-export-problem.js';

const apiError = (status: number, body: unknown) => new ApiError(status, body);

describe('caseExportProblem', () => {
  it('tells a built form apart from a broken one', () => {
    const p = caseExportProblem(apiError(422, { error: 'no_source_pdf' }));

    expect(p.message).toMatch(/no original PDF/i);
    // The remedy is the part that is not guessable from the status code.
    expect(p.remedy).toMatch(/import/i);
  });

  it('names the offending parts when the manifest no longer fits its form', () => {
    const p = caseExportProblem(
      apiError(409, {
        error: 'case_export_invalid_manifest',
        problems: ['Part 3 anchor "h-log" is not a field on this version'],
      }),
    );

    expect(p.problems).toEqual(['Part 3 anchor "h-log" is not a field on this version']);
    expect(p.remedy).toMatch(/authoring/i);
  });

  it('reassures that a refused export drew nothing', () => {
    // The anxious question in the room: did it half-write a competency record?
    const p = caseExportProblem(apiError(409, { error: 'case_export_invalid_manifest', problems: [] }));

    expect(p.remedy).toMatch(/nothing is drawn|no wrong marks/i);
  });

  it('distinguishes a part the tool no longer declares', () => {
    const p = caseExportProblem(
      apiError(409, {
        error: 'case_export_unknown_part',
        problems: ['Attempt references part "p7", which this tool\'s manifest does not declare.'],
      }),
    );

    expect(p.message).toMatch(/no longer declares/i);
    expect(p.problems).toHaveLength(1);
  });

  it('separates a storage fault from anything about the case', () => {
    const p = caseExportProblem(apiError(503, { error: 'storage_unavailable' }));

    // Someone chasing a case problem should not waste time on the case.
    expect(p.remedy).toMatch(/configuration/i);
  });

  it('sends a permission failure to the right person', () => {
    const p = caseExportProblem(apiError(403, {}));

    expect(p.message).toMatch(/permission/i);
    expect(p.remedy).toMatch(/administrator/i);
  });

  it('offers no false remedy when a case has simply gone', () => {
    const p = caseExportProblem(apiError(404, {}));

    expect(p.remedy).toBe('');
  });

  it('still says something useful for an unrecognised failure', () => {
    const p = caseExportProblem(apiError(500, { error: 'something_new' }));

    expect(p.message).toBeTruthy();
    expect(p.remedy).toMatch(/report/i);
  });

  it('separates a network failure from a server refusal', () => {
    const p = caseExportProblem(new TypeError('fetch failed'));

    expect(p.message).toMatch(/reach the server/i);
    expect(p.problems).toEqual([]);
  });

  it('survives a body that carries no problems array', () => {
    const p = caseExportProblem(apiError(409, { error: 'case_export_invalid_manifest', problems: 'nope' }));

    expect(p.problems).toEqual([]);
  });

  it('gives every failure a distinct message', () => {
    const codes = [
      'no_source_pdf',
      'case_export_invalid_manifest',
      'case_export_unknown_part',
      'tool_missing',
      'storage_unavailable',
    ];
    const messages = codes.map((error) => caseExportProblem(apiError(409, { error })).message);

    // The whole point of the mapping. Two failures reading alike would send a
    // reader down the wrong remedy.
    expect(new Set(messages).size).toBe(codes.length);
  });
});

describe('caseExportFilename', () => {
  const on = new Date('2026-07-30T04:00:00Z');

  it('names the tool, the candidate and the date', () => {
    expect(caseExportFilename('Authorised to Operate Track Dozer', 'Dale Rivers', on)).toBe(
      'Authorised-to-Operate-Track-Dozer_Dale-Rivers_2026-07-30.pdf',
    );
  });

  it('strips characters a Windows share will not accept', () => {
    // These get filed on shared drives; a colon or slash makes the file
    // unsaveable at the moment someone tries to keep it.
    const name = caseExportFilename('Dozer: Part 1/2', 'O’Brien, D.', on);

    expect(name).not.toMatch(/[:/\\?*"<>|']/);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('never produces a nameless file', () => {
    expect(caseExportFilename('', '', on)).toBe('2026-07-30.pdf');
    expect(caseExportFilename('!!!', '???', on)).toBe('2026-07-30.pdf');
  });

  it('keeps the name short enough to survive a mail gateway', () => {
    const name = caseExportFilename('x'.repeat(200), 'y'.repeat(200), on);

    expect(name.length).toBeLessThan(140);
  });
});
