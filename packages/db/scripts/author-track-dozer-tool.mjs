/**
 * Author the Track Dozer assessment tool against an IMPORTED template.
 *
 * Run from packages/db in the environment that can reach the database
 * (Replit), after the PDF has been imported and published:
 *
 *   pnpm --filter @formai/shared build
 *   cd packages/db
 *   DATABASE_URL=... node scripts/author-track-dozer-tool.mjs            # dry run
 *   DATABASE_URL=... node scripts/author-track-dozer-tool.mjs --write    # persist
 *
 * Optional: --template-id <uuid> when name matching finds the wrong template.
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
 * Questions are paired with the check_cross that FOLLOWS them, and the pairs
 * are consumed in document order against the key's three sections. If the pair
 * count does not equal the key's answer count EXACTLY, nothing is written —
 * an off-by-one would silently shift every subsequent answer onto the wrong
 * question, which on a safety assessment is worse than not running at all.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { validateAnswerKeys, validateManifest } from '@formai/shared';

const WRITE = process.argv.includes('--write');
const tplArgIdx = process.argv.indexOf('--template-id');
const TEMPLATE_ID = tplArgIdx > -1 ? process.argv[tplArgIdx + 1] : null;

const here = dirname(fileURLToPath(import.meta.url));
const KEY_PATH = join(here, '..', '..', '..', 'docs', 'assessment-tools', 'track-dozer.answer-key.json');
const KEY = JSON.parse(readFileSync(KEY_PATH, 'utf-8'));

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
  if (templates.length > 1) {
    warnings.push(`${templates.length} templates match "track dozer"; using the newest. Pass --template-id to pick.`);
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

  // ── theory questions, in document order ─────────────────────────────────
  //
  // Questions are paired with the check_cross that FOLLOWS them: the assessment
  // profile emits each outcome box immediately after its question, so adjacency
  // is the pairing rule rather than a label match (labels vary — "Q1 Outcome",
  // "BBM Q1 Outcome", "7b. Outcome").
  const CHOICE = new Set(['checkbox_group', 'radio', 'dropdown', 'boolean_yes_no']);
  const paired = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!CHOICE.has(f.type)) continue;
    const next = fields[i + 1];
    if (next?.type === 'check_cross') paired.push({ question: f, outcome: next });
  }
  console.log(`Question/outcome pairs found: ${paired.length}`);

  // The key's three sections in printed order. Pairs are consumed in document
  // order, which is why the run-length check below is the safety net: if the
  // counts do not line up exactly, the mapping is not trustworthy and nothing
  // is written.
  const sectionOrder = [
    ['general', KEY.sections.general],
    ['bbmMining', KEY.sections.bbmMining],
    ['rawMaterials', KEY.sections.rawMaterials],
  ];
  const expected = sectionOrder.reduce((n, [, sec]) => n + sec.questions.length, 0);
  if (paired.length !== expected) {
    problems.push(
      `Found ${paired.length} question/outcome pairs but the key has ${expected} answers. ` +
        `Nothing written — confirm the import produced one outcome box per question.`,
    );
  }

  const keyed = [];
  const skipped = [];
  const mandatoryFieldIds = [];
  if (paired.length === expected) {
    let cursor = 0;
    for (const [name, section] of sectionOrder) {
      for (const entry of section.questions) {
        const { question, outcome } = paired[cursor++];
        const mapped = entry.answers.map((l) => ({ letter: l, value: mapLetter(l, question) }));
        const bad = mapped.filter((m) => m.value === null);
        if (bad.length) {
          skipped.push(
            `${name} Q${entry.n} ("${question.label.slice(0, 50)}"): cannot map ${bad.map((m) => m.letter).join(', ')} onto ${JSON.stringify(question.options ?? [])}`,
          );
          continue;
        }
        question.answerKey = mapped.map((m) => m.value);
        question.outcomeTarget = { fieldId: outcome.id };
        if (section.mandatory) mandatoryFieldIds.push(question.id);
        keyed.push(`${name.padEnd(13)} Q${String(entry.n).padStart(2)} → ${question.id} [${entry.answers.join(',')}] ✓→ ${outcome.id}`);
      }
    }
  }

  // ── part anchors ────────────────────────────────────────────────────────
  //
  // Matched on the PART heading only. Sub-headings ("4.1 Operational
  // Requirements") repeat across parts 2, 4 and 6, and the page-group boundary
  // duplicates some headers outright — so anchors take the FIRST match of each
  // part number and ignore the rest.
  function partAnchor(n) {
    const re = new RegExp(`^part\s*${n}\b`);
    const hit = fields.find((f) => f.type === 'section_header' && re.test(norm(f.label)));
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
