// @vitest-environment jsdom
/**
 * Step 5 — the answer key.
 *
 * The rules this step is built on are tested where they live: exact-set marking
 * in `marking.test.ts`, the matching model in `matching.test.ts`, the pair
 * builder in `PairBuilder.test.tsx`. What is left here is the three things this
 * step alone decides, each of which is a way to mark a candidate wrong on a
 * question they answered correctly:
 *
 *   · whether a question REPLACES or ACCUMULATES its key,
 *   · what happens to a key when the question's type changes underneath it,
 *   · what happens to an attestation when the answers it attested to change.
 *
 * The hook is driven through a real `ingest` against a mocked API rather than
 * by handing the component a fabricated state object. The key operations write
 * to `fields` as well as to `keys`, so a harness that supplied fields as a prop
 * would assert against a copy the reducers never touched — and would pass with
 * the reducers broken.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ExtractedField } from '@formai/shared';
import { AnswerKeyStep } from './AnswerKeyStep.js';
import { useBuilderDraftState, type BuilderDraftState } from '../use-builder-draft.js';

vi.mock('@formai/ui', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

const post = vi.fn();
vi.mock('../../../../lib/data/api-client.js', () => ({
  apiClient: { post: (...args: unknown[]) => post(...args) },
  ApiError: class ApiError extends Error {
    status = 0;
    body: unknown = {};
  },
  uploadAttachment: vi.fn(),
}));

vi.mock('../../../../lib/data/import-session.js', () => ({
  fileToBase64: () => Promise.resolve('JVBERi0='),
  IMPORT_REQUEST_TIMEOUT_MS: 1000,
}));

function field(over: Partial<ExtractedField> & { id: string }): ExtractedField {
  return {
    label: over.id,
    type: 'radio',
    confidence: 0.9,
    options: ['a', 'b', 'c'],
    ...over,
  };
}

/**
 * A hook holding the given extracted fields, via the real ingest path.
 */
async function draftOf(fields: ExtractedField[]) {
  post.mockReset();
  post.mockResolvedValueOnce({ assetId: 'asset-1' }).mockResolvedValueOnce({
    sourceType: 'pdf_import',
    path: 'ai',
    fileName: 'assessment.pdf',
    pageCount: 3,
    fields,
    designNotes: [],
  });

  const { result } = renderHook(() => useBuilderDraftState());
  await act(async () => {
    await result.current.ingest(new File(['x'], 'assessment.pdf', { type: 'application/pdf' }));
  });
  return result;
}

/** Render the step against live hook state. */
function renderStep(result: { current: BuilderDraftState }) {
  function Harness() {
    return <AnswerKeyStep draft={result.current} actor="Training authority" />;
  }
  return render(<Harness />);
}

beforeEach(() => {
  post.mockReset();
});

