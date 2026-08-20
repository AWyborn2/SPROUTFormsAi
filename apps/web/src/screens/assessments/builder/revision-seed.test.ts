/**
 * The revision seed — what "start revision" hands the builder.
 *
 * Field-id preservation is the whole point (R3): the manifest, the keys and
 * every stored attempt are keyed to the published version's ids, so the seed
 * copies them verbatim. Verification carries only where an answer is
 * unchanged (R15) — the attestation is "the authority confirmed THESE
 * answers", never a blanket blessing. And without a surviving build draft the
 * reconstruction must reproduce the tool's own part keys, because attempts
 * and Location rules reference them.
 */
import { describe, expect, it } from 'vitest';
import type { AssessmentToolManifest, FormField } from '@formai/shared';
import { revisionDraftName, seedRevisionSnapshot } from './revision-seed.js';
import { toDraftState } from './builder-draft-state.js';

const header = (id: string, label: string): FormField => ({
  id,
  type: 'section_header',
  label,
  required: false,
  source: 'imported',
});

const question = (id: string, answerKey?: string[]): FormField => ({
  id,
  type: 'checkbox_group',
  label: `Question ${id}`,
  required: true,
  source: 'imported',
  options: ['a', 'b'],
  ...(answerKey ? { answerKey } : {}),
  geometry: { segments: [{ page: 0, x: 10, y: 10, width: 20, height: 8, pageWidth: 595, pageHeight: 842 }] },
});

const FIELDS: FormField[] = [
  { id: 'cover-name', type: 'text', label: 'Candidate name', required: false, source: 'imported' },
  header('h1', 'Part 1 Theory'),
  question('q1', ['a']),
  question('q2', ['b']),
  header('h2', 'Part 2 Practical'),
  question('q3'),
];

const MANIFEST: AssessmentToolManifest = {
  parts: [
    {
      key: 'sec_h1',
      ordinal: 1,
      label: 'Part 1 Theory',
      kind: 'theory',
      pathways: ['new'],
      startFieldId: 'h1',
    },
    {
      key: 'sec_h2',
      ordinal: 2,
      label: 'Part 2 Practical',
      kind: 'practical',
      pathways: ['new', 'experienced'],
      startFieldId: 'h2',
    },
  ],
};

const TOOL = { id: 'tool-1', templateId: 'form-1', name: 'Mine Site SME Theory', manifest: MANIFEST };
const VERSION = { id: 'v1-id', label: 'v1', fields: FIELDS, sourcePdfAssetId: 'asset-9' };

describe('seedRevisionSnapshot', () => {
  it('copies the published fields verbatim — ids, geometry and keys included', () => {
    const snap = seedRevisionSnapshot({ tool: TOOL, version: VERSION });

    expect(snap.fields.map((f) => f.id)).toEqual(FIELDS.map((f) => f.id));
    expect(snap.fields.find((f) => f.id === 'q1')?.geometry).toEqual(
      FIELDS.find((f) => f.id === 'q1')?.geometry,
    );
    expect(snap.keys.map((k) => [k.fieldId, k.answerKey])).toEqual([
      ['q1', ['a']],
      ['q2', ['b']],
    ]);
    expect(snap.revisionOfToolId).toBe('tool-1');
    expect(snap.seededFromVersionId).toBe('v1-id');
    expect(snap.formId).toBe('form-1');
    expect(snap.versionId).toBeUndefined();
    expect(snap.assetId).toBe('asset-9');
    expect(snap.seedAssetId).toBe('asset-9');
  });

  it('reconstructs structure whose derived part keys ARE the manifest part keys', () => {
    const snap = seedRevisionSnapshot({ tool: TOOL, version: VERSION });

    const keys = snap.structure.map((s) => s.key);
    // Cover fields before the first anchor land in a cover section (emits no
    // part); every other section keys exactly as the published manifest does.
    expect(keys).toEqual(['cover_lead', 'sec_h1', 'sec_h2']);
    expect(snap.partOrder).toEqual(['sec_h1', 'sec_h2']);
    // Stored part facts pin the derivation — pathways survive the seed.
    expect(snap.partOverrides['sec_h2']).toMatchObject({ pathways: ['new', 'experienced'] });
  });

  it('R15: verification carries for an unchanged answer and clears for a changed one', () => {
    const priorDraftState = toDraftState({
      fileName: 'Mine Site SME Theory',
      extraction: null,
      fields: FIELDS,
      structure: [],
      groupCount: 1,
      setup: { pathways: ['new'] } as never,
      excluded: new Set<string>(),
      keys: [
        // Same answer as the published version — the attestation carries.
        { fieldId: 'q1', answerKey: ['a'], source: 'manual', verifiedBy: 'T. Authority', verifiedAt: '2026-06-01' },
        // The published version says ['b']; this record says ['a'] — a
        // changed answer is nobody's attestation.
        { fieldId: 'q2', answerKey: ['a'], source: 'manual', verifiedBy: 'T. Authority', verifiedAt: '2026-06-01' },
      ],
      partOverrides: {},
      partOrder: [],
      formId: 'form-1',
    });

    const snap = seedRevisionSnapshot({ tool: TOOL, version: VERSION, priorDraftState });

    const q1 = snap.keys.find((k) => k.fieldId === 'q1');
    const q2 = snap.keys.find((k) => k.fieldId === 'q2');
    expect(q1?.verifiedBy).toBe('T. Authority');
    expect(q2?.verifiedBy).toBeUndefined();
  });

  it('ignores a surviving draft that belongs to a different form', () => {
    const priorDraftState = toDraftState({
      fileName: 'Some other tool',
      extraction: null,
      fields: [],
      structure: [{ key: 'sec_x', label: 'X', cols: 1, fields: [] }],
      groupCount: 5,
      setup: { pathways: ['new'] } as never,
      excluded: new Set<string>(),
      keys: [
        { fieldId: 'q1', answerKey: ['a'], source: 'manual', verifiedBy: 'Wrong Draft', verifiedAt: '2026-01-01' },
      ],
      partOverrides: {},
      partOrder: [],
      formId: 'some-other-form',
    });

    const snap = seedRevisionSnapshot({ tool: TOOL, version: VERSION, priorDraftState });

    // Reconstruction, not donation: keys unverified, structure from manifest.
    expect(snap.keys.find((k) => k.fieldId === 'q1')?.verifiedBy).toBeUndefined();
    expect(snap.structure.map((s) => s.key)).toEqual(['cover_lead', 'sec_h1', 'sec_h2']);
  });

  it('names the revision draft distinctly from the build draft', () => {
    // The upsert key is (org, name): the build draft is named after the tool,
    // so a same-named revision would silently overwrite it.
    expect(revisionDraftName(TOOL, VERSION)).toBe('Mine Site SME Theory — revision of v1');
  });
});

