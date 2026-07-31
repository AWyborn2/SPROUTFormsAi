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
  const manifest = { parts, ...(streamField ? { locationStreamFieldId: streamField.id } : {}) };
  console.log(`
Mandatory (must-be-100%) questions: ${mandatoryFieldIds.length} — ${mandatoryFieldIds.join(', ') || 'none'}`);

  // ── competencies by code ────────────────────────────────────────────────
  const codes = { candidate: ['Q34666893', 'Q50001782'], assessor: ['Q34666893', 'Q50071833', 'Q50073293'] };
  const rows = await sql`select id, code from competencies where org_id = ${template.org_id}`;
  const byCode = new Map(rows.map((r) => [r.code, r.id]));
  const pick = (list, who) =>
    list.flatMap((c) => {
      if (byCode.has(c)) return [byCode.get(c)];
      warnings.push(`${who} competency ${c} not recorded in this org — prerequisite warning will not fire for it.`);
      return [];
    });
  const candidatePrereqs = pick(codes.candidate, 'Candidate');
  const assessorComps = pick(codes.assessor, 'Assessor');

  // ── validate exactly as the API would ───────────────────────────────────
  problems.push(...validateManifest(manifest, fields));
  problems.push(...validateAnswerKeys(fields));

  // ── report ──────────────────────────────────────────────────────────────
  console.log(`\nAnswer keys applied: ${keyed.length}/31`);
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
    insert into assessment_tools (org_id, template_id, name, manifest, candidate_prerequisite_ids, assessor_competency_ids)
    values (${template.org_id}, ${template.id}, ${'Authorised to Operate Track Dozer'}, ${sql.json(manifest)}, ${sql.json(candidatePrereqs)}, ${sql.json(assessorComps)})
    on conflict (template_id) do update
      set manifest = excluded.manifest,
          name = excluded.name,
          candidate_prerequisite_ids = excluded.candidate_prerequisite_ids,
          assessor_competency_ids = excluded.assessor_competency_ids
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