describe('AnswerKeyStep', () => {
  it('keys a single-answer question by REPLACING, never accumulating', async () => {
    /*
      Marking is an exact set. On a one-answer question an accumulated second
      option fails every candidate who answers it correctly — so the difference
      between replace and accumulate is a correctness matter, not a UI nicety.
    */
    const result = await draftOf([field({ id: 'q1' })]);

    act(() => result.current.keyOps.toggleOption('q1', 'a', false));
    expect(result.current.keys[0]?.answerKey).toEqual(['a']);

    act(() => result.current.keyOps.toggleOption('q1', 'b', false));
    expect(result.current.keys[0]?.answerKey).toEqual(['b']);
  });

  it('accumulates a set on a several-answers question', async () => {
    const result = await draftOf([
      field({ id: 'q1', type: 'checkbox_group', selectionType: 'multiple' }),
    ]);

    act(() => result.current.keyOps.toggleOption('q1', 'a', true));
    act(() => result.current.keyOps.toggleOption('q1', 'c', true));

    expect(result.current.keys[0]?.answerKey).toEqual(['a', 'c']);
  });

  it('removes the entry entirely when the last option is unticked', async () => {
    // markTheory skips a field whose answerKey is absent OR empty, so both mean
    // "not auto-marked" — keeping an empty entry would let the UI report a
    // question as keyed that contributes no mark.
    const result = await draftOf([field({ id: 'q1' })]);

    act(() => result.current.keyOps.toggleOption('q1', 'a', false));
    expect(result.current.keys).toHaveLength(1);

    act(() => result.current.keyOps.toggleOption('q1', 'a', false));
    expect(result.current.keys).toHaveLength(0);
  });

  it('clears a question’s key when its type changes underneath it', async () => {
    /*
      THE SILENT ONE. An answer key is a list of option VALUES, and retyping
      reseeds or strips options. A key carried across that change names options
      the question no longer offers — and a stale key looks exactly like a
      current one.
    */
    const result = await draftOf([field({ id: 'q1' })]);

    act(() => result.current.keyOps.toggleOption('q1', 'a', false));
    expect(result.current.keys).toHaveLength(1);

    act(() => result.current.structureOps.setFieldType('q1', 'boolean_yes_no'));
    expect(result.current.keys).toHaveLength(0);
  });

  it('withdraws verification when the answers it attested to change', async () => {
    /*
      The attestation is "the training authority confirmed THESE answers".
      Carrying it onto a different set would let a key nobody has checked report
      itself as verified on a safety-critical assessment.
    */
    const result = await draftOf([field({ id: 'q1' })]);

    act(() => result.current.keyOps.setKey('q1', ['a']));
    act(() => result.current.keyOps.setVerified('q1', true, 'Training authority'));
    expect(result.current.keys[0]?.verifiedBy).toBe('Training authority');

    act(() => result.current.keyOps.setKey('q1', ['b']));
    expect(result.current.keys[0]?.verifiedBy).toBeUndefined();
    expect(result.current.keys[0]?.verifiedAt).toBeUndefined();
  });

  it('keeps verification when the same key is re-set in a different order', async () => {
    // Re-setting an identical set is not a change of answer, and dropping the
    // attestation for it would train an author to ignore the flag.
    const result = await draftOf([
      field({ id: 'q1', type: 'checkbox_group', selectionType: 'multiple' }),
    ]);

    act(() => result.current.keyOps.setKey('q1', ['a', 'c']));
    act(() => result.current.keyOps.setVerified('q1', true, 'Training authority'));
    act(() => result.current.keyOps.setKey('q1', ['c', 'a']));

    expect(result.current.keys[0]?.verifiedBy).toBe('Training authority');
  });

  it('drops both halves of the attestation when it is withdrawn', async () => {
    // A verifiedAt with nobody attached is a timestamp nobody stands behind.
    const result = await draftOf([field({ id: 'q1' })]);

    act(() => result.current.keyOps.setKey('q1', ['a']));
    act(() => result.current.keyOps.setVerified('q1', true, 'Training authority'));
    act(() => result.current.keyOps.setVerified('q1', false, 'Training authority'));

    expect(result.current.keys[0]?.verifiedBy).toBeUndefined();
    expect(result.current.keys[0]?.verifiedAt).toBeUndefined();
  });

  it('writes a matching question’s options onto the field and its key into the draft', async () => {
    const result = await draftOf([field({ id: 'q1' })]);

    act(() =>
      result.current.keyOps.saveMatching(
        'q1',
        { options: ['L -> R', 'L -> S'], answerKey: ['L -> R'] },
        { mode: 'line' },
      ),
    );

    const saved = result.current.fields.find((f) => f.id === 'q1');
    expect(saved?.type).toBe('checkbox_group');
    expect(saved?.selectionType).toBe('multiple');
    expect(saved?.options).toEqual(['L -> R', 'L -> S']);
    expect(saved?.matchPresentation).toEqual({ mode: 'line' });
    expect(result.current.keys[0]?.answerKey).toEqual(['L -> R']);
  });

  it('ticking an option in the rendered list keys the question', async () => {
    const result = await draftOf([field({ id: 'q1', label: 'Minimum clearance?' })]);
    renderStep(result);

    fireEvent.click(screen.getByRole('checkbox', { name: 'a is correct' }));

    expect(result.current.keys[0]).toMatchObject({ fieldId: 'q1', answerKey: ['a'] });
  });

  it('shows the printed question reference where extraction read one', async () => {
    // questionRef is what pairs a question with its outcome box; showing it is
    // what lets an author check a key against the paper rather than against a
    // position in a list.
    const result = await draftOf([field({ id: 'q1', questionRef: 'BBM Q3' })]);
    renderStep(result);

    expect(screen.getByText('BBM Q3')).toBeTruthy();
  });

  it('reports progress against the number of keyable questions', async () => {
    const result = await draftOf([field({ id: 'q1' }), field({ id: 'q2' }), field({ id: 'q3' })]);
    renderStep(result);

    expect(screen.getByRole('progressbar').getAttribute('aria-valuemax')).toBe('3');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
  });

  it('says so rather than rendering an empty list when nothing is keyable', async () => {
    // A text field is now a WRITTEN question (it takes a model answer), so
    // this fixture uses only types that are neither choice nor written.
    const result = await draftOf([
      field({ id: 'sig', type: 'signature', options: undefined }),
      field({ id: 'when', type: 'date', options: undefined }),
    ]);
    renderStep(result);

    expect(screen.getByText(/No keyable questions were found/)).toBeTruthy();
  });
});

