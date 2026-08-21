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

import { resolveStructure } from './builder-structure.js';
import {
  isSelfAnswering,
  linkOutcomeTargets,
  unplacedMarkDestinations,
  validateAnswerKeys,
  validateManifest,
  type AssessmentToolManifest,
  type BuilderStructure,
  type DraftAnswerKey,
  type ExtractionResult,
  type FieldGeometry,
  type OutcomeTarget,
  type FormField,
} from '@formai/shared';

/**
 * The printed references, keyed by field id, read back off the extraction the
 * draft keeps whole.
 *
 * `questionRef` lives on the EXTRACTED field, never on `FormField` — the same
 * split as `coverSection` — so the builder resolves links by carrying the refs
 * BESIDE the fields, exactly as the keys travel until publish merges them on.
 * Field ids survive `seedFields`, which is what makes the join safe. A revision
 * draft has no extraction and gets an empty map: its links fall through to the
 * author's own choices and the adjacency tier, as before.
 */
export function extractionQuestionRefs(
  extraction: Pick<ExtractionResult, 'fields'> | null | undefined,
): Map<string, string> {
  const refs = new Map<string, string>();
  for (const field of extraction?.fields ?? []) {
    if (field.questionRef) refs.set(field.id, field.questionRef);
  }
  return refs;
}

/**
 * The manifest a REVISION republishes: the seeded tool's manifest with the
 * builder's derivation overlaid.
 *
 * The seeded copy carries what the builder does not model — `profilePrefill`,
 * `prerequisiteChecks`, `fieldDefaults`, workflow customisations layered on
 * after creation — and a republish that sent only the derived manifest would
 * silently shed them (the republish schema names them for exactly this
 * moment). Derived keys win where both exist: parts, pathways and pointers
 * are what the author is here to edit. Undefined derived keys are stripped
 * first, so an absence in the derivation can never erase a seeded value.
 *
 * TWO EXCEPTIONS, when `fields` is given: `partCompletionMarks` and the
 * sign-off block. Publish DERIVES both from printed labels, so the plain
 * overlay re-guessed them on every revision — which was fine while the guess
 * was the only writer, and wrong the moment the workflow editor let an author
 * repoint them: a republish would silently clobber a configured mapping with
 * a fresh guess. So a seeded entry that still RESOLVES against the revision's
 * fields wins over the derivation, and one whose target vanished falls back
 * (or is dropped, for the pathway map nothing derives) rather than blocking
 * the republish on a ghost id.
 */
