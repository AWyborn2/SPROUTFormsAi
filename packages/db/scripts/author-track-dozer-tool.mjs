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
 *  2. Finds each part's starting section header by label.
 *  3. Maps answer-key letters onto each theory question's real options and
 *     writes answerKey + outcomeTarget onto the version's fields.
 *  4. Builds the six-part manifest (pathways, hours minima, duration columns).
 *  5. Attaches prerequisite/assessor competencies found by code.
 *  6. Upserts the assessment_tools row.
 *
 * Known limitation, reported not hidden: a theory question with no adjacent
 * check_cross outcome field cannot be auto-marked (validateAnswerKeys requires
 * a target). Such questions are listed and skipped — add outcome fields in the
 * builder, then re-run.
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

/** First section_header whose normalised label contains every term set. */
function findHeader(fields, ...termSets) {
  for (const terms of termSets) {
    const hit = fields.find(
      (f) => f.type === 'section_header' && terms.every((t) => norm(f.label).includes(t)),
    );
    if (hit) return hit;
  }
  return null;
}

/** Fields strictly between a header and the next section_header. */
function sectionOf(fields, headerId) {
  const start = fields.findIndex((f) => f.id === headerId);
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < fields.length; i++) {
    if (fields[i].type === 'section_header') break;
    out.push(fields[i]);
  }
  return out;
}

/** Fields from one header up to (not including) another header, spanning sections. */
function between(fields, fromId, toId) {
  const a = fields.findIndex((f) => f.id === fromId);
  const b = toId ? fields.findIndex((f) => f.id === toId) : fields.length;
  if (a < 0) return [];
  return fields.slice(a + 1, b < 0 ? fields.length : b);
}

const QUESTION_TYPES = new Set(['checkbox_group', 'radio', 'dropdown', 'boolean_yes_no']);

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

