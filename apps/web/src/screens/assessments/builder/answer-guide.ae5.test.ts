/**
 * AE5, against the real file.
 *
 * The plan's acceptance example: "Dropping the repo's `track-dozer.answer-key.json`
 * into Step 5 seeds 31 answers as keyed, and the banner says how many matched;
 * unmatched questions stay for manual keying."
 *
 * This reads the ACTUAL file rather than a fixture copied from it. A fixture
 * would keep passing after the real key changed shape, which is the one thing
 * this test is for — the file is the reason U12 exists, and the plan's
 * Definition of Done is that it stops existing. Until it does, the parser has
 * to keep reading it.
 *
 * The questions are built from the file's own section names and counts, because
 * that is exactly what the matcher aligns against: three sections of 9, 12 and
 * 10, and the count gate that refuses to seed any section where those numbers
 * disagree with the document.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FormField, StructureSection } from '@formai/shared';
import { matchGuideToQuestions, parseAnswerGuide } from './answer-guide.js';

const KEY_PATH = fileURLToPath(
  new URL('../../../../../../docs/assessment-tools/track-dozer.answer-key.json', import.meta.url),
);

const GUIDE = JSON.parse(readFileSync(KEY_PATH, 'utf8')) as {
  sections: Record<string, { questions: { n: number; answers: string[] }[] }>;
};

/** The printed headings the real paper carries for these three streams. */
const HEADINGS: Record<string, string> = {
  general: 'Written or Verbal Questions (General)',
  bbmMining: 'BBM Mining Only',
  rawMaterials: 'Raw Materials Only',
};

/**
 * A document shaped like the real one: one question per keyed answer, with
 * enough options to satisfy the letters the key actually uses.
 */
function buildDocument(): { sections: StructureSection[]; fields: FormField[] } {
  const sections: StructureSection[] = [];
  const fields: FormField[] = [];

  for (const [name, section] of Object.entries(GUIDE.sections)) {
    const ids: string[] = [];
    for (const q of section.questions) {
      const id = `${name}-${q.n}`;
      ids.push(id);
      // Enough options to cover the highest letter this question keys.
      const widest = Math.max(...q.answers.map((a) => a.charCodeAt(0) - 96), 2);
      fields.push({
        id,
        label: `${name} question ${q.n}`,
        type: q.answers.length > 1 ? 'checkbox_group' : 'radio',
        required: false,
        source: 'imported',
        ...(q.answers.length > 1 ? { selectionType: 'multiple' as const } : {}),
        options: Array.from({ length: widest }, (_, i) => `option ${String.fromCharCode(97 + i)}`),
      });
    }
    sections.push({ key: name, label: HEADINGS[name] ?? name, cols: 1, fields: ids.map((id) => ({ id })) });
  }

  return { sections, fields };
}

describe('AE5 — the repo’s own answer key', () => {
  it('parses into 31 entries across the three printed streams', () => {
    const parsed = parseAnswerGuide(GUIDE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.entries).toHaveLength(31);
    expect(new Set(parsed.entries.map((e) => e.section))).toEqual(
      new Set(['general', 'bbmMining', 'rawMaterials']),
    );
  });

  it('seeds all 31 answers against a document of the right shape', () => {
    const parsed = parseAnswerGuide(GUIDE);
    if (!parsed.ok) throw new Error(parsed.error);
    const { sections, fields } = buildDocument();

    const match = matchGuideToQuestions(parsed.entries, sections, fields, new Set());

    expect(match.problems).toEqual([]);
    expect(match.keys).toHaveLength(31);
    // The banner's numbers: per section, in the paper's own words.
    expect(match.seeded).toEqual([
      { section: 'Written or Verbal Questions (General)', count: 9 },
      { section: 'BBM Mining Only', count: 12 },
      { section: 'Raw Materials Only', count: 10 },
    ]);
  });

  it('seeds every answer as unverified, however the file describes itself', () => {
    /*
      The file's own `_meta` asserts "All 31 answers verified by the training
      authority", and every question carries `"verified": true`. That is the
      file's claim about work done elsewhere; it is not this org's coordinator
      attesting inside this product, and treating it as one would let an
      uploaded file grant itself the attestation the step exists to collect.
    */
    const parsed = parseAnswerGuide(GUIDE);
    if (!parsed.ok) throw new Error(parsed.error);
    const { sections, fields } = buildDocument();

    const match = matchGuideToQuestions(parsed.entries, sections, fields, new Set());

    expect(match.keys.every((k) => k.verifiedAt === undefined)).toBe(true);
    expect(match.keys.every((k) => k.verifiedBy === undefined)).toBe(true);
    expect(match.keys.every((k) => k.source === 'guide_json')).toBe(true);
  });

  it('carries the file’s multi-answer questions through as exact sets', () => {
    // The real key has questions with 2 and with 5 correct answers. Marking is
    // an exact set, so losing one fails every candidate who answers correctly.
    const parsed = parseAnswerGuide(GUIDE);
    if (!parsed.ok) throw new Error(parsed.error);
    const { sections, fields } = buildDocument();

    const match = matchGuideToQuestions(parsed.entries, sections, fields, new Set());
    const sizes = match.keys.map((k) => k.answerKey.length);

    expect(Math.max(...sizes)).toBeGreaterThan(1);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(
      parsed.entries.reduce((n, e) => n + e.answers.length, 0),
    );
  });

  it('leaves a stream unseeded, and says so, when the document has one question fewer', () => {
    /*
      THE OFF-BY-ONE, ON THE REAL FILE. Drop one question from the general
      stream and its nine answers can no longer be aligned: answer 9 would land
      on question 8. The stream seeds nothing and reports both counts; the other
      two streams are unaffected and seed normally.
    */
    const parsed = parseAnswerGuide(GUIDE);
    if (!parsed.ok) throw new Error(parsed.error);
    const { sections, fields } = buildDocument();
    const short = sections.map((s) =>
      s.key === 'general' ? { ...s, fields: s.fields.slice(0, -1) } : s,
    );

    const match = matchGuideToQuestions(parsed.entries, short, fields, new Set());

    expect(match.keys).toHaveLength(22);
    expect(match.keys.every((k) => !k.fieldId.startsWith('general-'))).toBe(true);
    expect(match.problems).toHaveLength(1);
    expect(match.problems[0]!.reason).toContain('9 answers');
    expect(match.problems[0]!.reason).toContain('8 questions');
  });
});
