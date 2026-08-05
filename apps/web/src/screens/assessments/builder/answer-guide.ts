/**
 * Seeding an answer key from an uploaded guide.
 *
 * THE ALIGNMENT PROBLEM, HANDLED RATHER THAN INHERITED. A printed answer guide
 * identifies its answers by section and question NUMBER — "General 4: b, c" —
 * and no published field carries that number. So matching a guide onto real
 * questions can only be done by ORDER within a section, which is exactly the
 * positional alignment `author-track-dozer-tool.mjs` performs and exactly why
 * it refuses to write on a count mismatch: one missing question shifts every
 * later entry and writes question 8's answers onto question 7. On a safety
 * assessment that marks a candidate wrong on a question they answered
 * correctly, and right on one they did not.
 *
 * The rule here is the script's, scoped tighter:
 *
 *   A SECTION SEEDS ONLY IF ITS QUESTION COUNT MATCHES EXACTLY.
 *
 * Per section rather than per document, because a mismatch in one optional
 * stream should not block the two that are correct — and every section that
 * does not seed is REPORTED by name and count, never dropped quietly. Writing
 * nothing is the only safe response to a misalignment that cannot be localised;
 * saying nothing is not.
 *
 * AND A SEEDED ANSWER IS NOT A VERIFIED ONE. Everything matched here lands with
 * `source: 'guide_json'` and no attestation, however confidently the guide
 * asserted it. The coordinator still has to say they checked it.
 */

import type { DraftAnswerKey, FormField, StructureSection } from '@formai/shared';

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/** One answer the guide asserts, before it is matched to a field. */
export interface GuideEntry {
  /** The guide's own name for the section, as written. */
  section: string;
  /** 1-based question number within that section. */
  n: number;
  /** Answers as the guide gives them — letters ("b") or option text. */
  answers: string[];
}

export type GuideParse = { ok: true; entries: GuideEntry[] } | { ok: false; error: string };

const SHAPES_HINT =
  'Expected either {"sections":{"general":{"questions":[{"n":1,"answers":["a"]}]}}} or {"answers":{"General:1":["a"]}}.';

/**
 * Read a guide in either shape.
 *
 * Two are accepted because two exist: the sectioned shape is what this repo's
 * own `track-dozer.answer-key.json` uses, and the flat `"Section:n"` shape is
 * what the design prototype emitted. Refusing one of them would mean hand-
 * converting a file that is already correct.
 */
export function parseAnswerGuide(raw: unknown): GuideParse {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: `That file is not a JSON object. ${SHAPES_HINT}` };
  }
  const doc = raw as Record<string, unknown>;

  if (doc.sections && typeof doc.sections === 'object') {
    const entries: GuideEntry[] = [];
    for (const [section, value] of Object.entries(doc.sections as Record<string, unknown>)) {
      const questions = (value as { questions?: unknown })?.questions;
      if (!Array.isArray(questions)) continue;
      for (const q of questions) {
        const item = q as { n?: unknown; answers?: unknown };
        const n = Number(item.n);
        if (!Number.isInteger(n) || n < 1) continue;
        const answers = Array.isArray(item.answers) ? item.answers.map(String) : [];
        if (answers.length === 0) continue;
        entries.push({ section, n, answers });
      }
    }
    return entries.length > 0
      ? { ok: true, entries }
      : { ok: false, error: `That guide has a "sections" key but no questions in it. ${SHAPES_HINT}` };
  }

  if (doc.answers && typeof doc.answers === 'object') {
    const entries: GuideEntry[] = [];
    for (const [key, value] of Object.entries(doc.answers as Record<string, unknown>)) {
      const at = key.lastIndexOf(':');
      if (at < 0) continue;
      const n = Number(key.slice(at + 1));
      if (!Number.isInteger(n) || n < 1) continue;
      const answers = Array.isArray(value) ? value.map(String) : [String(value)];
      if (answers.length === 0) continue;
      entries.push({ section: key.slice(0, at), n, answers });
    }
    return entries.length > 0
      ? { ok: true, entries }
      : { ok: false, error: `That guide has an "answers" key but no usable entries. ${SHAPES_HINT}` };
  }

  return { ok: false, error: `That file is not an answer guide. ${SHAPES_HINT}` };
}

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

/** Strip everything but letters and digits, so naming styles can be compared. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Whether a guide's section name and a document heading refer to the same
 * section.
 *
 * Containment either way, on normalized text: a guide says "bbmMining" and the
 * paper prints "BBM Mining Only"; a guide says "general" and the paper prints
 * "Written or Verbal Questions (General)". Requiring equality would match
 * neither, and every real guide would report as entirely unmatched.
 */
