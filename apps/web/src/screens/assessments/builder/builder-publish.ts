/**
 * Publishing a built assessment tool.
 *
 * WHAT THIS RETIRES. `packages/db/scripts/author-track-dozer-tool.mjs` does this
 * job today: it reads an answer key off disk, re-pairs every question with the
 * next `check_cross` in document order, derives outcome targets from that guess,
 * and upserts the tool row against a `DATABASE_URL`. It refuses to write unless
 * it finds exactly 31 question/outcome pairs and 6 part anchors, because its
 * alignment is positional and one missing pair shifts every later entry. None of
 * that is needed once the keys are attached to field IDS and the links come from
 * the printed references the model read.
 *
 * THE ORDER IS FORCED BY THE SERVER, and it is worth stating because it is not
 * the order the plan's KTD8 implies. `POST /assessment-tools` validates the
 * manifest against `template.currentVersionId` — a field only set when a version
 * PUBLISHES. So the sequence is:
 *
 *   1. resolve the fields (keys + outcome links onto the version's own fields)
 *   2. VALIDATE, here, before anything is written
 *   3. save the fields onto the draft version
 *   4. publish the version
 *   5. create the tool
 *
 * Validating at step 2 rather than letting step 5 refuse is the whole point: a
 * tool that fails validation AFTER its version published leaves a live form with
 * no tool attached, which is a worse state than either end of the operation.
 */

import {
  linkOutcomeTargets,
  validateAnswerKeys,
  validateManifest,
  type AssessmentToolManifest,
  type DraftAnswerKey,
  type FormField,
} from '@formai/shared';

/**
 * Put the draft's answer keys and the resolved outcome links onto the version's
 * fields.
 *
 * THE LINKS COME FROM `linkOutcomeTargets`, NOT FROM ADJACENCY. That function
 * pairs a question with its outcome box by the printed reference both carry —
 * the `questionRef` the extraction reads off the page. The authoring script
 * infers the same pairing from document order, and its own comment concedes the
 * guess; order is only ever right by accident on a document whose outcome cells
 * are not printed in the same run as their questions.
 *
 * A question whose key has nowhere to land is left UNKEYED rather than keyed
 * with a dangling target: `validateAnswerKeys` rejects a key with no outcome
 * target, and it is right to — a mark that computes and never reaches the page
 * reads on an evidence document as a question nobody answered.
 */
export function resolvePublishFields(
  fields: readonly FormField[],
  keys: readonly DraftAnswerKey[],
): { fields: FormField[]; unlinked: string[] } {
  const linked = linkOutcomeTargets(fields);
  const targetByQuestion = new Map(linked.links.map((l) => [l.questionId, l.outcomeId]));
  const keyById = new Map(keys.map((k) => [k.fieldId, k]));
  const unlinked: string[] = [];

  const next = fields.map((field) => {
    const key = keyById.get(field.id);
    if (!key || key.answerKey.length === 0) return field;

    // An existing outcomeTarget on the field wins: it may have been authored
    // explicitly, and a resolved link should not overwrite a decision.
    const target = field.outcomeTarget ?? targetByQuestion.get(field.id);
    if (!target) {
      unlinked.push(field.id);
      return field;
    }

    return {
      ...field,
      answerKey: [...key.answerKey],
      outcomeTarget: typeof target === 'string' ? { fieldId: target } : target,
    };
  });

  return { fields: next, unlinked };
}

export interface PublishCheck {
  /** Everything wrong, from the SHARED validators. Empty means publishable. */
  problems: string[];
  /** Keyed questions with no outcome box to write their mark into. */
  unlinked: string[];
  fields: FormField[];
}

/**
 * Everything that must be true before anything is written.
 *
 * Runs the SAME `validateManifest` and `validateAnswerKeys` the server runs, so
 * the builder cannot pass a tool the API will refuse — and cannot refuse one the
 * API would accept. Every problem is returned, not the first: an author who
 * fixes one and is handed the next has to re-run the gate once per mistake,
 * which is what the authoring script's all-or-nothing refusal feels like from
 * the outside.
 */
export function checkPublish(
  fields: readonly FormField[],
  keys: readonly DraftAnswerKey[],
  manifest: AssessmentToolManifest | null,
): PublishCheck {
  const resolved = resolvePublishFields(fields, keys);

  const problems: string[] = [];
  if (!manifest || manifest.parts.length === 0) {
    problems.push('This tool declares no parts. Every non-cover section becomes a part in Units & gating.');
  } else {
    problems.push(...validateManifest(manifest, resolved.fields));
  }
  problems.push(...validateAnswerKeys(resolved.fields));

  for (const id of resolved.unlinked) {
    const label = fields.find((f) => f.id === id)?.label ?? id;
    problems.push(
      `"${label}" has an answer key but no outcome box to write its mark into. Place a ✓/✗ box for it, or clear its key.`,
    );
  }

  return { problems, unlinked: resolved.unlinked, fields: resolved.fields };
}

/** What the publish summary reports back, once it has worked. */
export interface PublishSummary {
  parts: number;
  questionsKeyed: number;
  questionsVerified: number;
  boxesPlaced: number;
}

export function publishSummary(
  fields: readonly FormField[],
  keys: readonly DraftAnswerKey[],
  manifest: AssessmentToolManifest | null,
): PublishSummary {
  return {
    parts: manifest?.parts.length ?? 0,
    questionsKeyed: keys.filter((k) => k.answerKey.length > 0).length,
    // Verified is reported SEPARATELY from keyed, because an unverified key
    // still marks — the distinction is the attestation, not the behaviour.
    questionsVerified: keys.filter((k) => k.verifiedAt).length,
    boxesPlaced: fields.reduce((n, f) => n + (f.geometry?.segments.length ?? 0), 0),
  };
}
