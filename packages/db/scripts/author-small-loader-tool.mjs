/**
 * Author the Small Loader assessment tool — from a FULLY MAPPED template this
 * script seeds itself (--seed), or against a template someone imported by hand.
 *
 * THE ONE-COMMAND PATH. Nobody maps this paper in the builder. The template —
 * every field and every printed box on all 13 pages — was derived from the
 * blank PDF's own vector grid and lives beside the answer key:
 *
 *   docs/assessment-tools/small-loader.template.json   the fields + geometry
 *   docs/assessment-tools/small-loader.blank.pdf       the paper it prints on
 *
 * Run from packages/db in the environment that can reach the database and the
 * object store (Replit):
 *
 *   pnpm --filter @formai/shared build
 *   cd packages/db
 *   DATABASE_URL=... node scripts/author-small-loader-tool.mjs --seed --key ../key.json          # dry run
 *   DATABASE_URL=... node scripts/author-small-loader-tool.mjs --seed --key ../key.json --write  # persist
 *
 * With --write, --seed uploads the blank PDF to the org's object store,
 * creates the template and its published v1, then writes the tool exactly as
 * the by-hand path does. Run it again in the same database and it finds the
 * seeded template (this paper's name, the seed's own field ids) and
 * re-authors it IN PLACE — link the course, re-key a question, pick up a
 * template change: fields, keys, manifest and workflow are re-applied from
 * the JSON onto its current version, nothing is uploaded, the stored PDF is
 * kept. --template-id <id> names the template explicitly; --new forces a
 * fresh template beside an existing one. (The by-hand path without --seed
 * reads no hints and stores no workflow, so never use it to re-author a
 * seeded template.)
 *
 * Flags: --key <path> (or ANSWER_KEY_PATH; the in-repo copy is the fallback
 * while it exists); --org <uuid> when the database holds more than one org;
 * --published-by <userId> to record who published v1; --asset-id
 * <orgId>/<uuid>.pdf to reuse an already-uploaded PDF instead of uploading;
 * --pdf / --template-json to point at other copies; --offline to validate the
 * whole seed with no database at all (competencies are then unresolved);
 * --course-id <uuid> to link the uploaded SCORM deck as REQUIRED course
 * material with the graded questions embedded in it (assessmentInDeck);
 * --licence-codes Q1,Q2 for every licence class that satisfies "Driver's
 * Licence C or higher" (defaults to Q50001782 alone); --deck <deck-dir> to
 * reconcile the deck's graded cards with the template's ids and option values
 * (the committed deck already matches the seeded template, so this is a
 * no-op there); and, on the by-hand path, --template-id plus the same
 * --candidate-name / --candidate-signature / --assessor-signature /
 * --assessor-name overrides as the Track Dozer script for an ambiguous cover.
 *
 * DRY RUN BY DEFAULT. Everything below is heuristic on the by-hand path —
 * imported ids and labels come from AI extraction — and declared on the seed
 * path, where the template's `hints` name every pointer outright. Either way
 * the script's job is to propose a mapping, show its work, and refuse to
 * write anything that does not survive the same validators the API applies
 * (validateManifest, validateAnswerKeys, validateWorkflow). Read the dry-run
 * report before --write.
 *
 * This is the Track Dozer author script (author-track-dozer-tool.mjs) adapted
 * to this paper, which has the same six-part shape and two pathways, plus what
 * that script never modelled and this tool's flow needs:
 *
 *  1. Locates (or seeds) the template and its current published version.
 *  2. Pairs the 16 theory questions with their ✓/✗ boxes and writes the key
 *     (exact-set-match, all mandatory) and a RING glyph on every option box, so
 *     the export rings the chosen answer rather than ticking it.
 *  3. Anchors parts 1–6 to their PART headings; a leading DECLARATION part on
 *     the cover so the candidate signs to start.
 *  4. Builds the manifest: pathways (new = 1–6; experienced/reassessment = 1–2),
 *     logbook minima (10 h / 20 h) and duration columns, profile prefill for
 *     the three Candidate Details boxes, the cover sign-off block, per-part
 *     assessor boxes, the Assessment Methods checklist auto-ticks
 *     (partCompletionMarks), the printed pathway tick (pathwayMarks), the
 *     Driver's Licence prerequisite box (prerequisiteChecks), Part 1's printed
 *     verdict pair, and — on the seed path — the workflow: who fills what,
 *     with each practical's verdict locked to derive from its checklist.
 *  5. Attaches prerequisite/assessor/awarded competencies found by code.
 *  6. Emits deck-questions.json — the theory questions with their REAL field
 *     ids and options and NO answers — for the SCORM deck's interleaved graded
 *     slides, so deck and tool share ids.
 *  7. Upserts the assessment_tools row.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import {
  derivedWorkflow,
  pairQuestionsWithOutcomes,
  validateAnswerKeys,
  validateManifest,
  validateWorkflow,
} from '@formai/shared';

const WRITE = process.argv.includes('--write');
const SEED = process.argv.includes('--seed');
const OFFLINE = process.argv.includes('--offline');
const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};
const TEMPLATE_ID = flag('--template-id');
const COURSE_ID = flag('--course-id');

const here = dirname(fileURLToPath(import.meta.url));
const DOCS = join(here, '..', '..', '..', 'docs', 'assessment-tools');

/*
  WHERE THE ANSWER KEY COMES FROM — same posture as the Track Dozer script: a
  path from anywhere via --key, the in-repo copy only as a fallback while it
  exists. Confidentiality at runtime is handled by the API (forms.view gate +
  stripMarkingSecrets on every fill surface); this flag is about not shipping
  a safety answer key in the source tree forever.
*/
const KEY_PATH = flag('--key') ?? process.env.ANSWER_KEY_PATH ?? join(DOCS, 'small-loader.answer-key.json');

let KEY;
try {
  KEY = JSON.parse(readFileSync(KEY_PATH, 'utf-8'));
} catch (err) {
  console.error(
    `Could not read an answer key at ${KEY_PATH}\n` +
      `  ${err instanceof Error ? err.message : String(err)}\n\n` +
      `Point the script at one:\n` +
      `  node scripts/author-small-loader-tool.mjs --key /path/to/answer-key.json\n` +
      `or set ANSWER_KEY_PATH.`,
  );
  process.exit(1);
}
/*
  This paper has ONE theory section — PART 1's 16 "Written or Verbal
  Questions" — so the key carries a single `general` section. Shape-check
  before anything else, for the same reason as the Track Dozer script: a key
  that parses but has no questions would reach the pairing logic and report
  "0 pairs expected", which reads like a document problem rather than a
  malformed key.
*/
if (!Array.isArray(KEY?.sections?.general?.questions) || KEY.sections.general.questions.length === 0) {
  console.error(`Answer key at ${KEY_PATH} has no "general" section with a questions array.`);
  process.exit(1);
}
console.log(`Answer key: ${KEY_PATH}`);

if (!OFFLINE && !process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (or pass --offline to validate the seed without a database).');
  process.exit(1);
}
const sql = OFFLINE ? null : postgres(process.env.DATABASE_URL);

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

