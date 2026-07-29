/**
 * Dump an imported template's extracted fields, so a manifest can be authored
 * against what the extractor ACTUALLY produced rather than what it was assumed
 * to produce.
 *
 *   cd packages/db
 *   DATABASE_URL=... node scripts/inspect-template.mjs
 *   DATABASE_URL=... node scripts/inspect-template.mjs --template-id <uuid>
 *   DATABASE_URL=... node scripts/inspect-template.mjs --full   # every field
 *
 * Read-only. Writes nothing.
 */
import postgres from 'postgres';

const argv = process.argv;
const FULL = argv.includes('--full');
const i = argv.indexOf('--template-id');
const TEMPLATE_ID = i > -1 ? argv[i + 1] : null;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL);

const clip = (s, n = 78) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * Size the geometry job, and say how much of it a machine can offer to do.
 *
 * Evidence export draws nothing for a field with no placement, so until this
 * reaches full coverage the exported PDF is blank wherever it is short. The
 * split that matters is AUTO-PROPOSABLE vs HAND-PLACE-ONLY: `deriveForField`
 * (apps/web) only proposes for a repeating table with at least two columns and
 * a known row count. Everything else has to be drawn by a reviewer, one box at
 * a time, so that count is the real cost of the remaining work.
 *
 * Boxes, not fields, is the unit — a choice field ticks per option, so it needs
 * one box for each.
 */
function reportPlacementWork(fields) {
  const CHOICE = new Set(['checkbox_group', 'radio', 'dropdown']);
  // A section header is printed furniture with no answer to place.
  const placeable = fields.filter((f) => f.type !== 'section_header');
  const missing = placeable.filter((f) => !f.geometry && !f.sourcePosition);

  const autoProposable = (f) =>
    f.type === 'repeating_group' && (f.columns?.length ?? 0) >= 2 && (f.fixedRows?.length ?? 0) > 0;

  // printSelectedValue prints the chosen value as text in ONE box, so it is
  // placed like a scalar rather than per option.
  const boxesFor = (f) =>
    CHOICE.has(f.type) && !f.printSelectedValue && (f.options?.length ?? 0) > 0 ? f.options.length : 1;

  const auto = missing.filter(autoProposable);
  const hand = missing.filter((f) => !autoProposable(f));
  const handBoxes = hand.reduce((n, f) => n + boxesFor(f), 0);

  console.log('');
  console.log('PLACEMENT WORK REMAINING');
  console.log(`  ${placeable.length - missing.length}/${placeable.length} answerable fields placed`);
  console.log(`  ${auto.length} field(s) a machine can propose for (repeating tables)`);
  console.log(`  ${hand.length} field(s) must be hand-drawn — ${handBoxes} box(es) in total`);

  if (hand.length) {
    const byType = {};
    for (const f of hand) byType[f.type] = (byType[f.type] ?? 0) + boxesFor(f);
    console.log('  hand-drawn boxes by field type:');
    for (const [k, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(4)}  ${k}`);
    }
  }
}

async function main() {
  const templates = TEMPLATE_ID
    ? await sql`select * from form_templates where id = ${TEMPLATE_ID}`
    : await sql`select * from form_templates where name ilike ${'%track dozer%'} order by created_at desc`;
  if (!templates.length) {
    console.error('No matching template. Pass --template-id.');
    process.exit(1);
  }
  const t = templates[0];
  const [v] = await sql`select * from form_template_versions where id = ${t.current_version_id}`;
  const fields = v.fields ?? [];

  console.log(`Template ${t.name} (${t.id})`);
  console.log(`Version  ${v.id} — ${fields.length} fields, sourcePdfAssetId=${v.source_pdf_asset_id ?? 'NONE'}\n`);

  const byType = {};
  for (const f of fields) byType[f.type] = (byType[f.type] ?? 0) + 1;
  console.log('FIELD TYPES');
  for (const [k, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${k}`);
  }

  const withGeometry = fields.filter((f) => f.geometry || f.sourcePosition).length;
  console.log(`\nPLACEMENT: ${withGeometry}/${fields.length} fields carry geometry or a source position.`);
  reportPlacementWork(fields);

  const headers = fields.filter((f) => f.type === 'section_header');
  console.log(`\nSECTION HEADERS (${headers.length})`);
  for (const h of headers) console.log(`  ${h.id}  "${clip(h.label)}"`);
  if (!headers.length) console.log('  (none — part boundaries cannot be anchored to headers)');

  const CHOICE = new Set(['checkbox_group', 'radio', 'dropdown', 'boolean_yes_no']);
  const choices = fields.filter((f) => CHOICE.has(f.type));
  console.log(`\nCHOICE FIELDS (${choices.length}) — candidate theory questions`);
  choices.forEach((f, n) => {
    console.log(`  [${String(n + 1).padStart(2)}] ${f.id}  (${f.type}, ${f.options?.length ?? 0} opts)  "${clip(f.label, 66)}"`);
    if (f.options?.length) console.log(`        opts: ${f.options.map((o) => clip(o, 28)).join(' | ')}`);
  });

  const tables = fields.filter((f) => f.type === 'repeating_group');
  console.log(`\nREPEATING TABLES (${tables.length})`);
  for (const tb of tables) {
    console.log(`  ${tb.id}  "${clip(tb.label)}"  rows=${tb.fixedRows?.length ?? 'open'}`);
    console.log(`     cols: ${(tb.columns ?? []).map((c) => `${c.key}("${clip(c.label, 20)}")`).join(', ') || '(none)'}`);
  }

  const checks = fields.filter((f) => f.type === 'check_cross');
  console.log(`\nCHECK/CROSS FIELDS (${checks.length}) — candidate outcome cells`);
  for (const c of checks) console.log(`  ${c.id}  "${clip(c.label)}"`);

  if (FULL) {
    console.log('\nALL FIELDS IN ORDER');
    fields.forEach((f, n) => {
      console.log(`  ${String(n + 1).padStart(3)}. ${f.type.padEnd(16)} ${f.id.padEnd(14)} "${clip(f.label, 60)}"`);
    });
  } else {
    console.log('\n(Re-run with --full for the complete ordered field list.)');
  }

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