/**
 * Matching questions reaching the step that configures them.
 *
 * The extraction tool schema tells the model, for a matching question, to
 * "leave options empty: the pairings are derived from the two sides". Filtering
 * this step's list on `options.length > 0` therefore dropped every matching
 * question the extractor actually found — so step 1 counted them and step 5
 * offered nowhere to open one. The pair builder, and the picture upload inside
 * it, were reachable only from ordinary multiple-choice questions: from every
 * question except the ones the feature exists for.
 */
describe('AnswerKeyStep — matching questions the extraction found', () => {
  /** As the extractor emits one: two printed sides, and NO options. */
  function matchingField(over: Partial<ExtractedField> = {}) {
    return field({
      id: 'm1',
      label: 'Match each sign to its meaning',
      type: 'text',
      options: undefined,
      matchLeft: ['Red triangle', 'Blue circle'],
      matchRight: ['Give way', 'Mandatory instruction'],
      ...over,
    });
  }

  it('LISTS A MATCHING QUESTION THAT HAS NO OPTIONS', async () => {
    // The whole defect in one assertion: by contract it has no options, and
    // options were the only way onto this screen.
    const result = await draftOf([matchingField()]);
    renderStep(result);
    expect(screen.getByText('Match each sign to its meaning')).toBeTruthy();
  });

  it('offers the pair builder for it', async () => {
    // "Build pairs", not "Edit pairs": nothing has been paired yet, and
    // inviting the author to edit what is not there is how a step reads as
    // broken.
    const result = await draftOf([matchingField()]);
    renderStep(result);
    expect(screen.getByText('Build pairs')).toBeTruthy();
  });

  it('opens the pair builder, which is where pictures are uploaded', async () => {
    // `ImageSlot` lives inside `PairBuilder`. No route to the builder is no
    // route to the upload, which is why "can't configure it" and "can't upload
    // images" were one bug.
    const result = await draftOf([matchingField()]);
    renderStep(result);
    fireEvent.click(screen.getByText('Build pairs'));
    expect(screen.getByText('Close pairs')).toBeTruthy();
  });

  it('calls it Matching, not “One answer”', async () => {
    // Reading only `isMatchingQuestion(options)` left a freshly-extracted
    // matching question labelled as a one-answer question.
    const result = await draftOf([matchingField()]);
    renderStep(result);
    expect(screen.getByText(/Matching/)).toBeTruthy();
  });

  it('does not offer a type dropdown that cannot express it', async () => {
    const result = await draftOf([matchingField()]);
    renderStep(result);
    expect(screen.queryByLabelText(/^Question type for/)).toBeNull();
  });

  it('INCLUDES A ONE-SIDED READ, which is what the author is there to finish', async () => {
    // Step 1 already counts these as `matchesIncomplete`. Requiring both sides
    // would hide exactly the questions that need a person.
    const result = await draftOf([matchingField({ matchRight: undefined })]);
    renderStep(result);
    expect(screen.getByText('Build pairs')).toBeTruthy();
    expect(screen.getByText(/Only one side/)).toBeTruthy();
  });

  it('says both sides were read, rather than showing an empty answer row', async () => {
    // An empty chip row reads as "this question has no answers", which is a
    // different statement from "the pairs are not built yet".
    const result = await draftOf([matchingField()]);
    renderStep(result);
    expect(screen.getByText(/Both sides were read — 2 prompts and 2 answers/)).toBeTruthy();
  });

  it('still leaves an ordinary question alone', async () => {
    // The widened filter must not change what was already correct.
    const result = await draftOf([field({ id: 'q1', label: 'Ordinary question' })]);
    renderStep(result);
    expect(screen.getByText('Ordinary question')).toBeTruthy();
    expect(screen.getByLabelText('Question type for Ordinary question')).toBeTruthy();
    // Still offered the conversion, which is the state this button had before.
    expect(screen.getByText('Make matching')).toBeTruthy();
  });

  it('still hides a matching question the author excluded', async () => {
    // Excluded means off the digital form, for a matching question as much as
    // for any other.
    const result = await draftOf([matchingField()]);
    act(() => result.current.toggleExcluded('m1'));
    renderStep(result);
    expect(screen.queryByText('Match each sign to its meaning')).toBeNull();
  });

  it('offers an escape hatch that turns a FALSE-matching read into a keyable question', async () => {
    /*
      The reverse of the defect above: extraction false-read an ordinary
      multiple-choice as matching, which hid every keying control and stuck the
      field in the pair builder. The hatch turns it back into a one-answer
      question and recovers the choices from the prompt side the extraction read
      — on a mis-read multiple-choice, that side IS the option list.
    */
    const result = await draftOf([matchingField()]);
    renderStep(result);

    fireEvent.click(screen.getByText('Not matching'));

    const q = result.current.fields.find((f) => f.id === 'm1')!;
    expect(q.notMatching).toBe(true);
    expect(q.type).toBe('radio');
    expect(q.options).toEqual(['Red triangle', 'Blue circle']);
  });

  it('offers no un-matching hatch on an ordinary question', async () => {
    // Nothing to escape from — the field was never treated as matching.
    const result = await draftOf([field({ id: 'q1', label: 'Ordinary question' })]);
    renderStep(result);
    expect(screen.queryByText('Not matching')).toBeNull();
  });

  it('leaves matching mode once a field is flagged not-matching', async () => {
    /*
      Proof the flag defeats BOTH match signals: the extraction's two sides no
      longer force matching mode. The field is still `text` here (the flag was
      patched directly, without the button's retype), so it renders as a
      WRITTEN question — the real recovery path is the "Not matching" button
      above, which retypes to radio and restores the choice controls.
    */
    const result = await draftOf([matchingField()]);
    act(() => result.current.fieldOps.patch('m1', { notMatching: true }));
    renderStep(result);
    expect(screen.getByLabelText('Model answer for Match each sign to its meaning')).toBeTruthy();
    expect(screen.queryByText('Not matching')).toBeNull();
    expect(screen.queryByText('Build pairs')).toBeNull();
  });
});

