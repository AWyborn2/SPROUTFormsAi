/**
 * Author the Track Dozer assessment tool against an IMPORTED template.
 *
 * Run from packages/db in the environment that can reach the database
 * (Replit), after the PDF has been imported and published:
 *
 *   pnpm --filter @formai/shared build
 *   cd packages/db
 *   DATABASE_URL=... node scripts/author-track-dozer-tool.mjs --key ../key.json          # dry run
 *   DATABASE_URL=... node scripts/author-track-dozer-tool.mjs --key ../key.json --write  # persist
 *
 * `--key` (or ANSWER_KEY_PATH) points at the answer key. It is a flag rather
 * than a fixed path so the key does not have to live in this repository — see
 * the note beside KEY_PATH. Optional: --template-id <uuid> when name matching
 * finds the wrong template.
 *
 * The cover page's boxes are found by label, and this document prints several
 * of each. Where more than one matches, the run says which and declares none —
 * settle it with --candidate-name <id>, --assessor-signature <id> or
 * --assessor-name <id>. Until one is declared the certificate exports with that
 * box BLANK, which on the assessor's signature means a certificate nobody
 * appears to have signed.
 *
 * DRY RUN BY DEFAULT. Everything here is heuristic — imported field ids and
 * labels come from AI extraction, so this script's job is to propose a
 * mapping, show its work, and refuse to write anything that does not survive
 * the same validators the API applies (validateManifest, validateAnswerKeys).
 * Read the dry-run report before --write.
 *
 * What it does:
 *  1. Locates the template and its current published version.
 *  2. Anchors each part to its PART heading (first match only — sub-headings
 *     repeat across parts, and page-group boundaries duplicate some headers).
 *  3. Maps answer-key letters onto each theory question's real options and
 *     writes answerKey + outcomeTarget onto the version's fields.
 *  4. Builds the six-part manifest (pathways, hours minima, duration columns).
 *  5. Attaches prerequisite/assessor competencies found by code.
 *  6. Upserts the assessment_tools row.
 *
 * Questions are paired with their outcome box by the link publish resolved from
 * the printed references, falling back to document adjacency only where no link
 * exists (`pairQuestionsWithOutcomes`). The pairs are then consumed IN ORDER
 * against the key's three sections, because the key identifies its answers by
 * section and number and nothing on a published field carries that number. If
 * the pair count does not equal the key's answer count EXACTLY, nothing is
 * written — an off-by-one would silently shift every subsequent answer onto the
 * wrong question, which on a safety assessment is worse than not running.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { pairQuestionsWithOutcomes, validateAnswerKeys, validateManifest } from '@formai/shared';

const WRITE = process.argv.includes('--write');
const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};
const TEMPLATE_ID = flag('--template-id');

/*
  WHERE THE ANSWER KEY COMES FROM.

  It used to be read from a fixed path inside the repository, which is why a
  complete answer key to a safety-critical assessment was committed. `--key`
  takes it from anywhere — a path outside the checkout, a mounted secret, a file
  an operator drops next to the script and deletes afterwards — so the copy in
  the repo can be removed.

  The in-repo path stays as the fallback ONLY while that copy still exists, so
  this keeps working for whoever runs it before the file moves. Once the file is
  gone the fallback simply reports where to put one. Note that removing it from
  the working tree does not remove it from git HISTORY: anyone with repository
  access can still recover it, so treat those answers as disclosed and reissue
  them if that matters.

  Confidentiality at RUNTIME is already handled elsewhere — GET /forms and
  GET /forms/:id gate on forms.view, so a candidate cannot read a key through
  the API. This flag is about not shipping one in the source tree.
*/
const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEY_PATH = join(here, '..', '..', '..', 'docs', 'assessment-tools', 'track-dozer.answer-key.json');
const KEY_PATH = flag('--key') ?? process.env.ANSWER_KEY_PATH ?? DEFAULT_KEY_PATH;

let KEY;
try {
  KEY = JSON.parse(readFileSync(KEY_PATH, 'utf-8'));
} catch (err) {
  console.error(
    `Could not read an answer key at ${KEY_PATH}\n` +
      `  ${err instanceof Error ? err.message : String(err)}\n\n` +
      `Point the script at one:\n` +
      `  node scripts/author-track-dozer-tool.mjs --key /path/to/answer-key.json\n` +
      `or set ANSWER_KEY_PATH. The key is deliberately not kept in this repository.`,
  );
  process.exit(1);
}

/*
  Shape-check before anything else. A key that parses but has no sections would
  otherwise reach the pairing logic and report "0 pairs expected", which reads
  like a document problem rather than a malformed key.
*/
for (const name of ['general', 'bbmMining', 'rawMaterials']) {
  const section = KEY?.sections?.[name];
  if (!Array.isArray(section?.questions)) {
    console.error(`Answer key at ${KEY_PATH} has no "${name}" section with a questions array.`);
    process.exit(1);
  }
}
console.log(`Answer key: ${KEY_PATH}`);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL);