export function sectionsMatch(guideName: string, heading: string): boolean {
  const a = normalize(guideName);
  const b = normalize(heading);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Turn one guide answer into an option value.
 *
 * A guide gives letters far more often than text, because that is what a
 * printed key prints. A letter is resolved POSITIONALLY against the question's
 * own options — "b" is the second one — and anything that is not a single
 * letter is compared against the option text instead, so a guide that spells
 * its answers out still works.
 *
 * Returns null rather than guessing when neither route resolves. A wrong option
 * here is a question every candidate fails.
 */
export function resolveAnswer(answer: string, options: readonly string[]): string | null {
  const trimmed = answer.trim();
  if (!trimmed) return null;

  if (/^[a-z]$/i.test(trimmed)) {
    const index = trimmed.toLowerCase().charCodeAt(0) - 97;
    return options[index] ?? null;
  }

  const exact = options.find((o) => o === trimmed);
  if (exact) return exact;
  const loose = options.find((o) => normalize(o) === normalize(trimmed));
  return loose ?? null;
}

/** Why a section could not be seeded. Reported, never swallowed. */
export interface GuideProblem {
  section: string;
  reason: string;
}

export interface GuideMatch {
  keys: DraftAnswerKey[];
  problems: GuideProblem[];
  /** Sections that seeded, with how many answers each contributed. */
  seeded: { section: string; count: number }[];
}

/**
 * Match a parsed guide onto the builder's questions.
 *
 * `sections` is the author's current arrangement, which is what they see; the
 * questions inside one are taken in their arranged order, since that order is
 * what the numbers in the guide are being aligned against.
 */
export function matchGuideToQuestions(
  entries: readonly GuideEntry[],
  sections: readonly StructureSection[],
  fields: readonly FormField[],
  excluded: ReadonlySet<string>,
): GuideMatch {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const keys: DraftAnswerKey[] = [];
  const problems: GuideProblem[] = [];
  const seeded: { section: string; count: number }[] = [];

  const bySection = new Map<string, GuideEntry[]>();
  for (const entry of entries) {
    const bucket = bySection.get(entry.section) ?? [];
    bucket.push(entry);
    bySection.set(entry.section, bucket);
  }

  for (const [name, group] of bySection) {
    const section = sections.find((s) => sectionsMatch(name, s.label));
    if (!section) {
      problems.push({
        section: name,
        reason: `No section in this document matches "${name}". Its ${group.length} answer${group.length === 1 ? '' : 's'} were not applied.`,
      });
      continue;
    }

    // Only questions — a section's headings and text boxes are not numbered by
    // a guide and must not consume one of its positions.
    const questions = section.fields
      .map((f) => byId.get(f.id))
      .filter((f): f is FormField => !!f && (f.options?.length ?? 0) > 0 && !excluded.has(f.id));

    /*
      THE COUNT GATE. The guide's numbers are aligned against these questions by
      ORDER, so a count that does not match means every entry after the first
      discrepancy lands on the wrong question — silently, and on a safety
      record. Seed nothing for this section and say exactly what was seen.
    */
    if (questions.length !== group.length) {
      problems.push({
        section: name,
        reason: `The guide has ${group.length} answer${group.length === 1 ? '' : 's'} for "${section.label}", which has ${questions.length} question${questions.length === 1 ? '' : 's'}. Answers are aligned by order, so none were applied — key this section by hand, or correct the question types first.`,
      });
      continue;
    }

    let count = 0;
    for (const entry of group) {
      const question = questions[entry.n - 1];
      if (!question) {
        problems.push({
          section: name,
          reason: `"${section.label}" has no question ${entry.n}. That answer was not applied.`,
        });
        continue;
      }
      const options = question.options ?? [];
      const resolved = entry.answers.map((a) => resolveAnswer(a, options));
      if (resolved.some((r) => r === null)) {
        const unresolved = entry.answers.filter((a, i) => resolved[i] === null);
        problems.push({
          section: name,
          reason: `Question ${entry.n} of "${section.label}" names ${unresolved.map((u) => `"${u}"`).join(', ')}, which is not one of its ${options.length} options. That answer was not applied.`,
        });
        continue;
      }
      keys.push({
        fieldId: question.id,
        answerKey: resolved as string[],
        // Seeded, never attested. However confident the guide, a person still
        // has to say they checked it.
        source: 'guide_json',
      });
      count += 1;
    }
    if (count > 0) seeded.push({ section: section.label, count });
  }

  return { keys, problems, seeded };
}
