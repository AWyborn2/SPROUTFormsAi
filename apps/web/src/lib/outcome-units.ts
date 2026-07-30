/**
 * A question and the outcome cell recording its verdict, as ONE thing review can
 * render. Pure module — no React, no session store.
 *
 * The two stay separate FIELDS, for the reasons `outcome-links.ts` sets out: the
 * cell is a real printed box an assessor can also fill by hand, so folding it
 * into the question would leave no way to override a computed mark. What was
 * wrong was the LIST — it showed them as two unrelated top-level rows, and on
 * this assessment paper the cell sits some thirty fields below the question it
 * grades. A reviewer placed a tick box without knowing whose verdict lands in
 * it, and a question whose box extraction missed looked like nothing at all.
 *
 * So the shape review reads is a unit, and the unit carries the pairing's
 * outcome. That second part is the load-bearing one: `linkOutcomeTargets`
 * already reports both gaps precisely, and until now nothing showed them to the
 * person who could still fix them. An unpaired question is a verdict that is
 * never drawn on the exported record — a form that looks complete and grades
 * nothing.
 *
 * The pairing itself is NOT reimplemented here. `linkOutcomeTargets` owns it,
 * including its refusal to guess at a reference that does not match.
 */
import { linkOutcomeTargets, type LinkableField } from '@formai/shared';

/** Where a top-level row stands on the question ↔ outcome-cell pairing. */
export type OutcomeLinkStatus = 'linked' | 'question-has-no-outcome' | 'outcome-has-no-question';

export interface OutcomeUnit<T extends LinkableField> {
  /** The top-level row: a question, an unpaired outcome cell, or any other field. */
  field: T;
  /** The cell this question's verdict is written into, rendered nested under it. */
  outcome?: T;
  /**
   * Absent when the pairing has nothing to say about this field — anything that
   * is neither a question nor an outcome cell, and either of those carrying no
   * printed reference. `linkOutcomeTargets` is deliberately silent in that last
   * case (no reference, no guess), and minting a fourth status for it would
   * flag every plain text field on the page as a gap, which is how a real gap
   * stops being noticed.
   */
  linkStatus?: OutcomeLinkStatus;
}

/**
 * Group `fields` into review units, in the reviewed order.
 *
 * A linked outcome cell appears ONLY inside its question's unit, never also as
 * an entry of its own. Listing it in both places would leave the reviewer two
 * rows to keep in sync for one printed box — the confusion this exists to
 * remove, not a safety net.
 *
 * Generic over the resolver's own narrow input rather than over `ReviewField`:
 * a unit is a grouping across exactly the properties the pairing reads, and
 * binding it to the review row shape would drag the session store into every
 * test of it.
 *
 * Pass the WHOLE reviewed list. Resolution is positional — forward from each
 * question, stopping at the next question that carries a reference — so a
 * filtered subset moves that window and can hand a cell to a question that
 * never owned it.
 */
export function outcomeUnits<T extends LinkableField>(fields: readonly T[]): OutcomeUnit<T>[] {
  const { links, unlinkedQuestions, orphanOutcomes } = linkOutcomeTargets(fields);

  const byId = new Map(fields.map((f) => [f.id, f]));
  const outcomeByQuestion = new Map(links.map((l) => [l.questionId, l.outcomeId]));
  const nested = new Set(links.map((l) => l.outcomeId));
  const unlinked = new Set(unlinkedQuestions);
  const orphans = new Set(orphanOutcomes);

  const units: OutcomeUnit<T>[] = [];
  for (const field of fields) {
    if (nested.has(field.id)) continue; // it belongs to its question's unit

    const outcomeId = outcomeByQuestion.get(field.id);
    if (outcomeId !== undefined) {
      // The resolver picked this id out of the array being iterated, so the
      // lookup cannot miss.
      units.push({ field, outcome: byId.get(outcomeId)!, linkStatus: 'linked' });
      continue;
    }
    if (unlinked.has(field.id)) {
      units.push({ field, linkStatus: 'question-has-no-outcome' });
      continue;
    }
    if (orphans.has(field.id)) {
      units.push({ field, linkStatus: 'outcome-has-no-question' });
      continue;
    }
    units.push({ field });
  }

  return units;
}