const problems = [];
const warnings = [];
const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();





/**
 * Map an answer letter onto a question's actual option values.
 * Prefers a literal "b) ..." prefix match; falls back to position (a=0, b=1).
 * boolean_yes_no has no options — a=true, b=false, matching the printed order.
 */
function mapLetter(letter, field) {
  if (field.type === 'boolean_yes_no') {
    if (letter === 'a') return 'true';
    if (letter === 'b') return 'false';
    return null;
  }
  const options = field.options ?? [];
  const prefixed = options.find((o) => new RegExp(`^\\s*${letter}\\s*[).:-]`, 'i').test(o));
  if (prefixed) return prefixed;
  const idx = letter.charCodeAt(0) - 97;
  return idx >= 0 && idx < options.length ? options[idx] : null;
}


async function main() {
  // ── locate template and version ─────────────────────────────────────────
  const templates = TEMPLATE_ID
    ? await sql`select * from form_templates where id = ${TEMPLATE_ID}`
    : await sql`select * from form_templates where name ilike ${'%track dozer%'} order by created_at desc`;
  if (templates.length === 0) {
    console.error('No Track Dozer template found. Import the PDF first, or pass --template-id.');
    process.exit(1);
  }
  if (templates.length > 1 && !TEMPLATE_ID) {
    // Re-imports leave the earlier template in place, so this is expected
    // rather than alarming — but authoring the wrong one would key a template
    // nobody uses, so list them and name the choice explicitly.
    warnings.push(
      `${templates.length} templates match "track dozer". Using the newest (${templates[0].id}). ` +
        `Others: ${templates.slice(1).map((t) => t.id).join(', ')}. Pass --template-id to pick a different one.`,
    );
  }
  const template = templates[0];
  if (!template.current_version_id) {
    console.error(`Template ${template.id} has no published version.`);
    process.exit(1);
  }
  const [version] = await sql`select * from form_template_versions where id = ${template.current_version_id}`;
  const fields = structuredClone(version.fields ?? []);
  console.log(`Template: ${template.name} (${template.id})`);
  console.log(`Version:  ${version.id} — ${fields.length} fields\n`);

  /* ── theory questions, in document order ─────────────────────────────────

     THE PUBLISHED LINK WINS.

     This used to pair every question with the check_cross that FOLLOWS it, on
     the reasoning that outcome labels vary too much to match ("Q1 Outcome",
     "BBM Q1 Outcome", "7b. Outcome") so adjacency was the only rule available.

     That reasoning is out of date. `questionRef` was shipped precisely to solve
     the label-variance problem: extraction records each question's PRINTED
     reference and the reference on its outcome box, and publish resolves the
     pairing from those (`linkOutcomeTargets`, applied in `reviewedToFields`).
     By the time this script runs, the fields it is reading already carry a
     resolved `outcomeTarget` — and overwriting it with a positional guess threw
     away the better answer.

     Adjacency survives as a FALLBACK for a question publish could not link,
     because a document with no printed references still has to be authorable.
     It is reported per question, so an operator can see which pairings were
     read off the page and which were inferred from order.
  */
  // The rule lives in @formai/shared beside the resolver whose output it reads,
  // where it is unit tested. This script had no tests and writes answer keys
  // onto a safety record; a pairing rule is not the place for an untested copy.
  const { pairs: paired, unpaired, fromLink, fromAdjacency } = pairQuestionsWithOutcomes(fields);
  console.log(
    `Question/outcome pairs found: ${paired.length} ` +
      `(${fromLink} from the published questionRef link, ${fromAdjacency} inferred from document order)`,
  );

  /*
    The key's three sections in printed order.

    The key identifies its answers by SECTION AND NUMBER — "general Q7" — and
    nothing on a published field carries that number: `questionRef` is consumed
    at publish to resolve `outcomeTarget` and is not kept on the FormField. So
    document order is the only thing linking a key entry to its question, and
    the entries are consumed by a cursor.

    THAT IS WHY THE COUNT CHECK IS ALL-OR-NOTHING, and why it stays that way.
    If the counts disagree, one missing pair shifts every later entry by one and
    the script would write question 8's answers onto question 7 — silently
    marking a candidate wrong on a question they answered correctly, and right
    on one they did not, on a safety record. Writing nothing is the only safe
    response to a misalignment we cannot localise.

    What DID change is the diagnosis: the failure now names the questions with
    no outcome box, so the operator can fix the import instead of being told
    only that two numbers differ.
  */
  const sectionOrder = [
    ['general', KEY.sections.general],
    ['bbmMining', KEY.sections.bbmMining],
    ['rawMaterials', KEY.sections.rawMaterials],
  ];
  const expected = sectionOrder.reduce((n, [, sec]) => n + sec.questions.length, 0);
  if (paired.length !== expected) {
    const missing = unpaired.map((f) => `  · ${f.id} "${(f.label ?? '').slice(0, 60)}"`);

    problems.push(
      `Found ${paired.length} question/outcome pairs but the key has ${expected} answers. ` +
        `Nothing written — a missing pair shifts every later answer onto the wrong ` +
        `question, and the mapping cannot be localised.` +
        (missing.length
          ? `\n  Choice fields with no outcome box:\n${missing.join('\n')}`
          : `\n  Every choice field paired, so the key and the document disagree on how many questions there are.`),
    );
  }

  const keyed = [];
  const skipped = [];
  const mandatoryFieldIds = [];
  if (paired.length === expected) {
    let cursor = 0;
    for (const [name, section] of sectionOrder) {
      for (const entry of section.questions) {
        const { question, outcome, how } = paired[cursor++];
        const mapped = entry.answers.map((l) => ({ letter: l, value: mapLetter(l, question) }));
        const bad = mapped.filter((m) => m.value === null);
        if (bad.length) {
          skipped.push(
            `${name} Q${entry.n} ("${question.label.slice(0, 50)}"): cannot map ${bad.map((m) => m.letter).join(', ')} onto ${JSON.stringify(question.options ?? [])}`,
          );
          continue;
        }
        question.answerKey = mapped.map((m) => m.value);
        /*
          Only WRITE a link this script derived. When the pairing came from the
          published `outcomeTarget` this is already the same id, and leaving it
          untouched keeps the field exactly as publish resolved it — the point
          of reading the link rather than recomputing it.
        */
        if (how === 'adjacency') question.outcomeTarget = { fieldId: outcome.id };
        if (section.mandatory) mandatoryFieldIds.push(question.id);
        keyed.push(
          `${name.padEnd(13)} Q${String(entry.n).padStart(2)} → ${question.id} ` +
            `[${entry.answers.join(',')}] ✓→ ${outcome.id} (${how === 'link' ? 'printed ref' : 'document order'})`,
        );
      }
    }
  }

  // ── part anchors ────────────────────────────────────────────────────────
  //
  // Matched on the PART heading only. Sub-headings ("4.1 Operational
  // Requirements") repeat across parts 2, 4 and 6, and the page-group boundary
  // duplicates some headers outright — so anchors take the FIRST match of each
  // part number and ignore the rest.
  // String comparison rather than a regex: `norm` has already collapsed the
  // label to "part 1 theory", so a prefix test is exact and carries no
  // escaping to get wrong. The trailing space is what stops "part 1" matching
  // "part 10".
  function partAnchor(n) {
    const wanted = `part ${n}`;
    const hit = fields.find((f) => {
      if (f.type !== 'section_header') return false;
      const label = norm(f.label);
      return label === wanted || label.startsWith(`${wanted} `);
    });
    if (!hit) problems.push(`No "PART ${n}" heading found to anchor part ${n}.`);
    else console.log(`  Part ${n} anchor → ${hit.id}  "${hit.label}"`);
    return hit;
  }
  const anchors = [1, 2, 3, 4, 5, 6].map(partAnchor);

  // ── logbook tables ──────────────────────────────────────────────────────
  //
  // The open-row table AFTER a logbook part's anchor and before the next.
  function logbookColumn(anchorIndex, label) {
    const from = anchors[anchorIndex];
    const to = anchors[anchorIndex + 1];
    if (!from) return undefined;
    const a = fields.indexOf(from);
    const b = to ? fields.indexOf(to) : fields.length;
    const table = fields.slice(a, b).find((f) => f.type === 'repeating_group' && !f.fixedRows?.length);
    if (!table) {
      problems.push(`${label}: no open-row table between its anchor and the next part.`);
      return undefined;
    }
    const col = (table.columns ?? []).find((c) => /duration|hours/.test(norm(c.label)));
    if (!col) {
      problems.push(`${label}: table "${table.label}" has no duration column. Columns: ${(table.columns ?? []).map((c) => c.key).join(', ')}`);
      return undefined;
    }
    console.log(`  ${label}: duration column "${col.key}" in ${table.id} ("${table.label}")`);
    return col.key;
  }
  const p3Duration = logbookColumn(2, 'Part 3 logbook');
  const p5Duration = logbookColumn(4, 'Part 5 logbook');

  // ── location stream ─────────────────────────────────────────────────────
  const streamField = fields.find(
    (f) => ['dropdown', 'radio'].includes(f.type) && /department|stream|location/.test(norm(f.label)),
  );
  if (streamField) console.log(`  location stream → ${streamField.id} ("${streamField.label}")`);
  else warnings.push(
    'No location-stream question exists on this document. Mining and Raw Materials content will ' +
      'NOT be gated per candidate until one is added in the builder (a dropdown "Department" with ' +
      'options Mining / Raw Materials) and visibleWhen conditions are set on those section headers.',
  );

  // ── manifest ────────────────────────────────────────────────────────────
  const all = ['experienced', 'new', 'rpl'];
  const spec = [
    { key: 'p1-theory', label: 'Part 1 — Theory', kind: 'theory', pathways: all },
    { key: 'p2-practical', label: 'Part 2 — Practical Demonstration', kind: 'practical', pathways: all },
    { key: 'p3-logbook', label: 'Part 3 — Direct Observation Log', kind: 'logbook', pathways: ['new'], minimumHours: 20, durationColumnKey: p3Duration },
    { key: 'p4-practical', label: 'Part 4 — Minimal Supervision Practical', kind: 'practical', pathways: ['new'] },
    { key: 'p5-logbook', label: 'Part 5 — Minimal Supervision Log', kind: 'logbook', pathways: ['new'], minimumHours: 50, durationColumnKey: p5Duration },
    { key: 'p6-practical', label: 'Part 6 — Final Practical Assessment', kind: 'practical', pathways: ['new'] },
  ];
  const parts = [];
  spec.forEach((sp, i) => {
    const anchor = anchors[i];
    if (!anchor) return;
    const part = { key: sp.key, ordinal: i + 1, label: sp.label, kind: sp.kind, pathways: sp.pathways, startFieldId: anchor.id };
    if (sp.minimumHours) part.minimumHours = sp.minimumHours;
    if (sp.durationColumnKey) part.durationColumnKey = sp.durationColumnKey;
    if (i === 0 && mandatoryFieldIds.length) part.mandatoryFieldIds = mandatoryFieldIds;
    parts.push(part);
  });

  /* ── the front page's certification block ───────────────────────────────

     The exporter and the renderer have been ready for this since the sign-off
     work: `assembleCaseValues` writes the assessor's name, signature and date
     plus the overall verdict, and `round-trip.ts` embeds the signature PNG. But
     every one of those writes is gated on the MANIFEST naming the field, and
     nothing named any — so a signed-off case exported with its front page
     blank, by design and with nothing to say why.

     Located by label, like every other anchor here, and every one is OPTIONAL:
     a pointer that resolves is declared, a pointer that does not is warned
     about and omitted. That asymmetry is deliberate. A missing pointer exports
     a blank box, which someone notices; a WRONG pointer prints an assessor's
     name or a satisfactory tick in the wrong place on a document certifying
     that a person is safe to operate a dozer.

     Note what `sigField` accepts. Extraction never emits a `signature` field —
     buttons, signatures and unknown surfaces are all classified as text inputs
     — so requiring that type would find nothing on any real import. The
     renderer keys on the VALUE being a data URL rather than on the type, which
     is what makes a text-typed box workable.
  */
  /*
     ONE match or none. Absence and ambiguity get the same answer, as everywhere
     else in this file that has to identify a field: two matches means we do not
     know which, and the cost of choosing wrong is an assessor's name or a
     satisfactory tick printed in the wrong place on a certificate.
  */
  /*
     AND A WAY TO SETTLE IT, which this had no answer for.

     Refusing on ambiguity is right. But with no override, a document printing
     "Name of Assessor" once per part AND once on the cover could never declare
     the cover one — so the certificate exported with no assessor signature on
     it, permanently. The refusal was a dead end rather than a prompt.

     An id supplied by the operator is not a guess: they have the document open
     and the warning lists the candidates. It is checked against the version, so
     a typo or an id left over from an older import stops the run rather than
     declaring nothing — which is the same failure with an extra step.
  */
  const findOne = (what, re, types, override) => {
    const flagName = `--${what.replace(/ /g, '-')}`;
    if (override) {
      const named = fields.find((f) => f.id === override);
      if (!named) {
        problems.push(
          `${flagName} names field "${override}", which is not in this version. A stale id declares ` +
            'nothing and reads exactly like success, so nothing is written.',
        );
        return undefined;
      }
      console.log(`  ${what} → ${named.id} "${(named.label ?? '').slice(0, 48)}" (declared by ${flagName})`);
      return named;
    }
    const hits = fields.filter((f) => types.includes(f.type) && re.test(norm(f.label)));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      warnings.push(
        `${what}: ${hits.length} fields match (${hits.map((f) => f.id).join(', ')}) — none declared, ` +
          `because printing it in the wrong one is worse than leaving the box blank. ` +
          `Pick one with ${flagName} <id>.`,
      );
    }
    return undefined;
  };

  const SCALARS = ['text', 'textarea', 'signature', 'date'];
  /*
     WHO THE CERTIFICATE IS FOR. The cover page's identity boxes belong to no
     part, so nobody can type into them through the fill surface — the export
     seeds this one from the case. Without it the document states a verdict, a
     date and an assessor for an unnamed person.
  */
  const candidateNameField = findOne(
    'candidate name',
    /candidate.*name|name.*candidate/,
    SCALARS,
    flag('--candidate-name'),
  );
  const sigField = findOne(
    'assessor signature',
    /assessor.*signature|signature.*assessor/,
    SCALARS,
    flag('--assessor-signature'),
  );
  const assessorNameField = findOne(
    'assessor name',
    /name of assessor|assessor.*name|assessor.*print/,
    SCALARS,
    flag('--assessor-name'),
  );
  /*
     Anchored to the assessor block rather than to "date" alone, because this
     document prints a date beside almost everything — the candidate
     declaration, every logbook row, the cover page.

     \b matters more than it looks: without it "date" matches inside
     "CANDIdate Signature", which made that field a candidate for the assessor's
     sign-off date. The ambiguity guard caught it, but a document with only that
     one match would have declared it and printed the assessment date into the
     candidate's signature box.
  */
  const signedDateField = findOne(
    'assessor sign-off date',
    /(assessor|assessment)[^]*\bdate\b|\bdate\b[^]*(assessor|assessment|sign)/,
    ['date', 'text'],
  );

  /*
     The verdict marks. Each carries the LITERAL value to write, never a
     boolean the exporter interprets: a `check_cross` renders `false` as a
     CROSS, which on this document means "checked and failed", so "more
     coaching required: No" has to be a TICK on the No box rather than a false
     on a single box. That is why the pair is two separate marks.
  */
  const MARKS = ['check_cross', 'checkbox', 'boolean_yes_no'];
  const markField = (what, re) => findOne(what, re, MARKS);

  const overallField = markField('overall satisfactory', /competent|satisfactor/);
  const coachYesField = markField('more coaching — Yes', /coaching.*yes|further.*training.*yes/);
  const coachNoField = markField('more coaching — No', /coaching.*no|further.*training.*no/);

  const signOff = {};
  if (sigField) signOff.assessorSignatureFieldId = sigField.id;
  if (assessorNameField) signOff.assessorNameFieldId = assessorNameField.id;
  if (signedDateField) signOff.signedDateFieldId = signedDateField.id;
  if (overallField) signOff.overallSatisfactory = { fieldId: overallField.id, value: true };
  /*
     Both coaching boxes or neither — validateManifest rejects half a pair,
     because one box alone cannot express the answer it is missing and the
     front page prints both.
  */
  if (coachYesField && coachNoField) {
    signOff.moreCoachingRequiredYes = { fieldId: coachYesField.id, value: true };
    signOff.moreCoachingRequiredNo = { fieldId: coachNoField.id, value: true };
  }

  const declared = Object.keys(signOff);
  if (declared.length) {
    console.log(`\nFront-page certification block: ${declared.length} pointer(s) resolved`);
    for (const [what, f] of [
      ['candidate name', candidateNameField],
      ['assessor signature', sigField],
      ['assessor name', assessorNameField],
      ['signed date', signedDateField],
      ['overall satisfactory', overallField],
      ['more coaching — Yes', coachYesField],
      ['more coaching — No', coachNoField],
    ]) {
      console.log(
        f ? `  ${what.padEnd(22)} → ${f.id} ("${(f.label ?? '').slice(0, 46)}")` : `  ${what.padEnd(22)} → NOT FOUND`,
      );
    }
  }

  if (!sigField) {
    warnings.push(
      'No assessor signature box found — the signature will not print on the exported certificate. ' +
        'Retype the field in review if the label differs, or place it and re-run.',
    );
  }
  // `a !== b !== c` chains left-to-right and compares a boolean against a
  // field — coerce both sides first.
  if (Boolean(coachYesField) !== Boolean(coachNoField)) {
    warnings.push(
      'Only one of the more-coaching Yes/No boxes was found, so neither is declared — ' +
        'the front page prints both and one alone cannot express the other answer.',
    );
  }

  /* ── each part's own assessor name and date boxes ───────────────────────

     The paper prints a sign-off line at the end of EVERY part, not only on the
     cover. `assembleCaseValues` already writes those from the ATTEMPT's columns
     — the assessor who marked that part, on the date they marked it, which is
     exactly why those live as columns rather than in `values`. Nothing named
     them, so every part's line printed empty.

     Scoped to the part's own field range rather than searched document-wide:
     the same label appears once per part, so a global search would find six and
     refuse them all as ambiguous. A part runs from its anchor to the next
     part's anchor — the same slice the manifest already uses.

     Fields already claimed by the front-page block are excluded. Two claimants
     on one field is a hard problem in `validateManifest` — correctly, since the
     merge order would let one silently overwrite the other — and the cover
     page's own boxes may sit inside a part's range.
  */
  const claimed = new Set(
    [
      signOff.assessorNameFieldId,
      signOff.signedDateFieldId,
      signOff.assessorSignatureFieldId,
      candidateNameField && candidateNameField.id,
    ].filter(Boolean),
  );

  const indexOfId = new Map(fields.map((f, i) => [f.id, i]));
  const partBoxReport = [];

  parts.forEach((part, i) => {
    const from = indexOfId.get(part.startFieldId);
    if (from === undefined) return;
    const nextAnchor = parts[i + 1] && parts[i + 1].startFieldId;
    const to = nextAnchor !== undefined ? (indexOfId.get(nextAnchor) ?? fields.length) : fields.length;
    const within = fields.slice(from, to).filter((f) => !claimed.has(f.id));

    const oneWithin = (what, re, types) => {
      const hits = within.filter((f) => types.includes(f.type) && re.test(norm(f.label)));
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        warnings.push(
          `${part.key} ${what}: ${hits.length} fields match (${hits.map((f) => f.id).join(', ')}) — ` +
            `none declared, because printing it in the wrong one is worse than a blank box.`,
        );
      }
      return undefined;
    };

    const nameField = oneWithin('assessor name', /assessor.*name|name.*assessor|assessor.*print/, SCALARS);
    const dateField = oneWithin('date', /\bdate\b/, ['date', 'text']);

    if (nameField) {
      part.assessorNameFieldId = nameField.id;
      claimed.add(nameField.id);
    }
    if (dateField) {
      part.signedDateFieldId = dateField.id;
      claimed.add(dateField.id);
    }
    partBoxReport.push(
      `  ${part.key.padEnd(14)} name → ${nameField ? nameField.id : '—'}   date → ${dateField ? dateField.id : '—'}`,
    );
  });

  if (partBoxReport.length) {
    console.log("\nPer-part assessor boxes (written from each attempt's own columns):");
    for (const line of partBoxReport) console.log(line);
  }

  const manifest = {
    parts,
    ...(streamField ? { locationStreamFieldId: streamField.id } : {}),
    ...(candidateNameField ? { candidateNameFieldId: candidateNameField.id } : {}),
    ...(declared.length ? { signOff } : {}),
  };
  console.log(`
Mandatory (must-be-100%) questions: ${mandatoryFieldIds.length} — ${mandatoryFieldIds.join(', ') || 'none'}`);

  // ── competencies by code ────────────────────────────────────────────────
  /*
     WHAT PASSING THIS AWARDS.

     `assessment_tools.awarded_competency_ids` is what the sign-off route
     iterates to put the candidate on the register — the thing the product
     exists to maintain. It was never written here, so the column kept its `[]`
     default, the grant loop ran zero times, and a signed-off case reached
     `competent` while the register stayed empty and said nothing about it.

     Supplied by code via `--awards`, because which competency this assessment
     confers is a training-authority decision rather than something derivable
     from the document. Passing none is legitimate — the assessment still runs
     and the certificate still prints — so it warns rather than refusing.
  */
  /*
     Q34666893 IS "ATO - Track Dozer" — the ticket this assessment awards.

     It was listed as a candidate PREREQUISITE, which is circular: a candidate
     would have needed the Track Dozer authorisation before being allowed to sit
     the assessment that grants it. Every case would have opened carrying a
     prerequisite warning that could never be satisfied except by having already
     passed.

     THE DOCUMENT ITSELF SETTLES THIS. Its ASSESSMENT SUMMARY block reads:

       Category of Assessment   Q34666893 ATO Track Dozer
       Prerequisites            Q50001782 Driver's Licence C OR higher class

     So Q34666893 is the CATEGORY — what this assessment is, and therefore what
     it awards — and the only prerequisite the paper names is the licence.

     The same page lists who may conduct it: "an Appointed Training Dept Trainer
     or Worsley Assessor who holds the following qualifications":

       Q34666893  ATO Track Dozer
       Q50071833  Worsley Assessor Skill Set
       Q50073293  Authority to Assess Mobile Equipment

     which is why Q34666893 stays on the ASSESSOR list too. That is not
     circular and is the point: whoever signs off a Track Dozer assessment
     should hold the Track Dozer ticket themselves.

     Q50073293 is absent from the BisTrainer training matrix because that report
     records what PEOPLE hold, and an assessor authority nobody in it holds has
     no column. `pick` warns when a code is not recorded in the org; assessor
     eligibility warns and never blocks, so a missing one is visible without
     stopping an assessment.
  */
  /*
     THE ASSESSOR RULE IS CONDITIONAL, AND IT IS NOW MODELLED AS ONE.

     The paper names three assessor qualifications, but they are not three
     things one person holds. Per the training authority:

       Q50071833  Worsley Assessor Skill Set          → MINE assessments,
                                                        valid only if the
                                                        assessor ALSO holds the
                                                        category (Q34666893)
       Q50073293  Authority to Assess Mobile Equip.   → RAW MATERIALS

     So the real rule is `Q34666893 AND (Q50071833 OR Q50073293)`, with the
     branch chosen by the assessment's location stream.

     `assessorCompetencyIds` is a pure AND and cannot say that: listing all
     three warns on EVERY case, telling a mine assessor they lack the
     raw-materials authority and vice versa. A warning that always fires is one
     people learn to scroll past, and these are recorded on the case for an
     auditor to read. Listing one silently accepts an assessor authorised for
     the other site, which is the failure that actually matters.

     `assessorStreamCompetencyIds` carries the location-specific half. The
     always-required category stays in `assessorCompetencyIds`, so "valid only
     if the assessor also holds the category" falls out of the two being ANDed
     rather than needing to be said twice.

     This document prints no location-stream question, so `locationStream` is
     whatever the person opening the case selects — the new-case form offers
     these stream names, and a case left blank says so in its warnings rather
     than passing a check it did not make.
  */
  const AWARDED_DEFAULT = 'Q34666893';
  const awardsCode = flag('--awards') ?? AWARDED_DEFAULT;
  const codes = {
    candidate: ['Q50001782'],
    assessor: ['Q34666893'],
    awarded: [awardsCode],
  };
  /*
     Location stream → the authority that covers assessing there.

     "Mining", NOT "Mine". These keys are matched against the case's
     `location_stream`, which is ONE free-text value this system already has a
     vocabulary for: the document's own section headings are "BBM Mining Only"
     and "Raw Materials Operators Only", the Department dropdown this script
     asks for above is spelled "Mining / Raw Materials", and the same value is
     fed back as the ANSWER to that question when a part is filled.

     Keying this "Mine" — as it was first written, in this file, three hundred
     lines below its own instruction to create "options Mining / Raw Materials" —
     meant a case recording "Mining" matched nothing. The resolver then required
     the category alone, and an assessor holding only the raw-materials
     authority signed off a mining assessment. The resolver now flags an
     unrecognised stream rather than passing it, so that particular mistake is
     loud instead of silent; the names still have to agree.
  */
  const STREAM_CODES = {
    Mining: 'Q50071833',
    'Raw Materials': 'Q50073293',
  };
  const rows = await sql`
    select id, code, valid_for_months from competencies where org_id = ${template.org_id}`;
  const byCode = new Map(rows.map((r) => [r.code, r.id]));
  const pick = (list, who) =>
    list.flatMap((c) => {
      if (byCode.has(c)) return [byCode.get(c)];
      warnings.push(`${who} competency ${c} not recorded in this org — prerequisite warning will not fire for it.`);
      return [];
    });
  const candidatePrereqs = pick(codes.candidate, 'Candidate');
  const assessorComps = pick(codes.assessor, 'Assessor');

  const assessorStreams = {};
  for (const [stream, code] of Object.entries(STREAM_CODES)) {
    const id = byCode.get(code);
    if (id) {
      assessorStreams[stream] = [id];
    } else {
      /*
        The stream is deliberately OMITTED rather than recorded with an empty
        list. An empty list is a positive claim that this location needs nothing
        extra, and a case there would then report a complete check. Leaving the
        key out makes the stream unrecognised instead, which the resolver flags
        on every case — so the gap follows the assessments rather than living
        only in this script's console output.
      */
      warnings.push(
        `Assessor authority ${code} (${stream}) is not recorded in this org, so cases in the ` +
          `"${stream}" stream will each carry a warning that the location-specific half of the ` +
          'assessor check could not be made. Create the competency with that code and re-run: ' +
          'the tool row is upserted, so re-running is safe.',
      );
    }
  }
  if (Object.keys(assessorStreams).length > 0) {
    console.log(
      `\nAssessor rule: ${codes.assessor.join(', ')} always, plus ` +
        Object.entries(STREAM_CODES)
          .filter(([s]) => assessorStreams[s])
          .map(([s, c]) => `${c} in ${s}`)
          .join(' / '),
    );
  }
  const awardedComps = pick(codes.awarded, 'Awarded');
  if (awardedComps.length === 0) {
    warnings.push(
      `Awarded competency ${awardsCode} is not recorded in this org, so passing this assessment ` +
        'will grant NOTHING. The case still reaches competent and the certificate still prints — ' +
        'only the register stays empty. Create the competency with that code, then re-run: the ' +
        'grant is an upsert, so re-running is safe.',
    );
  } else {
    console.log(`\nPassing this assessment awards: ${awardsCode} (ATO - Track Dozer)`);

    /*
      ATO - Track Dozer IS a three-year ticket. A competency with no validity
      never expires, which is the right default for one nobody has stated a
      period for — but it is the wrong answer for this one specifically, and
      the failure is silent: the grant lands, the register looks healthy, and
      nothing lapses in three years' time.
    */
    const awarded = rows.find((r) => r.code === awardsCode);
    if (awarded && awarded.valid_for_months == null) {
      warnings.push(
        `${awardsCode} has no validity period, so grants of it will never expire. The document ` +
          'states three years. Set it on Enterprise → Competencies (or PATCH /competencies/' +
          `${awarded.id} with {"validForMonths": 36}). Expiry counts from each grant date, so ` +
          'setting it later still dates existing tickets correctly.',
      );
    }
  }

  // ── validate exactly as the API would ───────────────────────────────────
  problems.push(...validateManifest(manifest, fields));
  problems.push(...validateAnswerKeys(fields));

  /*
     A PRINTED VERDICT BOX THAT NO QUESTION CLAIMS.

     The count check earlier compares the answer key against the questions this
     script could PAIR — and a question the extractor did not type as a choice
     field is missing from both sides, so the counts agree and the run looks
     clean. That is exactly what happens to the two matching questions ("Match
     the statement with the appropriate signage", "Match the correct response
     with the horn Signals"): they extract as free-response text, `isQuestion`
     is false for them, and they appear in neither `pairs` nor `unpaired`.

     The paper still prints a tick/cross box beside each. So the detectable
     signal is the box: an outcome cell no question claims is a verdict the
     document expects and nothing will ever write, and the theory percentage is
     computed without that question entirely.

     Reported on EVERY run rather than only on the failure path, because a clean
     run is precisely when nobody goes looking.
  */
  const claimedOutcomes = new Set(paired.map((p) => p.outcome.id));
  const orphanOutcomes = fields.filter(
    (f) => f.type === 'check_cross' && !claimedOutcomes.has(f.id),
  );
  if (orphanOutcomes.length) {
    warnings.push(
      `${orphanOutcomes.length} printed outcome box(es) belong to no keyed question, so those ` +
        'questions are NOT auto-marked and the theory percentage is computed without them: ' +
        orphanOutcomes.map((f) => `${f.id} "${(f.label ?? '').slice(0, 40)}"`).join(', ') +
        '. A matching question is the usual cause — it extracts as free-response text. Retype it ' +
        'as a checkbox group whose options are the PAIRINGS (buildMatchingQuestion in ' +
        '@formai/shared builds them) and add it to the key.',
    );
  }

  // ── report ──────────────────────────────────────────────────────────────
  // `expected` rather than a hardcoded 31: the key file is the authority on how
  // many questions there are, and a literal here would keep reading "29/31"
  // after a key legitimately changed size.
  console.log(`\nAnswer keys applied: ${keyed.length}/${expected}`);
  for (const k of keyed) console.log(`  ${k}`);
  if (skipped.length) {
    console.log(`\nSKIPPED (not auto-marked until fixed): ${skipped.length}`);
    for (const s of skipped) console.log(`  ! ${s}`);
  }
  if (warnings.length) {
    console.log('\nWARNINGS:');
    for (const w of warnings) console.log(`  ~ ${w}`);
  }
  if (problems.length) {
    console.log('\nPROBLEMS (blocking — nothing will be written):');
    for (const p of problems) console.log(`  ✗ ${p}`);
    process.exit(2);
  }

  if (!WRITE) {
    console.log('\nDry run complete. Re-run with --write to persist.');
    return;
  }

  // ── persist ─────────────────────────────────────────────────────────────
  await sql`update form_template_versions set fields = ${sql.json(fields)} where id = ${version.id}`;
  await sql`
    insert into assessment_tools (org_id, template_id, name, manifest, candidate_prerequisite_ids, assessor_competency_ids, assessor_stream_competency_ids, awarded_competency_ids)
    values (${template.org_id}, ${template.id}, ${'Authorised to Operate Track Dozer'}, ${sql.json(manifest)}, ${sql.json(candidatePrereqs)}, ${sql.json(assessorComps)}, ${sql.json(assessorStreams)}, ${sql.json(awardedComps)})
    on conflict (template_id) do update
      set manifest = excluded.manifest,
          name = excluded.name,
          candidate_prerequisite_ids = excluded.candidate_prerequisite_ids,
          assessor_competency_ids = excluded.assessor_competency_ids,
          -- The location-specific half of the assessor rule: Worsley Assessor
          -- Skill Set for the mine, Authority to Assess Mobile Equipment for
          -- raw materials. A flat AND list cannot state either without warning
          -- on every case in the other stream.
          assessor_stream_competency_ids = excluded.assessor_stream_competency_ids,
          -- Omitted before, so the column kept its [] default and the sign-off
          -- route's grant loop ran zero times: a competent case that put nobody
          -- on the register.
          awarded_competency_ids = excluded.awarded_competency_ids
  `;
  const [tool] = await sql`select id from assessment_tools where template_id = ${template.id}`;
  console.log(`\nWritten. Tool id: ${tool.id}`);
  console.log('Answer keys are now on the published version — fill surfaces receive them STRIPPED (stripMarkingSecrets).');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