/**
 * The candidate's answer, ringed rather than ticked.
 *
 * The paper's convention (and the completed examples) is a RING around the
 * chosen option letter with the assessor's ✓/✗ in the margin box. The exporter
 * already draws a mark in each selected option's own box and honours a
 * per-segment `markStyle`; this sets `glyph: 'ring'` on every option segment
 * of a keyed question so the export reproduces the paper. Boxes that are not
 * option boxes (a whole-field box, a row cell) are left exactly as placed.
 */
function ringOptionBoxes(field) {
  const segs = field.geometry?.segments ?? [];
  if (segs.length === 0) return 0;
  let n = 0;
  field.geometry = {
    ...field.geometry,
    segments: segs.map((s) => {
      if (s.optionKey === undefined) return s;
      n++;
      return { ...s, markStyle: { ...(s.markStyle ?? {}), glyph: 'ring' } };
    }),
  };
  return n;
}

/**
 * The blank paper into the org's object store, exactly as the app's own
 * upload route stores it (apps/api/src/storage/replit.ts): key
 * `<orgId>/<uuid>.pdf`, bytes via the Replit SDK. The SDK is the API's
 * dependency, so it is resolved from the API's own node_modules.
 */
async function uploadPdf(orgId, pdfPath) {
  const bytes = readFileSync(pdfPath);
  if ((process.env.STORAGE_PROVIDER ?? 'replit') !== 'replit') {
    throw new Error(
      `STORAGE_PROVIDER=${process.env.STORAGE_PROVIDER} — this script only uploads to Replit object storage. ` +
        `Upload the PDF through the app once and pass --asset-id <orgId>/<uuid>.pdf.`,
    );
  }
  if (!process.env.REPLIT_CLUSTER) {
    throw new Error(
      'Not inside Replit (REPLIT_CLUSTER is unset), so the PDF cannot be uploaded from here. ' +
        'Run this on Replit, or pass --asset-id <orgId>/<uuid>.pdf for a PDF already in the store.',
    );
  }
  const req = createRequire(join(here, '..', '..', '..', 'apps', 'api', 'package.json'));
  const { Client } = req('@replit/object-storage');
  const client = new Client();
  const assetId = `${orgId}/${randomUUID()}.pdf`;
  const result = await client.uploadFromBytes(assetId, bytes);
  if (!result.ok) throw new Error(`storage_upload_failed: ${JSON.stringify(result.error)}`);
  return assetId;
}

/** Which template hint answers each cover-page search — the seed path's declarations. */
const HINT_KEYS = {
  'candidate name': 'candidateName',
  'company name': 'companyName',
  'swipe card': 'swipeCard',
  'candidate signature': 'candidateSignature',
  'assessor signature': 'assessorSignature',
  'assessor name': 'assessorName',
  'assessor sign-off date': 'signedDate',
  'overall satisfactory': 'overallSatisfactory',
  'overall not satisfactory': 'overallNotSatisfactory',
  'more coaching — Yes': 'coachingYes',
  'more coaching — No': 'coachingNo',
  'licence prerequisite box': 'licenceBox',
};

