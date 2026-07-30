/**
 * Pairing each question with the outcome box that records its verdict.
 *
 * A theory question and the tick/cross cell beside it are two separate fields —
 * deliberately, because the cell is a real printed cell an assessor can also
 * fill by hand, and folding it into the question would leave no way to override
 * a computed mark. What connects them is `outcomeTarget` on the question.
 *
 * That link used to be inferred AFTER extraction by pairing every question with
 * the next `check_cross` in document order. Adjacency shifts: one question whose
 * outcome box the model missed re-pairs every question after it, and the result
 * still looks like a complete mapping. The authoring script guarded that by
 * refusing unless it found exactly 31 pairs — a whole-document tripwire that
 * says something is wrong without saying where.
 *
 * So the model now reports the reference it can actually read off the page
 * ("Q1", "BBM Q3", "7"), on the question and on its box, and this resolves those
 * into ids. A reference has to MATCH, so a missing box stays a gap rather than
 * becoming an off-by-one.
 */
import { isChoiceField, type FormField, type FormFieldType } from './form-field.js';

/** The bits of a field this resolver reads. Narrow so tests stay legible. */
export interface LinkableField {
  id: string;
  type: FormFieldType;
  questionRef?: string;
  options?: string[];
}

export interface OutcomeLink {
  /** The question field. */
  questionId: string;
  /** The `check_cross` field recording its verdict. */
  outcomeId: string;
  ref: string;
}

export interface OutcomeLinkResult {
  links: OutcomeLink[];
  /** Questions carrying a ref with no outcome box after them. */
  unlinkedQuestions: string[];
  /** Outcome boxes whose ref matched no question before them. */
  orphanOutcomes: string[];
}

/** References are compared with printed noise ignored, but never guessed at. */
function normalizeRef(ref: string): string {
  return ref.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function isQuestion(field: LinkableField): boolean {
  return isChoiceField(field.type) && (field.options?.length ?? 0) > 0;
}

/**
 * Resolve `questionRef` pairs into question → outcome links.
 *
 * Scans FORWARD from each question for the first `check_cross` carrying the same
 * reference, and stops at the next question that carries one. Forward-only
 * because the printed box always follows its question; stopping at the next
 * referenced question is what keeps a missing box from reaching past its own
 * question and claiming the next one's cell.
 *
 * The same reference legitimately repeats — this paper restarts numbering in
 * every section — so resolution is deliberately LOCAL. Two questions numbered
 * "7" each pair with the box in their own section, which whole-document matching
 * could not do.
 */
export function linkOutcomeTargets(fields: readonly LinkableField[]): OutcomeLinkResult {
  const links: OutcomeLink[] = [];
  const unlinkedQuestions: string[] = [];
  const claimed = new Set<string>();

  for (let i = 0; i < fields.length; i++) {
    const question = fields[i]!;
    if (!isQuestion(question) || !question.questionRef) continue;
    const ref = normalizeRef(question.questionRef);
    if (ref === '') continue;

    let found: LinkableField | undefined;
    for (let j = i + 1; j < fields.length; j++) {
      const next = fields[j]!;
      // The next referenced question ends this one's search window.
      if (isQuestion(next) && next.questionRef) break;
      if (next.type !== 'check_cross' || !next.questionRef) continue;
      if (normalizeRef(next.questionRef) === ref && !claimed.has(next.id)) {
        found = next;
        break;
      }
    }

    if (!found) {
      unlinkedQuestions.push(question.id);
      continue;
    }
    claimed.add(found.id);
    links.push({ questionId: question.id, outcomeId: found.id, ref: question.questionRef });
  }

  const orphanOutcomes = fields
    .filter((f) => f.type === 'check_cross' && f.questionRef && !claimed.has(f.id))
    .map((f) => f.id);

  return { links, unlinkedQuestions, orphanOutcomes };
}

/**
 * Apply resolved links as `outcomeTarget` on each question.
 *
 * Never clears an existing target. A reviewer who repointed a cell by hand has
 * made a decision, and a re-run of the resolver should not quietly undo it.
 */
export function applyOutcomeLinks<T extends FormField>(
  fields: readonly T[],
  links: readonly OutcomeLink[],
): T[] {
  if (links.length === 0) return fields as T[];
  const byQuestion = new Map(links.map((l) => [l.questionId, l.outcomeId]));

  return fields.map((field) => {
    const outcomeId = byQuestion.get(field.id);
    if (!outcomeId || field.outcomeTarget) return field;
    return { ...field, outcomeTarget: { fieldId: outcomeId } };
  });
}
