import { isChoiceField, type FormField, type FormFieldType } from '@formai/shared';

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

/** Types whose false is a recorded finding, so BOTH states draw something. */
const SELF_ANSWERING: readonly FormFieldType[] = ['check_cross', 'boolean_yes_no'];

export function markDescription(field: Pick<FormField, 'type' | 'options' | 'printSelectedValue'>): MarkDescription {
  if (SELF_ANSWERING.includes(field.type)) {
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
    return { mark: 'the signature', detail: '' };
  }

  return { mark: 'the value, as text', detail: '' };
}

/** One sentence for a panel heading: "This box draws …". */
export function markSentence(field: Parameters<typeof markDescription>[0]): string {
  const { mark, detail } = markDescription(field);
  return [`This box draws ${mark}.`, detail].filter(Boolean).join(' ');
}