async function main() {
  // ── locate or seed the template and its version ────────────────────────
  let template;
  let version;
  let fields;
  let hints = {};
  let pdfPath = null;
  let templateJsonPath = null;
  let linkedCourseId = null;
  if (SEED) {
    templateJsonPath = flag('--template-json') ?? join(DOCS, 'small-loader.template.json');
    pdfPath = flag('--pdf') ?? join(DOCS, 'small-loader.blank.pdf');
    const tpl = JSON.parse(readFileSync(templateJsonPath, 'utf-8'));
    if (!Array.isArray(tpl.fields) || tpl.fields.length === 0) {
      console.error(`Template at ${templateJsonPath} has no fields.`);
      process.exit(1);
    }
    fields = structuredClone(tpl.fields);
    hints = tpl.hints ?? {};
    const pageCount = Array.isArray(tpl.pages) ? tpl.pages.length : '?';
    console.log(`Seed:     ${tpl.name} — ${fields.length} fields over ${pageCount} pages (${templateJsonPath})`);
    /*
       IDEMPOTENT BY DEFAULT. A seeded template is recognisable — this paper's
       name, and a published version whose fields carry the seed's own ids — so
       a second `--seed` in the same database re-authors THAT template in place
       rather than minting a duplicate nobody asked for. --template-id names
       one explicitly; --new forces a fresh template beside the existing one.
    */
    let inPlaceId = TEMPLATE_ID;
    if (!inPlaceId && !OFFLINE && !process.argv.includes('--new')) {
      const seededId = fields[0]?.id;
      const candidates = await sql`
        select t.id, v.fields
        from form_templates t
        join form_template_versions v on v.id = t.current_version_id
        where t.name = ${tpl.name} and t.status <> 'archived'
        order by t.created_at desc
      `;
      const seeded = candidates.find((c) => Array.isArray(c.fields) && c.fields.some((f) => f?.id === seededId));
      if (seeded) {
        inPlaceId = seeded.id;
        console.log(`Found the seeded template already in this database — re-authoring it in place (pass --new to create another).`);
      }
    }
    if (inPlaceId && !OFFLINE) {
      // Re-author the seeded template IN PLACE: same ids, fresh geometry, keys,
      // manifest and workflow onto its current version; the stored PDF stays.
      const [existing] = await sql`select * from form_templates where id = ${inPlaceId}`;
      if (!existing) {
        console.error(`--template-id ${inPlaceId} is not a template in this database.`);
        process.exit(1);
      }
      if (!existing.current_version_id) {
        console.error(`Template ${inPlaceId} has no published version to re-author.`);
        process.exit(1);
      }
      const [ver] = await sql`select id, source_pdf_asset_id from form_template_versions where id = ${existing.current_version_id}`;
      template = { id: existing.id, org_id: existing.org_id, name: existing.name };
      version = { id: ver.id };
      // The course linked from the builder's Course-material card lives on the
      // tool row already; carry it forward (and mark the assessment in-deck)
      // rather than making the operator hunt for its id.
      const [toolRow] = await sql`select manifest from assessment_tools where template_id = ${existing.id}`;
      linkedCourseId = toolRow?.manifest?.course?.courseId ?? null;
      console.log(`In place: ${existing.name} (${existing.id}) — version ${ver.id}, PDF ${ver.source_pdf_asset_id ?? '(none stored)'} kept`);
      console.log(`Course:   ${COURSE_ID ?? linkedCourseId ?? '(none linked yet — upload it in the Course-material card, or pass --course-id)'}`);
      console.log(`Org:      ${template.org_id}\n`);
    } else {
      let orgId = flag('--org');
      if (!OFFLINE) {
        const orgs = await sql`select id, name from organizations order by created_at`;
        if (orgId) {
          if (!orgs.some((o) => o.id === orgId)) {
            console.error(`--org ${orgId} is not an organisation in this database.`);
            process.exit(1);
          }
        } else if (orgs.length === 1) {
          orgId = orgs[0].id;
        } else {
          console.error(
            `${orgs.length} organisations — pass --org <id>:\n` + orgs.map((o) => `  ${o.id}  ${o.name}`).join('\n'),
          );
          process.exit(1);
        }
      }
      template = { id: null, org_id: orgId ?? '(offline)', name: tpl.name };
      version = { id: null };
      console.log(`PDF:      ${pdfPath} (${readFileSync(pdfPath).length.toLocaleString()} bytes)`);
      console.log(`Org:      ${template.org_id}\n`);
    }
  } else {
    const templates = TEMPLATE_ID
      ? await sql`select * from form_templates where id = ${TEMPLATE_ID}`
      : await sql`select * from form_templates where name ilike ${'%small loader%'} order by created_at desc`;
    if (templates.length === 0) {
      console.error('No Small Loader template found. Run with --seed to create the mapped one, or pass --template-id.');
      process.exit(1);
    }
    if (templates.length > 1 && !TEMPLATE_ID) {
      warnings.push(
        `${templates.length} templates match "small loader". Using the newest (${templates[0].id}). ` +
          `Others: ${templates.slice(1).map((t) => t.id).join(', ')}. Pass --template-id to pick a different one.`,
      );
    }
    template = templates[0];
    if (!template.current_version_id) {
      console.error(`Template ${template.id} has no published version.`);
      process.exit(1);
    }
    [version] = await sql`select * from form_template_versions where id = ${template.current_version_id}`;
    fields = structuredClone(version.fields ?? []);
    console.log(`Template: ${template.name} (${template.id})`);
    console.log(`Version:  ${version.id} — ${fields.length} fields\n`);
  }
  const byId = new Map(fields.map((f) => [f.id, f]));
  const hinted = (key) => (hints[key] ? byId.get(hints[key]) : undefined);

  /* ── theory questions, in document order ─────────────────────────────────
     The published questionRef link wins; document order is the fallback — the
     rule lives in @formai/shared beside the resolver (pairQuestionsWithOutcomes)
     where it is unit tested. The count check is ALL-OR-NOTHING: a missing pair
     would shift every later answer onto the wrong question on a safety record,
     and writing nothing is the only safe response to a misalignment we cannot
     localise. See the Track Dozer script for the full reasoning.
  */
  const { pairs: paired, unpaired, fromLink, fromAdjacency } = pairQuestionsWithOutcomes(fields);
  console.log(
    `Question/outcome pairs found: ${paired.length} ` +
      `(${fromLink} from the published questionRef link, ${fromAdjacency} inferred from document order)`,
  );

  const section = KEY.sections.general;
  const expected = section.questions.length;
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
  const deckQuestions = [];
  let ringed = 0;
  if (paired.length === expected) {
    section.questions.forEach((entry, i) => {
      const { question, outcome, how } = paired[i];
      const mapped = entry.answers.map((l) => ({ letter: l, value: mapLetter(l, question) }));
      const bad = mapped.filter((m) => m.value === null);
      if (bad.length) {
        skipped.push(
          `Q${entry.n} ("${question.label.slice(0, 50)}"): cannot map ${bad.map((m) => m.letter).join(', ')} onto ${JSON.stringify(question.options ?? [])}`,
        );
        return;
      }
      question.answerKey = mapped.map((m) => m.value);
      // Only WRITE a link this script derived; a published link is left as is.
      if (how === 'adjacency') question.outcomeTarget = { fieldId: outcome.id };
      if (section.mandatory) mandatoryFieldIds.push(question.id);
      ringed += ringOptionBoxes(question);
      keyed.push(
        `Q${String(entry.n).padStart(2)} → ${question.id} ` +
          `[${entry.answers.join(',')}] ✓→ ${outcome.id} (${how === 'link' ? 'printed ref' : 'document order'})` +
          (entry.verified === false ? '  ⚠ UNVERIFIED — see key note' : ''),
      );
      /*
        THE DECK'S COPY OF THE QUESTION — id, label and options, NEVER the key.
        The SCORM deck embeds these as graded slides (data-graded + data-field-id)
        and the host relays each answer to POST /answer, which grades against the
        answerKey written above. Sharing the id here is what makes the deck's
        question and the tool's question the same question.
      */
      // `tf` ONLY for a boolean field, whose stored values really are
      // 'true'/'false'. A printed "a) True / b) False" imports as a RADIO whose
      // values are those option strings — the deck must post THOSE — so it is
      // `mc` here; the --deck rewrite below keeps its thumbs card by handing
      // the tf card the real values.
      const boolean = question.type === 'boolean_yes_no';
      deckQuestions.push({
        fieldId: question.id,
        type: boolean ? 'tf' : 'mc',
        number: `Q${entry.n}`,
        question: question.label,
        ...(boolean
          ? {}
          : { options: (question.options ?? []).map((o) => ({ val: o, text: o.replace(/^\s*[a-z]\s*[).:-]\s*/i, '') })) }),
      });
    });
  }

  // ── part anchors ────────────────────────────────────────────────────────
  // Matched on the PART heading only; sub-headings repeat across parts 2, 4
  // and 6, so anchors take the FIRST match of each part number. The trailing
  // space stops "part 1" matching "part 10".
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

  // ── location stream (optional on this paper) ────────────────────────────
  const streamField = fields.find(
    (f) => ['dropdown', 'radio'].includes(f.type) && /department|stream|location/.test(norm(f.label)),
  );
  if (streamField) console.log(`  location stream → ${streamField.id} ("${streamField.label}")`);

  /* ── the cover page ─────────────────────────────────────────────────────
     Every pointer below names a box on the front sheet, and this paper
     reprints its certification block at the end of parts 2, 4 and 6 — so every
     cover search is scoped to the slice BEFORE part 1's anchor, exactly as the
     Track Dozer script learned to. One match or none: absence and ambiguity
     get the same answer, because printing an assessor's name or a competent
     tick in the wrong box on a certificate is worse than a blank one.

     On the seed path the template's `hints` name each pointer outright and
     the search is never run: a declaration beats a regex on a certificate.
  */
  const coverFields = anchors[0] ? fields.slice(0, fields.indexOf(anchors[0])) : fields;
  console.log(`\nCover page: ${coverFields.length} field(s) before the PART 1 anchor`);

  const findOne = (what, re, types, override, pool = coverFields) => {
    const flagName = `--${what.replace(/ /g, '-')}`;
    const declared = override ?? hints[HINT_KEYS[what]] ?? null;
    if (declared) {
      const named = fields.find((f) => f.id === declared);
      if (!named) {
        problems.push(`${what} is declared as field "${declared}", which is not in this version; nothing is written.`);
        return undefined;
      }
      console.log(`  ${what} → ${named.id} "${(named.label ?? '').slice(0, 48)}" (declared${override ? ` by ${flagName}` : ' by the template'})`);
      return named;
    }
    const hits = pool.filter((f) => types.includes(f.type) && re.test(norm(f.label)));
    if (hits.length === 1) return hits[0];
    if (hits.length === 0) {
      warnings.push(`${what}: nothing on the cover page matches — that box will print BLANK. Name it with ${flagName} <id>.`);
    } else {
      warnings.push(
        `${what}: ${hits.length} cover-page fields match (${hits.map((f) => f.id).join(', ')}) — none declared. Pick one with ${flagName} <id>.`,
      );
    }
    return undefined;
  };

  const SCALARS = ['text', 'textarea', 'signature', 'date'];
  const MARKS = ['check_cross', 'checkbox', 'boolean_yes_no'];

  // Candidate Details — prefilled from the profile when the case opens.
  const candidateNameField = findOne('candidate name', /^candidate.*name$(?!.*company)/, SCALARS, flag('--candidate-name'));
  const companyField = findOne('company name', /company/, SCALARS);
  const swipeField = findOne('swipe card', /swipe|card number/, SCALARS);

  /*
     THE CANDIDATE SIGNS TO START. Extraction folds a printed signature box
     into a TEXT input, so this accepts any scalar; `candidateSignatureFieldId`
     makes the fill surface render it as a draw-signature (or the profile's
     stored signature). Anchored to "candidate" so the assessor's signature
     line, which also prints on the cover, is never mistaken for it.
  */
  const candidateSigField = findOne(
    'candidate signature',
    /candidate.*signature|signature.*candidate/,
    SCALARS,
    flag('--candidate-signature'),
  );

  // The assessor's certification block on the cover.
  const sigField = findOne('assessor signature', /assessor.*signature|signature.*assessor/, SCALARS, flag('--assessor-signature'));
  const assessorNameField = findOne('assessor name', /name of assessor|assessor.*name|assessor.*print/, SCALARS, flag('--assessor-name'));
  const signedDateField = findOne(
    'assessor sign-off date',
    /(assessor|assessment)[^]*\bdate\b|\bdate\b[^]*(assessor|assessment|sign)/,
    ['date', 'text'],
  );
  // "Candidate Competent" — and never "Candidate not yet Competent", which also ends in the word.
  const overallField = findOne('overall satisfactory', /^(?!.*\bnot\b).*competent/, MARKS);
  const overallNoField = findOne('overall not satisfactory', /not yet competent|not competent/, MARKS);
  const coachYesField = findOne('more coaching — Yes', /coaching.*yes|further.*training.*yes|\byes\b/, MARKS);
  const coachNoField = findOne('more coaching — No', /coaching.*no\b|further.*training.*no\b|\bno\b/, MARKS);

  // The prerequisite box — "Q50001782 Driver's Licence C or higher".
  const licenceBoxField = findOne('licence prerequisite box', /driver.*licen|licen.*driver|q50001782/, MARKS);

  /* ── the Assessment Methods checklist + pathway boxes ───────────────────
     "Methods used to assess competence" prints as one list: two pathway lines
     ("PART 1 and 2: Experienced…", "PART 1, 2, 3, 4, 5 and 6: New…") and the
     six method rows. The seeded template models the six rows as ONE fixed-row
     table with a tick column (completion ticks address printed rows by index)
     and the two pathway lines as standalone boxes (a pathway is one scalar
     mark). An imported template may fold all eight into one table, or leave
     every box loose; both are handled. The method rows auto-tick from part
     completion (partCompletionMarks); the pathway line is a CASE fact seeded
     at export (pathwayMarks) so the printed box can never disagree with the
     parts the document shows filled.
  */
  const METHOD_ROWS = [
    { partKey: 'p1-theory', re: /^1\b.*theory|\btheory\b/ },
    { partKey: 'p2-practical', re: /^2\b.*practical|practical demonstration/ },
    { partKey: 'p3-logbook', re: /^3\b.*observation|direct observation/ },
    { partKey: 'p4-practical', re: /^4\b.*minimal.*practical|minimal supervision practical/ },
    { partKey: 'p5-logbook', re: /^5\b.*minimal.*log|minimal supervision log/ },
    { partKey: 'p6-practical', re: /^6\b.*final|final practical/ },
  ];
  const PATHWAY_ROWS = [
    // `\bexperienced` — "inexperienced" on the other line must not match this one.
    { pathways: ['experienced', 'rpl'], re: /part 1 and 2\b|\bexperienced|re assessment|reassessment/ },
    { pathways: ['new'], re: /part 1 2 3 4 5 and 6|new and inexperienced|inexperienced/ },
  ];
  const partCompletionMarks = [];
  const pathwayMarks = {};
  const pathwayBoxIds = [];

  const methodsTable =
    hinted('methodsTable') ??
    coverFields.find(
      (f) => f.type === 'repeating_group' && (f.fixedRows?.length ?? 0) >= 6 &&
        f.fixedRows.some((r) => /theory/.test(norm(r))) && f.fixedRows.some((r) => /practical/.test(norm(r))),
    );
  if (methodsTable) {
    const tickCol = (methodsTable.columns ?? []).find((c) => ['check_cross', 'checkbox', 'boolean_yes_no'].includes(c.type))
      ?? (methodsTable.columns ?? [])[0];
    if (!tickCol) {
      warnings.push(`Methods checklist ${methodsTable.id} has no tick column, so nothing auto-ticks.`);
    } else {
      (methodsTable.fixedRows ?? []).forEach((row, rowIndex) => {
        const label = norm(row);
        const m = METHOD_ROWS.find((r) => r.re.test(label));
        if (m) partCompletionMarks.push({ partKey: m.partKey, fieldId: methodsTable.id, rowIndex, columnKey: tickCol.key });
        const p = PATHWAY_ROWS.find((r) => r.re.test(label));
        if (p) for (const pw of p.pathways) pathwayMarks[pw] = { fieldId: methodsTable.id, rowKey: row, columnKey: tickCol.key, value: true };
      });
      console.log(`  methods checklist → ${methodsTable.id} ("${methodsTable.label}"), tick column "${tickCol.key}": ` +
        `${partCompletionMarks.length}/6 method rows, ${Object.keys(pathwayMarks).length} pathway keys in the table`);
    }
  } else {
    // Individual boxes: match each method label to its own field.
    const found = [];
    for (const m of METHOD_ROWS) {
      const hits = coverFields.filter((f) => MARKS.includes(f.type) && m.re.test(norm(f.label)));
      if (hits.length === 1) found.push(m.partKey);
    }
    if (found.length) {
      warnings.push(
        'The Assessment Methods list imported as individual boxes rather than one fixed-row table; ' +
          `${found.length}/6 method boxes matched. partCompletionMarks addresses a fixed-row TABLE, ` +
          'so these are reported but NOT declared — retype the list as a fixed-row repeating table in the builder ' +
          '(one row per method, a tick column) and re-run for the rows to auto-tick.',
      );
    } else {
      warnings.push('No Assessment Methods checklist found on the cover — nothing will auto-tick as parts complete.');
    }
  }
  // The pathway lines as standalone boxes — the seeded shape, and the fallback
  // when an imported table does not carry them.
  if (Object.keys(pathwayMarks).length === 0) {
    for (const p of PATHWAY_ROWS) {
      const hits = coverFields.filter((f) => MARKS.includes(f.type) && p.re.test(norm(f.label)));
      if (hits.length === 1) {
        for (const pw of p.pathways) pathwayMarks[pw] = { fieldId: hits[0].id, value: true };
        pathwayBoxIds.push(hits[0].id);
      }
    }
    if (pathwayBoxIds.length) console.log(`  pathway boxes → ${pathwayBoxIds.join(', ')} (${Object.keys(pathwayMarks).length} pathway keys)`);
    else warnings.push('No pathway boxes found on the cover — the printed pathway line will not tick.');
  }

  // ── manifest: parts ─────────────────────────────────────────────────────
  const all = ['experienced', 'new', 'rpl'];
  const spec = [
    { key: 'p1-theory', label: 'Part 1 — Theory', kind: 'theory', pathways: all },
    { key: 'p2-practical', label: 'Part 2 — Practical Demonstration', kind: 'practical', pathways: all },
    { key: 'p3-logbook', label: 'Part 3 — Direct Observation Log', kind: 'logbook', pathways: ['new'], minimumHours: 10, durationColumnKey: p3Duration },
    { key: 'p4-practical', label: 'Part 4 — Minimal Supervision Practical', kind: 'practical', pathways: ['new'] },
    { key: 'p5-logbook', label: 'Part 5 — Minimal Supervision Log', kind: 'logbook', pathways: ['new'], minimumHours: 20, durationColumnKey: p5Duration },
    { key: 'p6-practical', label: 'Part 6 — Final Practical Assessment', kind: 'practical', pathways: ['new'] },
  ];
  const parts = [];

  /*
     THE CANDIDATE DECLARATION OPENS THE FLOW. A `declaration` part is an
     attestation someone SIGNS, never an assessment computed from a key
     (isSelfMarking refuses to auto-mark one), and it completes at hand-in once
     its required boxes hold something — the signature. Anchored on the cover's
     declaration line so the candidate signs before anything else opens.

     Its slice runs to part 1's anchor, which on this cover means it also holds
     the assessment summary, the methods list and the assessor's certification
     block. None of those is the candidate's to fill — they are written by the
     export, the completion ticks and the sign-off route — so they must not be
     `required`, or the hand-in gate would refuse a signature over boxes no
     candidate can fill. Cleared below, after the pointers are resolved.
  */
  const declarationAnchor =
    hinted('declarationAnchor') ??
    coverFields.find((f) => f.type === 'section_header' && /candidate.*declaration/.test(norm(f.label))) ??
    candidateSigField;
  if (declarationAnchor) {
    parts.push({
      key: 'declaration',
      ordinal: 0,
      label: 'Candidate Declaration',
      kind: 'declaration',
      pathways: all,
      startFieldId: declarationAnchor.id,
    });
    console.log(`  declaration anchor → ${declarationAnchor.id} "${declarationAnchor.label}"`);
  } else {
    warnings.push('No "Candidate Declaration" line or candidate signature found on the cover — no declaration part authored; the flow will start at Part 1.');
  }

  spec.forEach((sp, i) => {
    const anchor = anchors[i];
    if (!anchor) return;
    const part = { key: sp.key, ordinal: parts.length + 1, label: sp.label, kind: sp.kind, pathways: sp.pathways, startFieldId: anchor.id };
    if (sp.minimumHours) part.minimumHours = sp.minimumHours;
    if (sp.durationColumnKey) part.durationColumnKey = sp.durationColumnKey;
    if (sp.key === 'p1-theory' && mandatoryFieldIds.length) part.mandatoryFieldIds = mandatoryFieldIds;
    parts.push(part);
  });
  // Ordinals must be contiguous from 1 whatever was skipped above.
  parts.forEach((p, i) => { p.ordinal = i + 1; });

  /*
     PART 1'S PRINTED VERDICT — "The Candidate's responses were: ☐ Satisfactory
     ☐ Not Satisfactory" — is written by the theory marking from the same
     arithmetic that produced the ✓/✗ column (exactly one of the pair), and the
     cover's "Detail further action" takes the questions to go back over when
     the part is not satisfactory. Declared by the template on the seed path.
  */
  const partHints = hints.parts ?? {};
  for (const part of parts) {
    const h = partHints[part.key];
    if (!h) continue;
    if (h.outcomeSatisfactory && byId.has(h.outcomeSatisfactory)) part.outcomeSatisfactory = { fieldId: h.outcomeSatisfactory, value: true };
    if (h.outcomeNotSatisfactory && byId.has(h.outcomeNotSatisfactory)) part.outcomeNotSatisfactory = { fieldId: h.outcomeNotSatisfactory, value: true };
  }
  if (hints.furtherAction && byId.has(hints.furtherAction)) {
    const theory = parts.find((p) => p.key === 'p1-theory');
    if (theory) theory.furtherActionFieldId = hints.furtherAction;
  }

  // ── the cover's sign-off block ──────────────────────────────────────────
  const signOff = {};
  if (sigField) signOff.assessorSignatureFieldId = sigField.id;
  if (assessorNameField) signOff.assessorNameFieldId = assessorNameField.id;
  if (signedDateField) signOff.signedDateFieldId = signedDateField.id;
  if (overallField) signOff.overallSatisfactory = { fieldId: overallField.id, value: true };
  if (overallNoField) signOff.overallNotSatisfactory = { fieldId: overallNoField.id, value: true };
  if (coachYesField && coachNoField) {
    signOff.moreCoachingRequiredYes = { fieldId: coachYesField.id, value: true };
    signOff.moreCoachingRequiredNo = { fieldId: coachNoField.id, value: true };
  } else if (Boolean(coachYesField) !== Boolean(coachNoField)) {
    warnings.push('Only one of the more-coaching Yes/No boxes was found, so neither is declared — the front page prints both.');
  }

  const coverPointers = [
    ['candidate name', candidateNameField],
    ['company name', companyField],
    ['swipe card', swipeField],
    ['candidate signature', candidateSigField],
    ['assessor signature', sigField],
    ['assessor name', assessorNameField],
    ['signed date', signedDateField],
    ['overall satisfactory', overallField],
    ['overall not satisfactory', overallNoField],
    ['more coaching — Yes', coachYesField],
    ['more coaching — No', coachNoField],
    ['licence prerequisite box', licenceBoxField],
  ];
  const resolved = coverPointers.filter(([, f]) => f).length;
  console.log(`\nFront page: ${resolved}/${coverPointers.length} pointer(s) resolved`);
  for (const [what, f] of coverPointers) {
    console.log(f ? `  ${what.padEnd(26)} → ${f.id} ("${(f.label ?? '').slice(0, 46)}")` : `  ${what.padEnd(26)} → NOT FOUND`);
  }
  if (resolved === 0) {
    warnings.push('NOTHING on the front page resolved — a signed, competent case would export a blank certificate. Fix these before anyone signs one off.');
  }

  /*
     Candidate Details fill themselves: profilePrefill seeds the three identity
     boxes from the candidate's profile when the case opens, and locks them —
     nobody retypes identity data the register already holds.
  */
  const profilePrefill = {};
  if (candidateNameField) profilePrefill[candidateNameField.id] = 'candidate_name';
  if (companyField) profilePrefill[companyField.id] = 'company_name';
  if (swipeField) profilePrefill[swipeField.id] = 'swipe_card';
  // Only a TEXT field can carry a profile value (validateProfilePrefill).
  for (const id of Object.keys(profilePrefill)) {
    const f = fields.find((x) => x.id === id);
    if (f && f.type !== 'text') {
      warnings.push(`profilePrefill: ${id} ("${f.label}") is typed ${f.type}; retyping it to text so the profile can seed it.`);
      f.type = 'text';
    }
  }

  /*
     DECLARATION HAND-IN HYGIENE. The declaration's slice absorbs the rest of
     the cover; everything there that the system writes must not be required
     of the candidate, and the one box that IS theirs — the signature — must be.
  */
  let declSlice = [];
  if (declarationAnchor) {
    const systemWritten = new Set(
      [sigField, assessorNameField, signedDateField, overallField, overallNoField, coachYesField, coachNoField, licenceBoxField, methodsTable]
        .filter(Boolean)
        .map((f) => f.id),
    );
    declSlice = fields.slice(fields.indexOf(declarationAnchor), anchors[0] ? fields.indexOf(anchors[0]) : fields.length);
    let cleared = 0;
    for (const f of declSlice) {
      if (f.id === candidateSigField?.id) continue;
      if (f.required && (systemWritten.has(f.id) || profilePrefill[f.id] || /assessor|coaching|further action|competent|comment/.test(norm(f.label)))) {
        f.required = false;
        cleared++;
      }
    }
    if (candidateSigField) candidateSigField.required = true;
    console.log(`  declaration hand-in: ${cleared} system-written cover box(es) un-required; candidate signature required`);
  }

  // ── each part's own assessor name and date boxes ────────────────────────
  const claimed = new Set(
    [signOff.assessorNameFieldId, signOff.signedDateFieldId, signOff.assessorSignatureFieldId, candidateNameField?.id, candidateSigField?.id].filter(Boolean),
  );
  const indexOfId = new Map(fields.map((f, i) => [f.id, i]));
  const partBoxReport = [];
  parts.forEach((part, i) => {
    if (part.kind === 'declaration') return;
    const h = partHints[part.key] ?? {};
    const from = indexOfId.get(part.startFieldId);
    if (from === undefined) return;
    const nextAnchor = parts[i + 1]?.startFieldId;
    const to = nextAnchor !== undefined ? (indexOfId.get(nextAnchor) ?? fields.length) : fields.length;
    const within = fields.slice(from, to).filter((f) => !claimed.has(f.id));
    const oneWithin = (what, re, types, declaredId) => {
      if (declaredId) {
        const named = byId.get(declaredId);
        if (named) return named;
        warnings.push(`${part.key} ${what}: the template declares "${declaredId}", which is not in this version.`);
      }
      const hits = within.filter((f) => types.includes(f.type) && re.test(norm(f.label)));
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) warnings.push(`${part.key} ${what}: ${hits.length} fields match (${hits.map((f) => f.id).join(', ')}) — none declared.`);
      return undefined;
    };
    const nameField = oneWithin('assessor name', /assessor.*name|name.*assessor|assessor.*print/, SCALARS, h.assessorName);
    const dateField = oneWithin('date', /\bdate\b/, ['date', 'text'], h.signedDate);
    if (nameField) { part.assessorNameFieldId = nameField.id; claimed.add(nameField.id); }
    if (dateField) { part.signedDateFieldId = dateField.id; claimed.add(dateField.id); }
    partBoxReport.push(`  ${part.key.padEnd(14)} name → ${nameField ? nameField.id : '—'}   date → ${dateField ? dateField.id : '—'}`);
  });
  if (partBoxReport.length) {
    console.log("\nPer-part assessor boxes (written from each attempt's own columns):");
    for (const line of partBoxReport) console.log(line);
  }

  // ── competencies by code ────────────────────────────────────────────────
  /*
     The paper's ASSESSMENT SUMMARY settles what this awards and who may run it:
       Category of Assessment  Q50073331 ATO Small Loader
       Prerequisites           Q50001782 Driver's Licence C or higher
     Assessors hold Q50073331 plus a location authority — Q50071833 Worsley
     Assessor Skill Set (mine) or Q50073293 Authority to Assess Mobile
     Equipment (raw materials) — modelled as the same conditional rule the
     Track Dozer script uses: the category always, the stream half by location.
  */
  const AWARDED = 'Q50073331';
  const licenceCodes = (flag('--licence-codes') ?? 'Q50001782').split(',').map((s) => s.trim()).filter(Boolean);
  const codes = { candidate: licenceCodes, assessor: [AWARDED], awarded: [AWARDED] };
  const STREAM_CODES = { Mining: 'Q50071833', 'Raw Materials': 'Q50073293' };

  const rows = OFFLINE ? [] : await sql`select id, code, valid_for_months from competencies where org_id = ${template.org_id}`;
  if (OFFLINE) warnings.push('OFFLINE: competencies were not looked up — every competency pointer below is unresolved in this run.');
  const byCode = new Map(rows.map((r) => [r.code, r.id]));
  const pick = (list, who) =>
    list.flatMap((c) => {
      if (byCode.has(c)) return [byCode.get(c)];
      warnings.push(`${who} competency ${c} not recorded in this org — prerequisite warning will not fire for it.`);
      return [];
    });
  const candidatePrereqs = pick(codes.candidate, 'Candidate');
  const assessorComps = pick(codes.assessor, 'Assessor');
  /*
     KEYED BY LOCATION ID, NOT NAME. A case is placed at a managed Location and
     the API resolves the location half of the assessor rule by that id — and
     looks the keys up as uuids to name them in warnings, which is exactly what
     a name-keyed map ("Mining") made Postgres refuse, as a 500 on every case.
     So the stream names below are resolved to the org's Locations here, and a
     stream with no matching Location is left out with a warning rather than
     written under a key nothing can resolve.
  */
  const locationRows = OFFLINE ? [] : await sql`select id, name from locations where org_id = ${template.org_id} and status = 'active'`;
  const locationByName = new Map(locationRows.map((l) => [norm(l.name), l.id]));
  const assessorStreams = {};
  for (const [stream, code] of Object.entries(STREAM_CODES)) {
    const id = byCode.get(code);
    if (!id) {
      warnings.push(`Assessor authority ${code} (${stream}) is not recorded in this org; cases in that stream will warn that the location half of the assessor check could not be made.`);
      continue;
    }
    const locationId = locationByName.get(norm(stream));
    if (!locationId) {
      warnings.push(`No active Location named "${stream}" in this org, so the ${code} rule for it is not written; add the Location (Enterprise → Locations) and re-run.`);
      continue;
    }
    assessorStreams[locationId] = [id];
    console.log(`  assessor rule: ${code} at Location "${stream}" (${locationId})`);
  }
  const awardedComps = pick(codes.awarded, 'Awarded');
  if (awardedComps.length === 0) {
    warnings.push(`Awarded competency ${AWARDED} is not recorded in this org, so passing will grant NOTHING to the register. Create it and re-run (the tool row is upserted).`);
  } else {
    console.log(`\nPassing this assessment awards: ${AWARDED} (ATO Small Loader)`);
    const awarded = rows.find((r) => r.code === AWARDED);
    if (awarded && awarded.valid_for_months == null) {
      warnings.push(`${AWARDED} has no validity period, so grants never expire. The paper revalidates three-yearly; set validForMonths: 36 on it.`);
    }
  }

  // The licence box on the cover — ticked from the register at export.
  const prerequisiteChecks = [];
  if (licenceBoxField) {
    if (candidatePrereqs.length) prerequisiteChecks.push({ fieldId: licenceBoxField.id, competencyIds: candidatePrereqs });
    else warnings.push('Licence prerequisite box found but no licence competency is recorded in this org, so it is not declared.');
  }

  // ── manifest ────────────────────────────────────────────────────────────
  const manifest = {
    parts,
    ...(streamField ? { locationStreamFieldId: streamField.id } : {}),
    ...(candidateNameField ? { candidateNameFieldId: candidateNameField.id } : {}),
    ...(candidateSigField ? { candidateSignatureFieldId: candidateSigField.id } : {}),
    ...(Object.keys(profilePrefill).length ? { profilePrefill } : {}),
    ...(Object.keys(signOff).length ? { signOff } : {}),
    ...(partCompletionMarks.length ? { partCompletionMarks } : {}),
    ...(Object.keys(pathwayMarks).length ? { pathwayMarks } : {}),
    ...(prerequisiteChecks.length ? { prerequisiteChecks } : {}),
    // One question per screen, retried on the spot (the deck's in-slide modal
    // mirrors this); the whole section is mandatory — 100% to pass, as the
    // Track Dozer's General section is.
    theoryRendering: 'one_per_screen',
    theoryRetry: 'immediate',
    /*
       THE COURSE. The SCORM deck built from the BBM Small Loader Manual carries
       the theory questions as graded slides (assessmentInDeck), so the theory
       attempt opens at course start and each in-deck answer is recorded as the
       candidate reads. Linked when --course-id names the uploaded package, or
       — re-authoring in place — when the Course-material card already linked
       one; the card itself cannot set assessmentInDeck, so this is where it
       is switched on.
    */
    ...(COURSE_ID || linkedCourseId
      ? { course: { courseId: COURSE_ID ?? linkedCourseId, required: true, assessmentInDeck: true } }
      : {}),
  };
  console.log(`\nMandatory (must-be-100%) questions: ${mandatoryFieldIds.length} — ${mandatoryFieldIds.length ? 'all of Part 1' : 'none'}`);
  console.log(`Ring glyph set on ${ringed} option box(es) across the theory questions`);

  /* ── the workflow: who fills what ────────────────────────────────────────
     Only on the seed path, where the template's shape is known. This is the
     flow as the training authority described it, stored so it survives every
     read rather than re-derived:

       Candidate Details        prefilled, read-only for everyone
       Candidate Declaration    the candidate signs; the rest of the cover —
                                summary, methods, feedback, result, sign-off —
                                is the assessor's, hidden from the candidate,
                                and the export writes the boxes it owns
       Part 1 (theory)          the candidate answers (in the deck), the
                                assessor watches; marking writes the ✓/✗
                                column and the verdict pair
       Parts 2 / 4 / 6          the assessor ticks the checklist; the printed
                                verdict is LOCKED `auto` so hand-in derives it
                                from the ticks (N/A counts as judged)
       Parts 3 / 5 (logbooks)   the candidate logs hours, the assessor can
                                read them at any time

     `derivedWorkflow` supplies the locks the manifest already implies (every
     keyed question's ✓/✗ cell, the verdict pair, the completion checklist,
     the sign-off marks); this adds the access model and the practical
     verdicts' `auto`, then validates the result as the API would.
  */
  if (SEED && parts.length) {
    const wf = derivedWorkflow(manifest, fields);
    const partByKey = new Map(parts.map((p) => [p.key, p]));
    for (const s of wf.sections) {
      const part = partByKey.get(s.partKey);
      if (!part) continue;
      const src = { ...(s.fieldSource ?? {}) };
      const acc = { ...(s.fieldAccess ?? {}) };
      if (part.kind === 'declaration') {
        s.access = { candidate: 'fill', assessor: 'view' };
        for (const f of declSlice) {
          if (f.type === 'section_header' || f.id === candidateSigField?.id) continue;
          acc[f.id] = { candidate: 'hidden', assessor: 'fill' };
        }
        for (const id of pathwayBoxIds) src[id] = 'auto';
      } else if (part.kind === 'theory' || part.kind === 'logbook') {
        s.access = { candidate: 'fill', assessor: 'view' };
      } else if (part.kind === 'practical') {
        s.access = { candidate: 'view', assessor: 'fill' };
        const v = partHints[part.key]?.verdict;
        if (v && byId.has(v)) src[v] = 'auto';
        else warnings.push(`${part.key}: no verdict radio declared — the assessor picks the verdict by hand.`);
      }
      if (Object.keys(src).length) s.fieldSource = src;
      if (Object.keys(acc).length) s.fieldAccess = acc;
    }
    // Everything before the first anchor — the Candidate Details — plus the
    // prerequisite box, which `fieldsInPart` deliberately keeps out of every
    // part: prefilled or export-written, read-only for everyone.
    const firstAnchor = Math.min(...parts.map((p) => indexOfId.get(p.startFieldId) ?? Infinity));
    const frontIds = fields.slice(0, Number.isFinite(firstAnchor) ? firstAnchor : 0).filter((f) => f.type !== 'section_header').map((f) => f.id);
    for (const c of prerequisiteChecks) if (!frontIds.includes(c.fieldId)) frontIds.push(c.fieldId);
    if (frontIds.length) {
      for (const s of wf.sections) s.ordinal += 1;
      const src = {};
      for (const id of frontIds) src[id] = profilePrefill[id] ? 'prefill' : 'auto';
      wf.sections.unshift({ key: 'front', ordinal: 1, label: 'Candidate Details', fieldIds: frontIds, access: { candidate: 'view', assessor: 'view' }, fieldSource: src });
    }
    manifest.workflow = wf;
    const wv = validateWorkflow(wf, manifest, fields);
    problems.push(...wv.problems.map((p) => `workflow: ${p}`));
    warnings.push(...wv.warnings.map((w) => `workflow: ${w}`));
    console.log(`\nWorkflow: ${wf.sections.length} section(s) — ` + wf.sections.map((s) => `${s.label} [c:${s.access.candidate ?? 'hidden'} a:${s.access.assessor ?? 'hidden'}]`).join(' · '));
  }

  // ── validate exactly as the API would ───────────────────────────────────
  problems.push(...validateManifest(manifest, fields));
  problems.push(...validateAnswerKeys(fields));

  const claimedOutcomes = new Set(paired.map((p) => p.outcome.id));
  const orphanOutcomes = fields.filter((f) => f.type === 'check_cross' && !claimedOutcomes.has(f.id) && !claimed.has(f.id) &&
    ![overallField, overallNoField, coachYesField, coachNoField, licenceBoxField].some((x) => x && x.id === f.id));
  if (orphanOutcomes.length) {
    const practical = orphanOutcomes.filter((f) => parts.some((p) => p.kind === 'practical' && indexOfId.get(f.id) > indexOfId.get(p.startFieldId)));
    const rest = orphanOutcomes.filter((f) => !practical.includes(f));
    if (rest.length) {
      warnings.push(
        `${rest.length} printed ✓/✗ box(es) belong to no keyed question: ` +
          rest.map((f) => `${f.id} "${(f.label ?? '').slice(0, 40)}"`).join(', ') +
          '. A theory box here means a question failed to pair.',
      );
    }
    if (practical.length) console.log(`Practical checklist criteria (✓/✗ boxes the assessor ticks): ${practical.length}`);
  }

  // ── deck questions ─────────────────────────────────────────────────────
  // Written on every run (dry or not) so the deck can be authored from a dry
  // run's ids before anything is persisted. No answer key is in this file.
  // Into the temp dir by default, so a run never litters the working tree.
  const deckOut = flag('--deck-questions') ?? join(tmpdir(), 'small-loader.deck-questions.json');
  if (deckQuestions.length) {
    writeFileSync(deckOut, JSON.stringify({ _note: 'Graded in-deck questions for the SCORM deck (course-deck-builder `questions`) — field ids match the published tool; NO answers here.', questions: deckQuestions }, null, 2));
    console.log(`\nDeck questions (no answers) → ${deckOut}  [${deckQuestions.length} questions]`);
  }

  /*
     RECONCILE THE DECK. docs/courses/bbm-small-loader-manual/deck.json carries
     each graded card's field id and option values. The committed deck already
     matches the seeded template (same ids, same option strings), so --deck is
     a no-op there; against an imported template it rewrites every card from
     the pairing above — the REAL field id, and option `val`s that are the real
     option strings the answerKey matches — joined on the question NUMBER
     printed on the paper. Rebuild the package afterwards (build_deck.py) and
     upload THAT zip. Written on a dry run too — it is a source file, not the
     database.
  */
  const DECK_DIR = flag('--deck');
  if (DECK_DIR && deckQuestions.length) {
    const deckPath = join(DECK_DIR, 'deck.json');
    const deck = JSON.parse(readFileSync(deckPath, 'utf-8'));
    const before = JSON.stringify(deck);
    const byNumber = new Map(deckQuestions.map((q) => [q.number, q]));
    const seen = new Set();
    const unmatched = [];
    let rewritten = 0;
    for (const part of deck.parts ?? []) {
      for (const card of part.questions ?? []) {
        const real = byNumber.get(String(card.number ?? ''));
        if (!real) {
          unmatched.push(String(card.number ?? card.fieldId));
          continue;
        }
        seen.add(real.number);
        card.fieldId = real.fieldId;
        if (real.type === 'tf') {
          delete card.options; // a boolean field — the tf card's own true/false
        } else if (card.type === 'tf') {
          // A printed True/False that imported as a radio: keep the thumbs
          // card, post the radio's real option strings.
          const t = real.options.find((o) => /true/i.test(o.val)) ?? real.options[0];
          const f = real.options.find((o) => /false/i.test(o.val)) ?? real.options[1];
          card.options = [{ val: t.val, text: 'TRUE' }, { val: f.val, text: 'FALSE' }];
        } else {
          card.options = real.options;
        }
        rewritten++;
      }
    }
    const missing = deckQuestions.filter((q) => !seen.has(q.number)).map((q) => q.number);
    if (unmatched.length) warnings.push(`Deck cards with no keyed question: ${unmatched.join(', ')} — left as they were.`);
    if (missing.length) {
      warnings.push(`Keyed questions with no deck card: ${missing.join(', ')} — the deck never asks them; the candidate answers them on the case instead.`);
    }
    if (JSON.stringify(deck) === before) {
      console.log(`Deck already matches the template → ${deckPath}  [${rewritten} card(s) checked, nothing to rewrite]`);
    } else {
      writeFileSync(deckPath, JSON.stringify(deck, null, 2) + '\n');
      console.log(`Deck reconciled → ${deckPath}  [${rewritten} card(s) now carry real field ids and values — rebuild the package]`);
    }
  }

  // ── report ──────────────────────────────────────────────────────────────
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
  // --emit <path>: the exact fields + manifest a --write would persist, for a
  // test harness to load into an in-memory database and drive the routes.
  const EMIT = flag('--emit');
  if (EMIT) {
    writeFileSync(EMIT, JSON.stringify({ name: template.name, fields, manifest, candidatePrereqs, assessorComps, assessorStreams, awardedComps }, null, 1));
    console.log(`Seed emitted → ${EMIT}`);
  }
  if (OFFLINE) {
    console.log('\nOffline validation complete: the seeded template, its answer keys, manifest and workflow all pass the API\'s validators.');
    return;
  }
  if (!WRITE) {
    console.log(
      SEED && !template.id
        ? `\nDry run complete. Re-run with --write to upload the PDF, create "${template.name}" (published v1) and persist the tool.`
        : SEED
          ? `\nDry run complete. Re-run with --write to re-apply the fields, keys, manifest and workflow onto ${template.id} in place.`
          : '\nDry run complete. Re-run with --write to persist.',
    );
    return;
  }

  // ── persist ─────────────────────────────────────────────────────────────
  if (SEED && !template.id) {
    let assetId = flag('--asset-id');
    if (assetId) {
      console.log(`\nUsing the PDF already stored as ${assetId}`);
    } else {
      assetId = await uploadPdf(template.org_id, pdfPath);
      console.log(`\nUploaded the blank PDF as ${assetId}`);
    }
    const [t] = await sql`
      insert into form_templates (org_id, name, source_type, status)
      values (${template.org_id}, ${template.name}, 'pdf_import', 'published')
      returning id
    `;
    const [v] = await sql`
      insert into form_template_versions (template_id, version_label, state, fields, source_pdf_asset_id, published_at, published_by)
      values (${t.id}, 'v1', 'published', ${sql.json(fields)}, ${assetId}, now(), ${flag('--published-by') ?? null})
      returning id
    `;
    await sql`update form_templates set current_version_id = ${v.id}, updated_at = now() where id = ${t.id}`;
    template.id = t.id;
    version.id = v.id;
    console.log(`Created template ${t.id} with published version ${v.id}`);
  }
  await sql`update form_template_versions set fields = ${sql.json(fields)} where id = ${version.id}`;
  await sql`
    insert into assessment_tools (org_id, template_id, name, manifest, candidate_prerequisite_ids, assessor_competency_ids, assessor_stream_competency_ids, awarded_competency_ids)
    values (${template.org_id}, ${template.id}, ${'Authorised to Operate Small Loader'}, ${sql.json(manifest)}, ${sql.json(candidatePrereqs)}, ${sql.json(assessorComps)}, ${sql.json(assessorStreams)}, ${sql.json(awardedComps)})
    on conflict (template_id) do update
      set manifest = excluded.manifest,
          name = excluded.name,
          candidate_prerequisite_ids = excluded.candidate_prerequisite_ids,
          assessor_competency_ids = excluded.assessor_competency_ids,
          assessor_stream_competency_ids = excluded.assessor_stream_competency_ids,
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
  .finally(() => sql?.end());
