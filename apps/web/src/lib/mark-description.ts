import { isChoiceField, isSelfAnswering, type FormField } from '@formai/shared';

/**
 * What mark a placed box will actually draw on the exported document.
 *
 * The review panel used to say "a ✓ in its box" for every choice field, which is
 * now wrong for exactly the fields that matter most: an auto-marked question gets
 * a RING around the answer chosen — green when it matches the answer key, red
 * when it does not — and an outcome cell gets a tick OR a cross depending on the
 * verdict. A reviewer confirming 229 boxes on the strength of that sentence would
 * be confirming them against the wrong picture of the result.
 *
 * Stated per field TYPE, because the type is what the exporter branches on. The
 * one thing this cannot know is whether a question will end up auto-marked: keys
 * are attached after publish, so at review time no field carries one. Rather than
 * guess, the choice-field text names both outcomes and what decides between them
 * — a reviewer who understands the rule is better served than one told a single
 * confident half-truth.
 */
export interface MarkDescription {
  /** What is drawn, as a fragment: "a ✓ in each selected option's box". */
  mark: string;
  /**
   * The condition or caveat a reviewer needs alongside it. Empty when the mark
   * is unconditional.
   */
  detail: string;
}

export function markDescription(field: Pick<FormField, 'type' | 'options' | 'printSelectedValue'>): MarkDescription {
  // Types whose false is a recorded finding, so BOTH states draw something.
  // The list is the exporter's — see `isSelfAnswering` — because this sentence
  // is a promise about what that file will print.
  if (isSelfAnswering(field.type)) {
    return {
      mark: 'a ✓ or a ✗',
      // Both directions are findings. Only never-assessed is blank, and saying
      // so is what stops someone reading a cross as "not filled in".
      detail:
        'Whichever the recorded verdict is. A question nobody assessed stays blank — that is the only empty case.',
    };
  }

  if (field.type === 'repeating_group') {
    return {
      mark: 'a mark in the answered column of each row',
      detail: 'Rows with no answer are left alone.',
    };
  }

  const perOption = isChoiceField(field.type) && !field.printSelectedValue && (field.options?.length ?? 0) > 0;
  if (perOption) {
    return {
      mark: "a ✓ in each selected option's box",
      // The correction. Naming the condition rather than the outcome, because
      // the outcome is not knowable until an answer key is attached.
      detail:
        'On a question that is auto-marked against an answer key, the answer chosen is ringed instead — green if it is correct, red if not. Only the answer given is marked, never the correct one.',
    };
  }

  if (isChoiceField(field.type)) {
    return { mark: 'the selected value, as text', detail: '' };
  }

  if (field.type === 'signature') {
    /*
      This said "nothing usable yet" and told reviewers to leave the box
      unplaced, because the exporter genuinely could not draw a signature: the
      value is a base64 PNG data URL and there was no image-embedding call
      anywhere in the PDF layer, so it fell through to the text path.

      `round-trip.ts` now embeds it, scaled to fit the box and centred, so the
      promise is keepable and the warning had to go with the same change — copy
      telling a reviewer to skip the box would leave the signature block empty
      on every certificate.

      The aspect-ratio note is not decoration. A reviewer drawing a short wide
      box gets a small signature centred in it rather than a stretched one, and
      knowing that in advance is what stops them redrawing it three times.
    */
    return {
      mark: 'the signature, scaled to fit',
      detail:
        'Drawn at its own proportions and centred, so a box much wider or taller than the signature leaves space around it rather than distorting it.',
    };
  }

  return { mark: 'the value, as text', detail: '' };
}

/** One sentence for a panel heading: "This box draws …". */
export function markSentence(field: Parameters<typeof markDescription>[0]): string {
  const { mark, detail } = markDescription(field);
  return [`This box draws ${mark}.`, detail].filter(Boolean).join(' ');
}