/**
 * WRITTEN questions across a revision — model answers are keys too.
 *
 * The builder's Answer Key step reads model answers from the DRAFT KEYS, so a
 * seed that left them only on the fields would open the revision showing every
 * written question unguided while republishing the old guides underneath. And
 * the R15 rule extends naturally: a written key's answer IS its prose, so the
 * attestation carries exactly when the prose is unchanged.
 */
describe('seedRevisionSnapshot — written questions with model answers', () => {
  const writtenField = (id: string, modelAnswer?: string): FormField => ({
    id,
    type: 'textarea',
    label: `Explain ${id}`,
    required: false,
    source: 'imported',
    ...(modelAnswer ? { modelAnswer } : {}),
  });

  const MIXED_FIELDS: FormField[] = [
    header('h1', 'Part 1 Theory'),
    question('q1', ['a']),
    writtenField('w1', 'The expected prose'),
    writtenField('w2'),
  ];
  const VERSION_W = { id: 'v2-id', label: 'v2', fields: MIXED_FIELDS, sourcePdfAssetId: null };

  it('re-seeds a published model answer as a written draft key row', () => {
    const snap = seedRevisionSnapshot({ tool: TOOL, version: VERSION_W });

    expect(snap.keys).toContainEqual({
      fieldId: 'w1',
      answerKey: [],
      modelAnswer: 'The expected prose',
      source: 'manual',
    });
    // An unguided written question seeds NO row — the guide is opt-in, and an
    // empty row would report it guided.
    expect(snap.keys.some((k) => k.fieldId === 'w2')).toBe(false);
  });

  it('carries the attestation for unchanged model text, and clears it for edited text', () => {
    const priorDraftState = toDraftState({
      fileName: 'Mine Site SME Theory',
      extraction: null,
      fields: MIXED_FIELDS,
      structure: [],
      groupCount: 1,
      setup: { pathways: ['new'] } as never,
      excluded: new Set<string>(),
      keys: [
        // Same prose as published — the attestation carries.
        {
          fieldId: 'w1',
          answerKey: [],
          modelAnswer: 'The expected prose',
          source: 'manual',
          verifiedBy: 'T. Authority',
          verifiedAt: '2026-08-01',
        },
        // The published key's answer set is unchanged but this pins the
        // choice path still carries beside the written one.
        { fieldId: 'q1', answerKey: ['a'], source: 'manual', verifiedBy: 'T. Authority', verifiedAt: '2026-08-01' },
      ],
      partOverrides: {},
      partOrder: [],
      formId: 'form-1',
    });

    const snap = seedRevisionSnapshot({ tool: TOOL, version: VERSION_W, priorDraftState });
    expect(snap.keys.find((k) => k.fieldId === 'w1')?.verifiedBy).toBe('T. Authority');
    expect(snap.keys.find((k) => k.fieldId === 'q1')?.verifiedBy).toBe('T. Authority');

    // Now the published prose differs from what was attested — nobody's
    // attestation.
    const editedVersion = {
      ...VERSION_W,
      fields: MIXED_FIELDS.map((f) =>
        f.id === 'w1' ? { ...f, modelAnswer: 'Different prose entirely' } : f,
      ),
    };
    const edited = seedRevisionSnapshot({ tool: TOOL, version: editedVersion, priorDraftState });
    expect(edited.keys.find((k) => k.fieldId === 'w1')?.verifiedBy).toBeUndefined();
  });
});
