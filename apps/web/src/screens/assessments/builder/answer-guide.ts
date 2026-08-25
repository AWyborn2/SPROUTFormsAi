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
 *   A SECTION SEEDS ONLY IF ITS QUESTION COUNT MATCHES EXACTLY —
 *   against the full choice-plus-written list first (how a mixed paper
 *   numbers itself), then against the choice questions alone (how every
 *   older, all-choice guide was written). Failing both refuses the section.
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

import { pairingOption } from '@formai/shared';
import type { DraftAnswerKey, FormField, StructureSection } from '@formai/shared';

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/** One answer the guide asserts, before it is matched to a field. */
export interface GuideEntry {
  /**
   * The guide's own name for the section, as written. EMPTY when the guide
   * numbers its questions flat, with no sections at all — see the entry-list
   * shape below, which is matched by question TEXT instead of by position.
   */
  section: string;
  /** 1-based question number within that section. */
  n: number;
  /** Answers as the guide gives them — letters ("b") or option text. */
  answers: string[];
  /**
   * The question's own printed text, where the guide carries it.
   *
   * WORTH MORE THAN THE NUMBER. Aligning a sectionless guide by position across
   * a whole document is exactly the failure the count gate below exists to
   * prevent — one extra field anywhere shifts every answer after it onto the
   * wrong question, silently, on a safety record. Text identifies a question no
   * matter what sits around it.
   */
  text?: string;
}

export type GuideParse = { ok: true; entries: GuideEntry[] } | { ok: false; error: string };