/**
 * An assessor's VERDICT is not a question.
 *
 * "Assessment Result — Candidate Competent / Candidate not yet Competent",
 * "More coaching required? Yes / No", "The Candidate's responses were:
 * Satisfactory / Not Satisfactory". An assessment paper is full of these, and
 * extraction reads each as an ordinary choice question because on the page that
 * is exactly what it is: a prompt with two printed options.
 *
 * Without a way to say so they sit in this list forever. There is no correct
 * answer to key, so the author cannot clear them, "N of 33 keyed" can never
 * complete, and a genuinely unkeyed question hides among a dozen that were
 * never keyable.
 */
describe('AnswerKeyStep — assessor verdicts', () => {
  const VERDICT = field({
    id: 'result',
    label: 'Assessment Result',
    options: ['Candidate not yet Competent', 'Candidate Competent'],
  });
  const QUESTION = field({ id: 'q1', label: 'A real question' });

  it('offers the escape hatch on every ordinary question', async () => {
    // Extraction cannot tell a verdict from a question — they look identical on
    // the page. The author can, in one click.
    const result = await draftOf([VERDICT, QUESTION]);
    renderStep(result);
    expect(screen.getByLabelText('Assessment Result is an assessor verdict')).toBeTruthy();
  });

  it('TAKES A VERDICT OUT OF THE KEYED DENOMINATOR', async () => {
    // The counter is the author's answer to "am I finished". Counting a field
    // that can never be keyed makes it permanently wrong.
    // Rendered twice rather than asserting a live update: the hook lives in
    // its own `renderHook` root, so the step does not re-render when the draft
    // changes underneath it. Two renders is what this harness can honestly show.
    const result = await draftOf([VERDICT, QUESTION]);
    const first = renderStep(result);
    expect(screen.getByText(/0 of 2 keyed/)).toBeTruthy();
    first.unmount();

    act(() => result.current.keyOps.setAssessorVerdict('result', true));
    renderStep(result);
    expect(screen.getByText(/0 of 1 keyed/)).toBeTruthy();
  });

  it('KEEPS THE PRINTED LABELS, which is why this is not a type change', async () => {
    /*
      Retyping to `check_cross` would drop these and put a bare ✓/✗ where the
      paper says "Candidate Competent" — the online form would stop matching the
      document at the cell an auditor reads first.
    */
    const result = await draftOf([VERDICT]);
    act(() => result.current.keyOps.setAssessorVerdict('result', true));
    renderStep(result);
    expect(screen.getByText('Candidate Competent')).toBeTruthy();
    expect(screen.getByText('Candidate not yet Competent')).toBeTruthy();
  });

  it('says plainly that there is nothing to key', async () => {
    const result = await draftOf([VERDICT]);
    act(() => result.current.keyOps.setAssessorVerdict('result', true));
    renderStep(result);
    expect(screen.getByText(/the assessor chooses on the day/i)).toBeTruthy();
  });

  it('CLEARS A KEY THE FIELD ALREADY HAD', async () => {
    /*
      A verdict carrying an answer key is a contradiction, and `markTheory`
      reads the key and nothing else — so a leftover one would quietly GRADE a
      judgement, marking an assessor wrong for their own verdict.
    */
    const result = await draftOf([VERDICT]);
    act(() => result.current.keyOps.setKey('result', ['Candidate Competent']));
    expect(result.current.keys).toHaveLength(1);

    act(() => result.current.keyOps.setAssessorVerdict('result', true));
    expect(result.current.keys).toHaveLength(0);
    expect(result.current.fields.find((f) => f.id === 'result')?.answerKey).toBeUndefined();
  });

  it('offers no type dropdown and no matching button on a verdict', async () => {
    // Neither expresses anything about a judgement, and both invite an edit
    // that would turn it back into a question.
    const result = await draftOf([VERDICT]);
    act(() => result.current.keyOps.setAssessorVerdict('result', true));
    renderStep(result);
    expect(screen.queryByLabelText('Question type for Assessment Result')).toBeNull();
    expect(screen.queryByText('Make matching')).toBeNull();
  });

  it('turns back into a keyable question when unticked', async () => {
    // A mis-click has to be reversible, and the flag is removed rather than
    // stored as false — absent is what every field authored before this carries.
    const result = await draftOf([VERDICT]);
    act(() => result.current.keyOps.setAssessorVerdict('result', true));
    act(() => result.current.keyOps.setAssessorVerdict('result', false));
    expect(result.current.fields.find((f) => f.id === 'result')).not.toHaveProperty(
      'assessorVerdict',
    );
    renderStep(result);
    expect(screen.getByLabelText('Question type for Assessment Result')).toBeTruthy();
  });
});