export function composeRevisionManifest(
  seeded: AssessmentToolManifest,
  derived: AssessmentToolManifest,
  fields?: readonly FormField[],
): AssessmentToolManifest {
  const overlay = Object.fromEntries(
    Object.entries(derived).filter(([, value]) => value !== undefined),
  );
  const merged = { ...seeded, ...overlay } as AssessmentToolManifest;
  if (!fields) return merged;
  const byId = new Map(fields.map((f) => [f.id, f]));

  const resolvedSeededMarks = (seeded.partCompletionMarks ?? []).filter((mark) => {
    const field = byId.get(mark.fieldId);
    return (
      field?.type === 'repeating_group' &&
      mark.rowIndex < (field.fixedRows?.length ?? 0) &&
      (field.columns ?? []).some((c) => c.key === mark.columnKey) &&
      merged.parts.some((p) => p.key === mark.partKey)
    );
  });
  if (resolvedSeededMarks.length > 0) merged.partCompletionMarks = resolvedSeededMarks;

  if (seeded.signOff) {
    // Per-key graft: each seeded pointer wins where its field still exists,
    // so one renamed box costs one pointer, never the whole block.
    const next = { ...(merged.signOff ?? {}) };
    const pointerKeys = ['assessorNameFieldId', 'assessorSignatureFieldId', 'signedDateFieldId'] as const;
    for (const key of pointerKeys) {
      const id = seeded.signOff[key];
      if (id && byId.has(id)) next[key] = id;
    }
    const markKeys = [
      'overallSatisfactory',
      'overallNotSatisfactory',
      'moreCoachingRequiredYes',
      'moreCoachingRequiredNo',
    ] as const;
    for (const key of markKeys) {
      const mark = seeded.signOff[key];
      if (mark && byId.has(mark.fieldId)) next[key] = mark;
    }
    merged.signOff = next;
  }

  if (seeded.pathwayMarks) {
    const kept = Object.fromEntries(
      Object.entries(seeded.pathwayMarks).filter(([, mark]) => mark && byId.has(mark.fieldId)),
    ) as AssessmentToolManifest['pathwayMarks'];
    if (kept && Object.keys(kept).length > 0) merged.pathwayMarks = kept;
    else delete merged.pathwayMarks;
  }

  // The parts' verdict pairs, per part: a seeded mark whose box still exists
  // beats the fresh label-guess, exactly like the sign-off block above.
  merged.parts = merged.parts.map((p) => {
    const seededPart = seeded.parts.find((sp) => sp.key === p.key);
    if (!seededPart) return p;
    const keep = (mark: AssessmentToolManifest['parts'][number]['outcomeSatisfactory']) =>
      mark && byId.has(mark.fieldId) ? mark : undefined;
    const yes = keep(seededPart.outcomeSatisfactory);
    const no = keep(seededPart.outcomeNotSatisfactory);
    return {
      ...p,
      ...(yes ? { outcomeSatisfactory: yes } : {}),
      ...(no ? { outcomeNotSatisfactory: no } : {}),
    };
  });

  return merged;
}

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
  /**
   * Printed references by field id, from `extractionQuestionRefs`. The refs are
   * merged onto the fields' linkable view only — never written to the fields —
   * because `questionRef` is extraction metadata, not part of the published
   * shape. Absent (a revision draft, a caller predating the wiring), every
   * question falls through to the author's own choice and the adjacency tier.
   */
  refs?: ReadonlyMap<string, string>,
): { fields: FormField[]; unlinked: string[]; inferred: string[] } {
  const linkable = refs?.size
    ? fields.map((f) => {
        const ref = refs.get(f.id);
        return ref ? { ...f, questionRef: ref } : f;
      })
    : fields;
  const linked = linkOutcomeTargets(linkable);
  const targetByQuestion = new Map(linked.links.map((l) => [l.questionId, l.outcomeId]));
  const keyById = new Map(keys.map((k) => [k.fieldId, k]));
  const unlinked: string[] = [];
  const inferred: string[] = [];

  /*
    THE PRINTED-REFERENCE ROUTE FIRES ONLY WHEN THE CALLER PASSES THE REFS, and
    that is why a third tier exists.

    `linkOutcomeTargets` pairs a question with its ✓/✗ box by the `questionRef`
    both carry. That reference lives on the EXTRACTED field — `FormField` has no
    such property — so the builder resolves it by handing this function the refs
    read back off the extraction the draft keeps whole (`extractionQuestionRefs`),
    mirroring how the import-review screen keeps the reference in its own
    side-table. A box the extraction missed, an author-added field, or a revision
    draft (which has no extraction) carries no ref and falls through.

    Before the refs were wired through, "Automatic — from the printed reference"
    resolved nothing, on every question, and a thirty-question paper failed
    publish thirty times over with "no outcome box to write its mark into". The
    only way through was to pick all thirty by hand from a list of thirty
    near-identical box names — thirty chances to put a candidate's mark against
    a different question, silently, on a certificate.

    ADJACENCY IS A GUESS AND IS REPORTED AS ONE. `outcome-links.ts` is explicit
    about why it is not the primary rule: one question whose box the model
    missed re-pairs every question after it, and the result still looks like a
    complete mapping. So it runs last, it takes only the IMMEDIATELY next field
    (never scanning forward, which is what would let a gap reach across into the
    next question's cell), and every link it makes is returned in `inferred` for
    the publish step to show. An author who disagrees overrides it with the
    picker, and their choice wins outright.
  */
  const adjacentOutcome = (index: number): string | undefined => {
    const next = fields[index + 1];
    return next && isSelfAnswering(next.type) ? next.id : undefined;
  };

  const next = fields.map((field, index) => {
    const key = keyById.get(field.id);
    if (!key || key.answerKey.length === 0) return field;

    // An existing outcomeTarget on the field wins: it may have been authored
    // explicitly, and a resolved link should not overwrite a decision.
    let target: OutcomeTarget | string | undefined = field.outcomeTarget ?? targetByQuestion.get(field.id);
    if (!target) {
      const adjacent = adjacentOutcome(index);
      if (adjacent) {
        target = adjacent;
        inferred.push(field.id);
      }
    }
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

  return { fields: next, unlinked, inferred };
}

export interface PublishCheck {
  /** Everything wrong, from the SHARED validators. Empty means publishable. */
  problems: string[];
  /** Keyed questions with no outcome box to write their mark into. */
  unlinked: string[];
  /**
   * Questions whose outcome box was inferred from DOCUMENT ORDER rather than
   * chosen or read off a printed reference.
   *
   * Not a problem — it is right on every paper that prints a question and then
   * its cell — but never silent either. Adjacency shifts: one question whose
   * box the model missed re-pairs every question after it, and the result still
   * looks like a complete mapping. The count is what tells an author there is
   * something to spot-check.
   */
  inferred: string[];
  /**
   * Auto-mark destinations with no drawable box — the ✓/✗ cells, verdict
   * pairs and sign-off boxes whose marks would compute and print NOWHERE.
   * Warnings, never gates: the tool still assesses and certifies correctly,
   * only the printed record is incomplete, and the exporter's own safe
   * failure (silence) is exactly why it has to be said here.
   */
  unplaced: string[];
  /**
   * Fields whose boxes were CARRIED across a PDF replacement and never
   * re-confirmed. Warnings, never gates (R8): the field simply prints
   * nowhere until placed, and the silence has to be said here because the
   * exporter's safe failure is exactly that silence.
   */
  carried: string[];
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
  /**
   * The author's arrangement, whose ORDER is the published document's order.
   *
   * THE STRUCTURE EDITOR DID NOT REACH THE PUBLISHED FORM. Step 2 is the only
   * place in the product where somebody sees the whole shape of the form and
   * moves it — and publish wrote the draft's flat field list, which is
   * extraction order. Every section reorder, every field moved between
   * sections, every renamed heading was visible in the preview beside the
   * editor and absent from the thing a candidate filled in.
   *
   * `ResolvedStructure.fields` has been documented as "the publishable field
   * list, in the author's order" since it was written; nothing published it.
   *
   * Optional so a caller with no arrangement (and every existing test) keeps
   * the flat list.
   */
  structure?: BuilderStructure,
  /** The revision's carried-but-unconfirmed stash, when there is one. */
  carriedGeometry?: Record<string, FieldGeometry>,
  /** Printed references by field id (`extractionQuestionRefs`), for the link tier. */
  refs?: ReadonlyMap<string, string>,
): PublishCheck {
  const arranged = structure && structure.length > 0 ? resolveStructure(structure, fields) : null;
  const ordered = arranged ? arranged.fields : fields;
  const resolved = resolvePublishFields(ordered, keys, refs);

  const problems: string[] = [];

  /*
    A FIELD THE ARRANGEMENT NEVER PLACED IS REFUSED, not dropped.

    `resolveStructure` returns only what the sections contain, so publishing it
    silently deletes anything sitting in no section. Step 2 already warns that
    those "would not be published" — this is the half that makes the warning
    true without making it destructive, because a field that vanishes is one
    nobody will fill in and nobody will notice is missing.
  */
  for (const id of arranged?.orphanIds ?? []) {
    const label = fields.find((f) => f.id === id)?.label ?? id;
    problems.push(
      `"${label}" sits in no section, so it would not be published. Drag it into one in Generate, or delete it.`,
    );
  }
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

  const carried = Object.keys(carriedGeometry ?? {}).map(
    (id) => fields.find((f) => f.id === id)?.label ?? id,
  );

  return {
    problems,
    unlinked: resolved.unlinked,
    inferred: resolved.inferred,
    unplaced: manifest ? unplacedMarkDestinations(manifest, resolved.fields) : [],
    carried,
    fields: resolved.fields,
  };
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
