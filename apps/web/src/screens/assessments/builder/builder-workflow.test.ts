/**
 * The published workflow mirrors the author's structure — the fix for the
 * editor opening on four merged cards instead of the seven sections built.
 *
 * Nothing wrote `manifest.workflow`, so the editor synthesised one section per
 * printed part; a part is a CONTIGUOUS slice, so everything printed between
 * two anchors (signature, Prerequisites, More Coaching Required) was swallowed
 * by the declaration card, and Candidate Details — before the first anchor —
 * had no card at all.
 */
import { describe, expect, it } from 'vitest';
import type { AssessmentToolManifest, BuilderStructure, FormField } from '@formai/shared';
import { canWrite, partFieldAccess, sectionCoveringField } from '@formai/shared';
import { workflowFromStructure } from './builder-workflow.js';
import type { DerivedPart } from './builder-manifest.js';

const field = (id: string, type: FormField['type'] = 'text'): FormField => ({
  id,
  type,
  label: id,
  required: false,
  source: 'imported',
});

// The real shape in miniature: details (no part), theory (a part), and a
// declaration part whose printed slice CONTAINS the prerequisites field.
const fields = [
  field('name'),
  field('swipe'),
  // As published: `resolvePublishFields` writes each question's outcomeTarget,
  // and that declaration is what autoSourcesFor locks the cell through.
  { ...field('q1', 'checkbox_group'), answerKey: ['a'], outcomeTarget: { fieldId: 'q1-out' } },
  field('q1-out', 'check_cross'),
  field('sig', 'signature'),
  field('prereq', 'check_cross'),
];

const structure: BuilderStructure = [
  { key: 'details', label: 'Candidate Details', cols: 1, fields: [{ id: 'name' }, { id: 'swipe' }] },
  { key: 'theory', label: 'Theory', cols: 1, fields: [{ id: 'q1' }, { id: 'q1-out' }] },
  { key: 'decl', label: 'Candidate declaration', cols: 1, fields: [{ id: 'sig' }] },
  { key: 'prereqs', label: 'Prerequisites', cols: 1, fields: [{ id: 'prereq' }] },
] as BuilderStructure;

const parts: DerivedPart[] = [
  { key: 'p_theory', sectionKey: 'theory', ordinal: 1, label: 'Theory', kind: 'theory', pathways: ['new'], startFieldId: 'q1' },
  { key: 'p_decl', sectionKey: 'decl', ordinal: 2, label: 'Candidate declaration', kind: 'practical', pathways: ['new'], startFieldId: 'sig' },
] as unknown as DerivedPart[];

const manifest: AssessmentToolManifest = {
  parts: parts.map(({ sectionKey: _s, ...p }) => p) as AssessmentToolManifest['parts'],
  profilePrefill: { name: 'candidate_name', swipe: 'swipe_card' },
};

const workflow = workflowFromStructure(structure, parts, manifest, fields);

describe('workflowFromStructure', () => {
  it('emits one section per structure section, in the author’s order', () => {
    expect(workflow.sections.map((s) => s.label)).toEqual([
      'Candidate Details',
      'Theory',
      'Candidate declaration',
      'Prerequisites',
    ]);
    expect(workflow.sections.map((s) => s.ordinal)).toEqual([1, 2, 3, 4]);
  });

  it('ties a section that became a part to its partKey', () => {
    expect(workflow.sections.find((s) => s.key === 'theory')?.partKey).toBe('p_theory');
  });

  it('gives a cover section its fields directly', () => {
    expect(workflow.sections.find((s) => s.key === 'details')?.fieldIds).toEqual([
      'name',
      'swipe',
    ]);
  });

  it('locks the outcome cells — a stored workflow bypasses the derived default', () => {
    /*
      `workflowOf` returns a stored workflow VERBATIM, so an emission that
      forgot fieldSource would reopen the candidate-marks-themselves hole the
      synthesised default closes. The ✓/✗ cell must come out auto-locked.
    */
    const theory = workflow.sections.find((s) => s.key === 'theory')!;

    expect(canWrite(theory, 'q1-out', 'candidate')).toBe(false);
    expect(canWrite(theory, 'q1', 'candidate')).toBe(true);
  });

  it('locks profile-mapped fields in a cover section', () => {
    const details = workflow.sections.find((s) => s.key === 'details')!;

    expect(canWrite(details, 'name', 'candidate')).toBe(false);
    expect(canWrite(details, 'swipe', 'assessor')).toBe(false);
  });

  it('drops excluded fields rather than referencing ids the version lacks', () => {
    const w = workflowFromStructure(structure, parts, manifest, fields.slice(0, 2));

    expect(w.sections.find((s) => s.key === 'details')?.fieldIds).toEqual(['name', 'swipe']);
    expect(w.sections.find((s) => s.key === 'prereqs')?.fieldIds).toEqual([]);
  });
});

describe('coverage-aware enforcement', () => {
  it('a fieldIds section governs its field inside another part’s slice', () => {
    /*
      THE POINT OF THE WHOLE CHANGE. `prereq` prints inside the declaration
      part's contiguous slice; the author put it in its own section and set
      that section assessor-only. Slice-based resolution would let the
      declaration section govern it and the author's choice would be
      furniture.
    */
    const authored = structuredClone(workflow);
    authored.sections.find((s) => s.key === 'prereqs')!.access = { assessor: 'fill' };

    const covering = sectionCoveringField(authored, 'prereq', 'p_decl');
    expect(covering?.key).toBe('prereqs');

    const declFields = [field('sig', 'signature'), field('prereq', 'check_cross')];
    const candidate = partFieldAccess(authored, 'p_decl', declFields, 'candidate');

    expect(candidate.writable).toEqual(['sig']);
    expect(candidate.hidden).toEqual(['prereq']);
  });

  it('falls back to the part’s section for unclaimed fields', () => {
    expect(sectionCoveringField(workflow, 'sig', 'p_decl')?.key).toBe('decl');
  });
});