/**
 * WRITTEN questions — model answers authored where every other answer is.
 *
 * A written (`text`/`textarea`) question used to be invisible to this step:
 * nowhere to record the expected answer, so the assessor marked against a
 * JSON file kept outside the product. The card gives it exactly the controls
 * that mean the same thing on both kinds — a model answer instead of a key,
 * the same attestation, the same mark destination — and none of the ones that
 * do not: no type dropdown, no quiz hint, no matching conversion.
 */
describe('AnswerKeyStep — written questions with model answers', () => {
  const WRITTEN = field({
    id: 'w1',
    label: 'Explain the tip head exclusion zone',
    type: 'textarea',
    options: undefined,
  });

  it('LISTS A WRITTEN QUESTION and offers the model-answer textarea', async () => {
    const result = await draftOf([WRITTEN]);
    renderStep(result);

    expect(screen.getByText('Explain the tip head exclusion zone')).toBeTruthy();
    expect(
      screen.getByLabelText('Model answer for Explain the tip head exclusion zone'),
    ).toBeTruthy();
  });

  it('offers no type dropdown, no hint and no matching button on a written card', async () => {
    // None of the three says anything true about prose: retyping is not an
    // answer-key decision, hints belong to the quiz written questions never
    // enter, and matching would invent options.
    const result = await draftOf([WRITTEN]);
    act(() => result.current.keyOps.setModelAnswer('w1', 'A model answer'));
    renderStep(result);

    expect(screen.queryByLabelText(/^Question type for/)).toBeNull();
    expect(screen.queryByText('Make matching')).toBeNull();
    expect(screen.queryByText(/Hint when incorrect/)).toBeNull();
  });

  it('typing into the textarea writes a written key row', async () => {
    const result = await draftOf([WRITTEN]);
    renderStep(result);

    fireEvent.change(
      screen.getByLabelText('Model answer for Explain the tip head exclusion zone'),
      { target: { value: 'Nobody inside the zone while tipping.' } },
    );

    expect(result.current.keys[0]).toEqual({
      fieldId: 'w1',
      answerKey: [],
      modelAnswer: 'Nobody inside the zone while tipping.',
      source: 'manual',
    });
  });

  it('offers the attestation once a model answer exists — a written key row is attestable', async () => {
    const result = await draftOf([WRITTEN]);
    act(() => result.current.keyOps.setModelAnswer('w1', 'A model answer'));
    renderStep(result);

    expect(screen.getByText('Verified by the training authority')).toBeTruthy();
  });

  it('offers the mark destination — the box the ASSESSOR ticks after judging', async () => {
    const result = await draftOf([
      WRITTEN,
      field({ id: 'o1', label: 'Q1 outcome', type: 'check_cross', options: undefined }),
    ]);
    renderStep(result);

    expect(
      screen.getByLabelText('Outcome box for Explain the tip head exclusion zone'),
    ).toBeTruthy();
  });

  it('NEVER ENTERS THE KEYED DENOMINATOR, and the guided count is its own clause', async () => {
    // "N of M keyed" is what the machine marks. A written question in the
    // denominator makes the counter incompletable on every paper with prose.
    const result = await draftOf([field({ id: 'q1' }), WRITTEN]);
    act(() => result.current.keyOps.setModelAnswer('w1', 'A model answer'));
    renderStep(result);

    expect(screen.getByText(/0 of 1 keyed/)).toBeTruthy();
    expect(screen.getByText(/1 written question has model answers/)).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuemax')).toBe('1');
  });

  it('counts a verified model answer in the verified total', async () => {
    const result = await draftOf([field({ id: 'q1' }), WRITTEN]);
    act(() => result.current.keyOps.setModelAnswer('w1', 'A model answer'));
    act(() => result.current.keyOps.setVerified('w1', true, 'Training authority'));
    renderStep(result);

    expect(screen.getByText(/1 verified/)).toBeTruthy();
  });
});