/** The check_cross field that follows `field` before the next question/header. */
function outcomeAfter(fields, field) {
  const i = fields.findIndex((f) => f.id === field.id);
  for (let j = i + 1; j < fields.length; j++) {
    const f = fields[j];
    if (f.type === 'section_header' || QUESTION_TYPES.has(f.type)) return null;
    if (f.type === 'check_cross') return f;
  }
  return null;
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

  // ── part headers ────────────────────────────────────────────────────────
  const headers = {
    p1: findHeader(fields, ['part 1'], ['theory']),
    general: findHeader(fields, ['general']),
    mining: findHeader(fields, ['bbm mining'], ['mining only']),
    raw: findHeader(fields, ['raw materials']),
    p2: findHeader(fields, ['part 2']),
    p3: findHeader(fields, ['part 3'], ['direct observation log']),
    p4: findHeader(fields, ['part 4']),
    p5: findHeader(fields, ['part 5'], ['minimal supervision log'], ['minimimal supervision log']),
    p6: findHeader(fields, ['part 6']),
  };
  for (const [k, h] of Object.entries(headers)) {
    if (h) console.log(`  header ${k.padEnd(7)} → ${h.id}  "${h.label}"`);
    else problems.push(`No section header found for "${k}".`);
  }

  // ── theory answer keys ──────────────────────────────────────────────────
  const keyed = [];
  const skipped = [];
  const sectionSpans = {
    general: [headers.general, headers.mining],
    bbmMining: [headers.mining, headers.raw],
    rawMaterials: [headers.raw, headers.p2],
  };
  for (const [name, [from, to]] of Object.entries(sectionSpans)) {
    if (!from) {
      problems.push(`Theory section "${name}" has no header; its keys were not applied.`);
      continue;
    }
    const qs = between(fields, from.id, to?.id).filter((f) => QUESTION_TYPES.has(f.type));
    const keySection = KEY.sections[name];
    if (qs.length !== keySection.questions.length) {
      problems.push(
        `Section "${name}": template has ${qs.length} question fields but the key has ${keySection.questions.length}. Keys NOT applied — fix the import or the mapping first.`,
      );
      continue;
    }
    qs.forEach((field, i) => {
      const entry = keySection.questions[i];
      const mapped = entry.answers.map((l) => ({ letter: l, value: mapLetter(l, field) }));
      const unmappable = mapped.filter((m) => m.value === null);
      if (unmappable.length > 0) {
        skipped.push(`${name} Q${entry.n} ("${field.label}"): cannot map letter(s) ${unmappable.map((m) => m.letter).join(', ')} onto options ${JSON.stringify(field.options ?? [])}`);
        return;
      }
      const outcome = outcomeAfter(fields, field);
      if (!outcome) {
        skipped.push(`${name} Q${entry.n} ("${field.label}"): no check_cross outcome field follows it — add one in the builder.`);
        return;
      }
      field.answerKey = mapped.map((m) => m.value);
      field.outcomeTarget = { fieldId: outcome.id };
      keyed.push(`${name} Q${entry.n}: [${entry.answers.join(',')}] → ${JSON.stringify(field.answerKey)} ✓→ ${outcome.id}`);
    });
  }

  // ── logbook duration columns ────────────────────────────────────────────
  function durationColumn(headerId, partLabel) {
    if (!headerId) return undefined;
    const table = sectionOf(fields, headerId).find((f) => f.type === 'repeating_group');
    if (!table) {
      problems.push(`${partLabel}: no repeating table in its section.`);
      return undefined;
    }
    const col = (table.columns ?? []).find((c) => /duration|hours/.test(norm(c.label)));
    if (!col) {
      problems.push(`${partLabel}: table "${table.label}" has no duration/hours column. Columns: ${(table.columns ?? []).map((c) => `${c.key} ("${c.label}")`).join(', ')}`);
      return undefined;
    }
    console.log(`  ${partLabel}: duration column "${col.key}" ("${col.label}") in table ${table.id}`);
    return col.key;
  }
  const p3Duration = durationColumn(headers.p3?.id, 'Part 3 logbook');
  const p5Duration = durationColumn(headers.p5?.id, 'Part 5 logbook');

  // ── location stream ─────────────────────────────────────────────────────
  const streamField = fields.find(
    (f) => ['dropdown', 'radio'].includes(f.type) && /department|stream|mining.*raw|location/.test(norm(f.label)),
  );
  if (streamField) console.log(`  location stream field: ${streamField.id} ("${streamField.label}")`);
  else warnings.push('No location-stream question found. Add a "Which department?" dropdown in the builder (options: Mining, Raw Materials) with visibleWhen conditions on the Mining/Raw sections, then re-run.');

  // ── manifest ────────────────────────────────────────────────────────────
  const all = ['experienced', 'new', 'rpl'];
  const parts = [];
  if (headers.p1) parts.push({ key: 'p1-theory', ordinal: 1, label: 'Part 1 — Theory', kind: 'theory', pathways: all, startFieldId: headers.p1.id, ...(headers.general ? { mandatorySectionFieldId: headers.general.id } : {}) });
  if (headers.p2) parts.push({ key: 'p2-practical', ordinal: 2, label: 'Part 2 — Practical Demonstration', kind: 'practical', pathways: all, startFieldId: headers.p2.id });
  if (headers.p3) parts.push({ key: 'p3-logbook', ordinal: 3, label: 'Part 3 — Direct Observation Log', kind: 'logbook', pathways: ['new'], startFieldId: headers.p3.id, minimumHours: 20, ...(p3Duration ? { durationColumnKey: p3Duration } : {}) });
  if (headers.p4) parts.push({ key: 'p4-practical', ordinal: 4, label: 'Part 4 — Minimal Supervision Practical', kind: 'practical', pathways: ['new'], startFieldId: headers.p4.id });
  if (headers.p5) parts.push({ key: 'p5-logbook', ordinal: 5, label: 'Part 5 — Minimal Supervision Log', kind: 'logbook', pathways: ['new'], startFieldId: headers.p5.id, minimumHours: 50, ...(p5Duration ? { durationColumnKey: p5Duration } : {}) });
  if (headers.p6) parts.push({ key: 'p6-practical', ordinal: 6, label: 'Part 6 — Final Practical Assessment', kind: 'practical', pathways: ['new'], startFieldId: headers.p6.id });
  const manifest = { parts, ...(streamField ? { locationStreamFieldId: streamField.id } : {}) };

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