const SHAPES_HINT =
  'Expected {"sections":{"general":{"questions":[{"n":1,"answers":["a"]}]}}}, ' +
  '{"answers":{"General:1":["a"]}}, or {"answers":[{"question":1,"text":"…","correct_answers":["a"]}]}.';

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
        const item = q as { n?: unknown; answers?: unknown; answer?: unknown; model_answer?: unknown };
        const n = Number(item.n);
        if (!Number.isInteger(n) || n < 1) continue;
        /*
          A WRITTEN entry's answer is prose, and real keys write it three ways:
          `answers` as a one-string list, a bare `answer`, or `model_answer`.
          All land in the same `answers` list — the string is kept verbatim and
          WHAT it is (option letters or a model answer) is decided at match
          time by the question it lands on, because only the question knows
          whether it offers options. A second field here would force the parser
          to guess a kind it cannot know yet.
        */
        const prose = [item.answers, item.answer, item.model_answer].find(
          (raw): raw is string => typeof raw === 'string' && raw.trim().length > 0,
        );
        const answers = Array.isArray(item.answers)
          ? item.answers.map(String)
          : prose
            ? [prose]
            : [];
        if (answers.length === 0) continue;
        entries.push({ section, n, answers });
      }
    }
    return entries.length > 0
      ? { ok: true, entries }
      : { ok: false, error: `That guide has a "sections" key but no questions in it. ${SHAPES_HINT}` };
  }

  /*
    THE ENTRY-LIST SHAPE: `answers` as an ARRAY of objects, each carrying its
    own number, its printed text and its correct options.

    Checked BEFORE the keyed-object branch below, because `typeof [] ===
    'object'` — an array fell into that branch, produced index keys with no
    ":" in them, skipped every one, and reported "no usable entries" on a
    perfectly good guide.

    This is the shape a model produces when asked to derive an answer key from
    a source manual, and it is the richest of the three: it carries the
    question TEXT, which is a far better way to find the question than counting.
  */
  if (Array.isArray(doc.answers)) {
    const entries: GuideEntry[] = [];
    for (const raw of doc.answers) {
      const item = raw as {
        question?: unknown;
        text?: unknown;
        correct_answers?: unknown;
        correct_answer_text?: unknown;
      };
      const n = Number(item.question);
      if (!Number.isInteger(n) || n < 1) continue;

      const answers = entryAnswers(item.correct_answers, item.correct_answer_text);
      if (answers.length === 0) continue;

      entries.push({
        section: '',
        n,
        answers,
        ...(typeof item.text === 'string' && item.text.trim() ? { text: item.text } : {}),
      });
    }
    return entries.length > 0
      ? { ok: true, entries }
      : { ok: false, error: `That guide's "answers" list has no usable entries. ${SHAPES_HINT}` };
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

/** Shorten a label for an error message, so a 90-character question fits. */
function short(text: string): string {
  return text.length > 48 ? `${text.slice(0, 45)}…` : text;
}

/**
 * The question an entry's text names, or why it could not be identified.
 *
 * Exact-normalized first, then containment either way — a guide often quotes a
 * question with the printed "(more than one answer)" hint trimmed, or with it
 * added. AMBIGUITY IS A FAILURE, not a coin flip: two questions matching one
 * entry means seeding either could key the wrong one, and on this document
 * class that marks a candidate against a question they answered correctly.
 */
function questionForText(entry: GuideEntry, questions: readonly FormField[]): FormField | string {
  if (!entry.text) {
    return `Question ${entry.n} carries no question text, and this guide has no sections to count within. It was not applied.`;
  }
  const want = normalize(entry.text);
  if (!want) return `Question ${entry.n} has empty question text. It was not applied.`;

  const exact = questions.filter((q) => normalize(q.label) === want);
  const pool =
    exact.length > 0
      ? exact
      : questions.filter((q) => {
          const have = normalize(q.label);
          return have.includes(want) || want.includes(have);
        });

  if (pool.length === 0) {
    return `No question in this document matches "${short(entry.text)}". That answer was not applied.`;
  }
  if (pool.length > 1) {
    return `"${short(entry.text)}" matches ${pool.length} questions in this document, so it was not applied — key that one by hand.`;
  }
  return pool[0]!;
}

/**
 * One entry's answers, from whichever field the guide put them in.
 *
 * `correct_answers` is preferred and comes in two shapes: a list of option
 * LETTERS, or — for a matching question — an object of prompt → answer, which
 * becomes the same `left → right` pairing strings `buildMatchingQuestion`
 * produces, so a matching question keyed here resolves against its own built
 * options.
 *
 * `correct_answer_text` is the fallback and is often richer, carrying the
 * option's printed words rather than its letter. Used only when the letters are
 * missing, because a guide that gives both can disagree with itself and the
 * letters are what the printed paper is numbered by.
 */
function entryAnswers(correct: unknown, text: unknown): string[] {
  if (Array.isArray(correct)) return correct.map(String).filter(Boolean);
  if (correct && typeof correct === 'object') {
    return Object.entries(correct as Record<string, unknown>).map(([left, right]) =>
      pairingOption(left, String(right)),
    );
  }
  if (typeof correct === 'string' && correct.trim()) return [correct];
  if (Array.isArray(text)) return text.map(String).filter(Boolean);
  if (typeof text === 'string' && text.trim()) return [text];
  return [];
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
/** A bare option letter — "b", "A" — the positional form a printed key prints. */
function isOptionLetter(s: string): boolean {
  return /^[a-z]$/i.test(s);
}

export function resolveAnswer(answer: string, options: readonly string[]): string | null {
  const trimmed = answer.trim();
  if (!trimmed) return null;

  if (isOptionLetter(trimmed)) {
    const index = trimmed.toLowerCase().charCodeAt(0) - 97;
    return options[index] ?? null;
  }

  const exact = options.find((o) => o === trimmed);
  if (exact) return exact;
  const loose = options.find((o) => normalize(o) === normalize(trimmed));
  return loose ?? null;
}

/**
 * A WRITTEN question, as the guide matcher counts one: prose typed into a
 * `text`/`textarea` field. An entry landing on one seeds a MODEL ANSWER
 * (`answerKey: []`, prose the assessor marks against) rather than a key —
 * the target question decides the seed's kind, never the guide.
 *
 * Verdict-flagged fields are out for the same reason the Answer Key step
 * leaves them out: a written verdict is the assessor's own prose, and a
 * marking guide for the marker's words is not a thing.
 */
function isWrittenQuestion(f: FormField): boolean {
  return (f.type === 'text' || f.type === 'textarea') && !f.assessorVerdict;
}

/**
 * Every answer is a bare option letter — "b", "A". On a written question that
 * is a POSITIONAL answer with no options to be positional against: the guide
 * and the document disagree about what kind of question this is, and the only
 * safe response is to say so. Turning "b" into a model answer would hand the
 * assessor a one-letter marking guide that means nothing.
 */
function allOptionLetters(answers: readonly string[]): boolean {
  return answers.length > 0 && answers.every((a) => isOptionLetter(a.trim()));
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

/*
  One entry landing on one written question, shared by both loops below. The
  TARGET already decided this entry seeds a model answer; letters here mean the
  guide thinks the question has options — a kind disagreement, reported rather
  than guessed at. `describe` is the caller's own name for the question
  (`Question 3 ("label…")` when matched by text, `Question 3 of "Section"` when
  by position), so each loop keeps the exact message its author reads.
*/
function matchWritten(
  entry: GuideEntry,
  field: FormField,
  problemSection: string,
  describe: string,
): { key: DraftAnswerKey } | { problem: GuideProblem } {
  if (allOptionLetters(entry.answers)) {
    return {
      problem: {
        section: problemSection,
        reason: `${describe} is a written question, but the guide answers it with option letter${entry.answers.length === 1 ? '' : 's'} ${entry.answers.map((a) => `"${a}"`).join(', ')}. That answer was not applied.`,
      },
    };
  }
  return {
    key: {
      fieldId: field.id,
      answerKey: [],
      modelAnswer: entry.answers.join('\n'),
      // Seeded, never attested — same rule as a key: a person still has
      // to say they checked it.
      source: 'guide_json',
    },
  };
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

  /*
    A SECTIONLESS GUIDE IS MATCHED BY TEXT, NEVER BY POSITION.

    Aligning one by order across a whole document is worse than the per-section
    alignment the count gate below already refuses: one extra field anywhere
    shifts every answer after it onto the wrong question, silently, on a record
    that says whether somebody may operate heavy machinery. An entry carrying
    its printed text can find its own question wherever it sits.

    An entry with neither a section nor text is reported, not guessed at.
  */
  const sectionless = entries.filter((e) => !e.section);
  if (sectionless.length > 0) {
    // Written questions belong in the text-match pool too: their labels are
    // exactly as findable as a choice question's, and a guide that quotes one
    // is carrying its model answer.
    const all = sections
      .flatMap((s) => s.fields)
      .map((f) => byId.get(f.id))
      .filter(
        (f): f is FormField =>
          !!f && !excluded.has(f.id) && ((f.options?.length ?? 0) > 0 || isWrittenQuestion(f)),
      );

    let count = 0;
    for (const entry of sectionless) {
      const found = questionForText(entry, all);
      if (typeof found === 'string') {
        problems.push({ section: 'This guide', reason: found });
        continue;
      }
      if ((found.options?.length ?? 0) === 0) {
        // A written match — `matchWritten` reports a kind disagreement or
        // seeds the model answer.
        const result = matchWritten(
          entry,
          found,
          'This guide',
          `Question ${entry.n} ("${short(found.label)}")`,
        );
        if ('problem' in result) {
          problems.push(result.problem);
          continue;
        }
        keys.push(result.key);
        count += 1;
        continue;
      }
      const resolved = entry.answers.map((a) => resolveAnswer(a, found.options ?? []));
      if (resolved.some((r) => r === null)) {
        const bad = entry.answers.filter((_, i) => resolved[i] === null);
        problems.push({
          section: 'This guide',
          reason: `Question ${entry.n} ("${short(found.label)}") names ${bad
            .map((u) => `"${short(u)}"`)
            .join(', ')}, which is not one of its ${(found.options ?? []).length} options. That answer was not applied.`,
        });
        continue;
      }
      keys.push({ fieldId: found.id, answerKey: resolved as string[], source: 'guide_json' });
      count += 1;
    }
    if (count > 0) seeded.push({ section: 'Matched by question text', count });
  }

  const bySection = new Map<string, GuideEntry[]>();
  for (const entry of entries) {
    if (!entry.section) continue;
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

    // Only questions — a section's headings are not numbered by a guide and
    // must not consume one of its positions.
    const inSection = section.fields
      .map((f) => byId.get(f.id))
      .filter((f): f is FormField => !!f && !excluded.has(f.id));
    const full = inSection.filter((f) => (f.options?.length ?? 0) > 0 || isWrittenQuestion(f));
    const choiceOnly = inSection.filter((f) => (f.options?.length ?? 0) > 0);

    /*
      THE COUNT GATE, IN TWO PASSES. The guide's numbers are aligned against a
      question list by ORDER, so a count that does not match means every entry
      after the first discrepancy lands on the wrong question — silently, and
      on a safety record.

      Pass 1 aligns against the FULL numbered list — choice AND written — which
      is how a mixed paper numbers itself: a guide for 15 questions of which 11
      are written carries 15 entries, and the old choice-only gate read that as
      "15 answers, 4 questions" and refused the lot. Pass 2 is the old gate
      verbatim: a shorter, all-choice guide (the repo's own track-dozer key)
      still aligns against the choice questions alone, exactly as it always
      has. Failing BOTH is the only refusal, and it reports both counts so the
      author can see which list the guide was written against.
    */
    const questions =
      full.length === group.length
        ? full
        : choiceOnly.length === group.length
          ? choiceOnly
          : null;

    if (!questions) {
      problems.push({
        section: name,
        reason: `The guide has ${group.length} answer${group.length === 1 ? '' : 's'} for "${section.label}", which has ${full.length} question${full.length === 1 ? '' : 's'} (${choiceOnly.length} with options). Answers are aligned by order, so none were applied — key this section by hand, or correct the question types first.`,
      });
      continue;
    }

    /*
      A DUPLICATED NUMBER DEFEATS THE COUNT GATE. Two entries both claiming
      question 4 still count-match a four-question section carrying entries
      1,2,4,4 — and positional seeding then keys question 4 twice (the later
      entry silently winning) while question 3 is never seeded at all. That is
      the same misalignment the gate exists to refuse, just folded so the
      counts agree, so it gets the same response: name the numbers, seed
      nothing for the section.
    */
    const dupes = [...new Set(group.map((e) => e.n).filter((n, i, ns) => ns.indexOf(n) !== i))];
    if (dupes.length > 0) {
      problems.push({
        section: name,
        reason: `The guide numbers ${dupes.length === 1 ? 'question' : 'questions'} ${dupes.join(', ')} more than once for "${section.label}". Answers are aligned by number, so none were applied — fix the duplicate${dupes.length === 1 ? '' : 's'} in the guide, or key this section by hand.`,
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
      /*
        THE TARGET DECIDES THE KIND. An entry landing on a written question is
        a model answer; on a choice question it resolves against the options
        exactly as before. A kind DISAGREEMENT — letters on a written question,
        prose no option matches — is a reported problem, never a guess, because
        both mean the guide and the document number their questions differently
        and every seed after the disagreement is suspect.
      */
      if (options.length === 0) {
        const result = matchWritten(
          entry,
          question,
          name,
          `Question ${entry.n} of "${section.label}"`,
        );
        if ('problem' in result) {
          problems.push(result.problem);
          continue;
        }
        keys.push(result.key);
        count += 1;
        continue;
      }
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