describe('AnswerKeyStep — where a question’s mark lands', () => {
  it('POINTS A QUESTION AT A BOX THE AUTHOR CREATED', async () => {
    /*
      THE CASE THIS EXISTS FOR. `linkOutcomeTargets` pairs a question with its
      outcome box by the printed reference BOTH carry. A box the extraction
      missed has none — nothing read a reference off a box nobody read — so the
      field an author adds to fix the gap is invisible to the automatic route,
      and the author meets that at publish as "has an answer key but no outcome
      box to write its mark into", with no control anywhere that answers it.
    */
    const result = await draftOf([
      field({ id: 'q1', label: 'Which sign means STOP?' }),
      field({ id: 'o1', label: 'Assessment Result', type: 'check_cross', options: undefined }),
    ]);
    renderStep(result);

    fireEvent.change(screen.getByLabelText('Outcome box for Which sign means STOP?'), {
      target: { value: 'o1' },
    });

    expect(result.current.fields.find((f) => f.id === 'q1')!.outcomeTarget).toEqual({
      fieldId: 'o1',
    });
  });

  it('goes back to automatic when the author clears it', async () => {
    const result = await draftOf([
      field({ id: 'q1', label: 'Which sign means STOP?' }),
      field({ id: 'o1', label: 'Assessment Result', type: 'check_cross', options: undefined }),
    ]);
    renderStep(result);
    const select = screen.getByLabelText('Outcome box for Which sign means STOP?');

    fireEvent.change(select, { target: { value: 'o1' } });
    fireEvent.change(select, { target: { value: '' } });

    expect(result.current.fields.find((f) => f.id === 'q1')!.outcomeTarget).toBeUndefined();
  });

  it('OFFERS ONLY BOXES THE EXPORTER WOULD ACTUALLY MARK', async () => {
    /*
      `validateAnswerKeys` only checks the target field exists, so a text box
      would pass validation, publish, and then draw nothing — a mark that
      computes, ships, and never reaches the page. The list is
      `isSelfAnswering`, which is the exporter's own.
    */
    const result = await draftOf([
      field({ id: 'q1', label: 'Which sign means STOP?' }),
      field({ id: 'o1', label: 'Assessment Result', type: 'check_cross', options: undefined }),
      field({ id: 'notes', label: 'Assessor notes', type: 'text', options: undefined }),
    ]);
    renderStep(result);

    const options = Array.from(
      screen
        .getByLabelText('Outcome box for Which sign means STOP?')
        .querySelectorAll('option'),
    ).map((o) => o.textContent);

    expect(options).toContain('Assessment Result');
    expect(options).not.toContain('Assessor notes');
  });

  it('offers no picker at all when the document has no ✓/✗ box', async () => {
    /*
      A select whose only entry is "Automatic" asks the author to choose between
      one thing and nothing. The publish gate already says what is actually
      wrong, which is that there is no outcome box anywhere.
    */
    const result = await draftOf([field({ id: 'q1', label: 'Which sign means STOP?' })]);
    renderStep(result);

    expect(screen.queryByLabelText(/^Outcome box for/)).toBeNull();
  });

  it('does not ask where an assessor verdict lands, because it derives no mark', async () => {
    const result = await draftOf([
      field({ id: 'q1', label: 'Assessment Result' }),
      field({ id: 'o1', label: 'Outcome', type: 'check_cross', options: undefined }),
    ]);
    // Rendered twice rather than asserting a live update: the hook lives in its
    // own `renderHook` root, so the step does not re-render when the draft
    // changes underneath it — the same reason the verdict counter test does.
    const first = renderStep(result);
    expect(screen.getByLabelText('Outcome box for Assessment Result')).toBeTruthy();
    first.unmount();

    act(() => result.current.keyOps.setAssessorVerdict('q1', true));
    renderStep(result);

    expect(screen.queryByLabelText('Outcome box for Assessment Result')).toBeNull();
  });
});
