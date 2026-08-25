import type { DocumentType } from '@formai/shared';

/**
 * Per-document-type extraction instructions, appended to the base prompt.
 *
 * The base prompt describes forms in general. It gets some document classes
 * badly wrong, because the same printed structure means different things in
 * different classes — a table of rows is a checklist in one document and a set
 * of questions in another, and only the class tells you which.
 *
 * The failure that produced this module: on a real competency assessment paper,
 * the model emitted Mining Q7-Q12 and all ten Raw Materials questions as proper
 * answerable choice fields, but folded General Q1-Q9 and Mining Q1-Q6 into two
 * summary tables whose rows were the question text. Same document, same kind of
 * content, two incompatible readings — and fifteen questions a candidate could
 * not answer. Nothing in the generic prompt said which reading was right,
 * because generically both are defensible.
 *
 * A profile is guidance layered on the base prompt, not a replacement for it.
 * Only `assessment` is written so far; the rest fall through to the base
 * behaviour until each is worked properly against real documents of its class.
 * An empty profile is the honest state for a type nobody has tuned yet — better
 * than guesses that read like requirements.
 */

/**
 * Competency assessment papers: theory questions, practical observation
 * checklists, logbooks, and per-part sign-off.
 *
 * Rule 1 is the load-bearing one. The others describe structures this class
 * reliably contains, so the model does not have to infer their meaning.
 *
 * Rules 8-17 were written against the printed text of a real 18-page paper,
 * and each one names a failure that document actually produces:
 *
 *  - The COVER PAGE is three documents on one sheet — who the candidate is,
 *    what they must already hold, and what the assessor concluded. Read as one
 *    block it cannot be split into parts, and the eligibility half is the half
 *    that reads least like a form. `coverSection` is bounded to the FIRST page
 *    because each part's own sign-off later on prints the same words.
 *
 *  - A PREREQUISITE ROW is a sentence with a tick box, which a generic read
 *    treats as a heading; it then disappears with nothing downstream able to
 *    tell it was printed. But the ASSESSOR's own qualifications print in the
 *    identical shape and gate nobody's enrolment, so rule 9 has to separate
 *    them by the sentence that introduces the list.
 *
 *  - A MATCHING QUESTION has no printed option list, so a read that must
 *    produce one invents it. `matching.ts` models these properly but can only
 *    build them from both sides. Rule 10 is bounded to questions that actually
 *    print two lists, because emptying `options` on a false positive produces
 *    a question nobody can answer in a section that must be passed.
 *
 *  - THE OUTCOME COLUMN IS A LEGEND PRINTED ONCE. On the real paper the ✓ / ✗
 *    appears exactly once, above the first run of theory questions; the two
 *    later question sets print none. Read conservatively that yields NO
 *    outcome boxes for 22 of 31 questions — and page-batched extraction means
 *    16 of them are read by a call that never sees the legend at all. Rule 11
 *    is the deliberate exception to "omitting is better than inventing",
 *    because a missing outcome box is a question set nobody can mark.
 *
 *  - THREE PRACTICAL PARTS ARE CHARACTER-IDENTICAL, two of them under the same
 *    heading text, and the only printed disambiguator is rotated gutter text.
 *    Rules 12 and 13 are what stop a checklist being anchored to the wrong
 *    stage of the assessment — which would certify a demonstration nobody
 *    watched.
 *
 *  - THE BACK MATTER IS SHAPED LIKE A FORM AND IS ALREADY FILLED IN. The
 *    document-control block carries real approver names, ticks and dates; read
 *    as a fixed-item checklist it manufactures approval sign-offs on a
 *    compliance record. Rule 15's test is who fills it, not what shape it is.
 *
 * Rules 18-19 were written against the WIDER corpus this class spans, not the
 * single 18-page paper rules 8-17 came from — because most papers of this class
 * are not shaped like that one:
 *
 *  - A WRITTEN QUESTIONNAIRE MIXES QUESTION TYPES UNDER ONE HEADING, and most of
 *    it is short-answer. Rule 1 speaks only of lettered-choice questions; on a
 *    theory or familiarisation paper the majority print no choices at all, and a
 *    read anchored to rule 1 either invents options for them or reads them as
 *    the shape of the multiple-choice question above. Rule 18 names the
 *    open-answer question as its own field, and pins that single/True-False/open
 *    are read each on its own printed shape.
 *
 *  - A LETTERED CHOICE CAN BE ORPHANED BY THE PAGE-BATCH BOUNDARY. The choices
 *    of a question straddling a batch edge arrive with no stem above them; read
 *    as a field they manufacture a question the paper never asked and mis-number
 *    everything after. Rule 19 is the batching interaction rule 13 implies but
 *    never states for the answer side.
 *
 * Rules are stated as printed shapes rather than as facts about one paper, and
 * each is bounded so it cannot fire on a document of this class that does not
 * carry the structure. Where a rule cannot be satisfied from the pages in
 * front of the model, it says to report rather than supply — rule 13.
 */
const ASSESSMENT_PROFILE =
  'DOCUMENT TYPE: COMPETENCY ASSESSMENT PAPER. These rules OVERRIDE the general guidance above ' +
  'wherever they conflict.\n' +
  '1. QUESTIONS ARE FIELDS, NEVER TABLE ROWS. Every numbered question offering lettered choices ' +
  '(a), b), c) …) is its own answerable field: a `radio` when exactly one choice is correct, a ' +
  '`checkbox_group` with selectionType "multiple" when the wording says "select correct answers", ' +
  '"more than one answer", "select all that apply" or similar. Put the choice text in `options`, ' +
  'in printed order, WITHOUT the a)/b)/c) prefix. Never collapse a run of questions into a ' +
  'repeating_group whose rows are the question text — that makes every one of them unanswerable, ' +
  'and it is the single most damaging mistake on this document class. DEFAULT SINGLE: a lettered ' +
  'question is a `radio` unless its OWN stem prints one of the plural phrasings above. Tick or ' +
  'circle boxes drawn beside the choices, and a "circle the correct answer" / "select the correct ' +
  'answer" (singular) instruction, do NOT make it multiple — they are just how one answer is ' +
  'marked. Reading a single-answer question as `multiple` lets a candidate over-select every choice ' +
  'and still read as correct.\n' +
  '2. TRUE/FALSE questions are `radio` fields with options exactly ["True", "False"].\n' +
  '3. OUTCOME BOXES ARE SEPARATE FIELDS, LINKED BY QUESTION REFERENCE. A tick/cross box recording ' +
  'whether an answer was CORRECT is not one of the answer choices. Emit it as its own ' +
  '`check_cross` field immediately after the question it belongs to. Set `questionRef` on BOTH the ' +
  'question and its box and make the two strings match CHARACTER FOR CHARACTER — that string is ' +
  'what pairs them, not adjacency. Numbering RESTARTS in every question set, so a bare printed ' +
  'number is not a reference on its own: where the set heading is printed in the pages you were ' +
  'given, build the reference from a short prefix taken from that heading plus the printed number ' +
  '("General Q7", "BBM Q3", "RM Q10"); where the heading is NOT in view, prefix with the printed ' +
  'page number instead ("p.5 Q7") and say so once in `designNotes`. NEVER PREFIX ONE SIDE OF A ' +
  'PAIR AND NOT THE OTHER. WHERE THE SET HEADING REPEATS VERBATIM IT CANNOT BE THE PREFIX: some ' +
  'papers title every question run identically ("Verbal Questions") and restart numbering under ' +
  'each, so "Verbal Q1" names several different questions. The reference must single out ONE ' +
  'question among all the questions in the pages you were given — so take the prefix from the ' +
  'nearest heading that IS distinctive (the numbered observation section the run falls under, ' +
  '"Functional Tests Q1"), or failing that the printed page number ("p.8 Q1"), never the repeated ' +
  'run heading. Which questions have a box is settled by rule 11.\n' +
  '4. EMIT SECTION HEADERS for structural headings, as `section_header` fields carrying no answer: ' +
  'each PART heading ("PART 1 - THEORY", "PART 3 - DIRECT OBSERVATION LOG"), and each named ' +
  'question group inside a part ("Written or Verbal Questions (General)", "BBM Mining Only", ' +
  '"Raw Materials Operators Only"). These mark where a part or group begins. Include them even ' +
  'though nobody fills them in.\n' +
  '5. PRACTICAL DEMONSTRATION CHECKLISTS stay repeating_groups with fixedRows — rule 1 does NOT ' +
  'apply to them. Their rows are observed items ("Sound the horn once prior to starting the ' +
  'engine?"), each separately ticked, and their columns are the ✓ / × / N-A alternatives described ' +
  'in the general guidance. THE TEST IS THE COLUMN, NOT THE BULLET STYLE: a block whose rows carry ' +
  'tick / cross / N-A columns down the right-hand side is a checklist however its rows are marked ' +
  '— bullets, dashes, letters or numbers. Anything under a prompt line like "During the ' +
  'demonstration, did the Candidate:" is an observation checklist even where its sub-items are ' +
  'lettered a) b) c). A numbered question with lettered ANSWERS and no tick column beside it is ' +
  'untouched and stays rule 1. Converting an observation checklist into radio questions leaves the ' +
  'assessor\u2019s tick nowhere to go — rule 1\u2019s mistake run backwards, and just as damaging.\n' +
  '6. LOGBOOKS (columns such as Date, Location, Task, Duration, Comments, Signature) are OPEN ' +
  'repeating_groups: no fixedRows, because the filler adds rows over weeks. The sentence printed ' +
  'immediately above the table ("…complete a minimum of 20hrs directly supervised before ' +
  'assessment for Minimal Supervision can take place") is often the ONLY thing distinguishing two ' +
  'logbook parts whose tables are column-for-column identical: put it VERBATIM in the table\u2019s ' +
  '`description` — NOT as a `section_header`, because a heading between a part\u2019s first field and ' +
  'its table hides the table from that part — and give the column recording elapsed time the `key` ' +
  '"duration", whatever it is labelled, keeping its printed label. Without the number the ' +
  'threshold is authored by guess; without a findable hours column the total silently reads zero ' +
  'against a safety minimum. Where no minimum is printed above the table, add no description.\n' +
  '7. SIGN-OFF BLOCKS ARE TRANSCRIBED, NEVER COMPLETED. A part may end with a FULL block — a ' +
  'performance statement, a two-way outcome choice, and separate "Name of Assessor [Print]" / ' +
  '"Assessor Signature" / "Date" boxes — or with a BARE outcome line and nothing else ("PART 1 - ' +
  'The Candidate\u2019s responses were: Satisfactory / Not Satisfactory"), or with no sign-off at all; ' +
  'logbook parts usually print none. Emit every printed box as its own field and NOTHING ELSE. ' +
  'Emit the outcome choice as a `radio` whose `options` are the two printed labels VERBATIM and in ' +
  'printed order — the wording differs between parts of the same paper ("Satisfactory" / "Not ' +
  'Satisfactory" in one, "Candidate not yet Competent" / "Candidate Competent" in another) and ' +
  'both must survive exactly as printed, neither normalised into the other. NEVER ADD an assessor ' +
  'name, signature or date box a part does not print. An invented signature box is a place to ' +
  'record a verdict the paper never asked for, on the document that says this person may operate ' +
  'the machine.\n' +
  '8. THE COVER PAGE ALWAYS SPLITS INTO EXACTLY THREE SECTIONS, in this order, and every fillable ' +
  'box on that page belongs to one of them. Set `coverSection` on each: "candidate_declaration" — ' +
  'the candidate identity boxes (name, company, employee or swipe-card number) and the candidate ' +
  'declaration signature; "pathway_prerequisites" — EVERY prerequisite row, the pathway choice and ' +
  'the assessment-method table; "assessor_declaration" — the coaching yes/no boxes, the ' +
  'further-action and mandatory comment boxes, the competent / not-yet-competent boxes, and the ' +
  'assessor name, signature and date. Emit `section_header` fields for the three as well, so the ' +
  'parts they open are anchorable. `coverSection` IS A PROPERTY OF THE COVER PAGE, NOT OF A SHAPE: ' +
  'set it only on fields printed on the document\u2019s FIRST page. Each part\u2019s own sign-off later in ' +
  'the document prints the same performance statement, the same not-yet-Competent / Competent pair ' +
  'and the same Name / Signature / Date row — it is NOT the cover, it carries NO `coverSection`, ' +
  'and it takes its part prefix instead (rule 12). Where a box\u2019s own prompt carries "[Mandatory]", ' +
  '"*" or "required", set `required` true on that box.\n' +
  '9. NEVER OMIT A PREREQUISITE ROW, AND NEVER PROMOTE AN ASSESSOR\u2019S QUALIFICATION INTO ONE. A ' +
  'licence class, permit, ticket or qualification THE CANDIDATE must already hold ("Q50001782 ' +
  'Driver\u2019s Licence C OR higher class") is a GATING FACT, not page furniture: emit it verbatim as ' +
  'its own `check_cross` field, with `coverSection` "pathway_prerequisites" when it is printed on ' +
  'the cover. Where the row states the requirement but prints NO tick box, still emit the field ' +
  'and say so in `note` ("the row states the prerequisite; no tick box is printed") — this is the ' +
  'one place this profile asks for a box the page does not print, and the note is what makes it ' +
  'visible rather than invented. But READ THE SENTENCE THAT INTRODUCES THE LIST FIRST: a ' +
  'qualification THE ASSESSOR, TRAINER OR VERIFIER must hold ("Assessment is only to be conducted ' +
  'by … who holds the following qualifications", and any refresher list beside it) says who may ' +
  'CONDUCT the assessment and gates nobody\u2019s enrolment. It prints in the identical shape — a code ' +
  'and a title — and usually not on the cover page at all. Emit no field for it; record it in ' +
  '`designNotes`. A prerequisite read as a heading disappears and nothing downstream can tell it ' +
  'was printed; an assessor\u2019s ticket read as a prerequisite gates enrolment on something the ' +
  'candidate never needed.\n' +
  '10. A MATCHING QUESTION CARRIES BOTH ITS SIDES. THIS RULE APPLIES ONLY WHERE THE PAGE PRINTS ' +
  'TWO LISTS — a set of prompts AND a separate set of things they may be matched to. A stem that ' +
  'merely contains the word "match" above ordinary lettered choices is rule 1\u2019s `radio` or ' +
  '`checkbox_group`; leave its options exactly as printed. Where two lists are printed, emit ' +
  '`matchLeft` (every prompt, verbatim, in printed order — where the prompts are pictures, ' +
  'describe each one, e.g. "Sign photo — red pyramid") and `matchRight` (everything they may be ' +
  'matched to, verbatim, in printed order). Set `type` to `checkbox_group` with selectionType ' +
  '"multiple" and leave `options` EMPTY — the pairings are built from the two sides, so an options ' +
  'list guessed here would be a different question from the one printed. Never emit a matching ' +
  'question with only one side: a side that cannot be read is better reported empty than invented. ' +
  'AND NEVER EMPTY THE OPTIONS OF A QUESTION THAT PRINTED THEM — a choice field with no `options` ' +
  'and neither side is a question nobody can answer, sitting in a section that must be passed.\n' +
  '11. A LEGEND PRINTED ONCE HEADS EVERY ROW AND EVERY QUESTION BENEATH IT — AND IT IS OFTEN ' +
  'PRINTED ON A PAGE YOU WERE NOT GIVEN. This class names its outcome columns ONCE: on a ' +
  'checklist\u2019s prompt line ("During the demonstration, did the Candidate: ✓ / × N/A") or above the ' +
  'FIRST run of theory questions ("The Candidate should answer the following questions to indicate ' +
  'underpinning knowledge: ✓ / ✗"), and leaves the per-row and per-question cells BLANK. A blank ' +
  'cell under such a legend IS a printed box. So (a) give EVERY observation sub-table in a part ' +
  'the same columns and the same `answerSets` grouping them as alternatives, even where its own ' +
  'prompt line repeats the legend imperfectly or omits it; and (b) in a THEORY part, give EVERY ' +
  'numbered question its own `check_cross` outcome box per rule 3 — including questions in a LATER ' +
  'SET whose own heading prints no legend, and including a set that opens your first page with the ' +
  'legend on a page you were not given. The legend belongs to the PART, not to the sub-table and ' +
  'not to the set. This is the deliberate exception to rule 3\u2019s "omitting is better than ' +
  'inventing": an extra empty outcome box costs a reviewer one deletion, a missing one costs a ' +
  'question set nobody can mark and a section that reads as though nobody assessed it. Omit ' +
  'outcome boxes only where your pages positively show the questions printed with no marking ' +
  'column and no legend anywhere — and say so in `designNotes` when you do.\n' +
  '12. THE SAME BLOCK IS PRINTED ONCE PER PART, AND ONLY THE PART TELLS THE COPIES APART. This ' +
  'class repeats a whole practical checklist and its sign-off two or three times, character for ' +
  'character, because each copy is a separate observed demonstration. You cannot see the other ' +
  'copies from your pages, so ASSUME THEY EXIST. Having established the part (rule 13), PREFIX the ' +
  '`label` of every `section_header`, every `repeating_group` and every sign-off field inside that ' +
  'part with it and an em dash: "Part 4 — 3. Start Up Procedure", "Part 4 — Name of Assessor ' +
  '[Print]". Prefix the field\u2019s own `label` ONLY — `fixedRows`, `options`, `questionRef`, column ' +
  'labels, `matchLeft` and `matchRight` stay exactly as printed, so identical copies stay ' +
  'comparable and nothing compared verbatim downstream is altered. Never merge, deduplicate or ' +
  'shorten a repeat to "as above". Where no part identifier is printed anywhere on your pages, add ' +
  'no prefix and report it under rule 13 rather than inventing one. Copies that come back ' +
  'indistinguishable get anchored to the wrong assessment stage, and a dropped copy certifies a ' +
  'demonstration nobody watched.\n' +
  '13. YOU ARE READING A PAGE RANGE, NOT THE WHOLE DOCUMENT — EMIT WHAT IS PRINTED AND GUESS ' +
  'NOTHING YOU CANNOT SEE. Long papers are extracted a few pages at a time, so the PART heading or ' +
  'question-set heading governing your first fields is often printed in someone else\u2019s pages. ' +
  'Never number a part, name a question set, or supply a heading from how these documents usually ' +
  'run: a guessed part number silently anchors a whole checklist to the wrong assessment stage and ' +
  'nothing downstream can tell it was a guess. Establish position only from what your own pages ' +
  'print, in this order: (a) a PART heading above the field; (b) ROTATED TEXT IN THE PAGE MARGIN ' +
  'THAT NAMES A PART ("Part 4 Assessment") — sideways gutter text is the heading of the block ' +
  'BESIDE it, it lands out of order in the text stream and usually AFTER the block it names, so ' +
  'never attach it to whatever follows it, and never emit a rotated label as a field; (c) the page ' +
  'number in the running footer. A rotated label naming something other than a part — "Assessment ' +
  'Methods", "Assessment Result", "Assessors Feedback" — is a block heading, not a part name. Add ' +
  'ONE `designNotes` line giving the page range you were handed and every heading you had to ' +
  'resolve by (b) or (c), so a reviewer knows which joins to check.\n' +
  '14. A PRACTICAL PART IS A RUN OF NUMBERED SUB-CHECKLISTS, AND ONE PRINTED TICK IS ONE ROW. Each ' +
  'sub-checklist carries its own numbered heading ("1. Plan and Prepare", "4.1 Operational ' +
  'Requirements - BBM Mining Only") and its own prompt line: emit ONE `repeating_group` per ' +
  'sub-checklist, labelled with that heading and part-prefixed per rule 12 — never one table for ' +
  'the whole part, never one field per row. An item that WRAPS onto a second printed line is ONE ' +
  '`fixedRows` entry. Indented bullets beneath an item elaborate it and share its single tick: ' +
  'fold them into that item\u2019s entry, appended after the item text and separated by " • ", THE ' +
  'SAME WAY EVERY TIME. A line is a row of its own only where it is numbered like the rows around ' +
  'it, or carries its own tick box. A promoted bullet is an assessable criterion with no printed ' +
  'box beside it — an item the record says was checked and the page never offered — and because ' +
  'this checklist is printed two or three times, deciding it differently in two page groups gives ' +
  'two copies of one list different row counts, destroying the only evidence that they are the ' +
  'same list.\n' +
  '15. WHAT THE PUBLISHER ALREADY FILLED IN IS NOT A FIELD, AND NEITHER IS FURNITURE. A ' +
  'definitions / terms table, a references list and a DOCUMENT CONTROL approval block belong to ' +
  'the publisher: nobody filling this paper in writes in them. Emit NO fields for them, even ' +
  'though "Term | Description" and "Role | Name | Approved | Date" have exactly the shape of a ' +
  'fixed-item checklist. The approval block is the dangerous one — it is ALREADY COMPLETED with ' +
  'real names, ticks and dates, and re-emitting it with `fixedRows` manufactures approval ' +
  'sign-offs on a compliance record. THE TEST IS WHO FILLS IT: publisher matter is already ' +
  'completed, or names roles (approver, author, document owner) rather than a candidate or ' +
  'assessor. The same test governs a label/value row whose value cell already carries a printed ' +
  'constant ("Category of Assessment | Q34666893 ATO Track Dozer"). The running owner / author / ' +
  'version / document-number band, an "UNCONTROLLED ONCE PRINTED" notice and "Page N of M" print ' +
  'on EVERY page and are already filled in: emit nothing for them and state the document\u2019s ' +
  'identity ONCE in `designNotes`. A whole page of process description whose rows are a label ' +
  'beside a paragraph, with no box printed anywhere, is reference matter and yields NO fields — ' +
  'not one textarea per row, not a table of its prose, not prerequisite tick boxes. A row or cell ' +
  'left EMPTY for a candidate or assessor to complete is still a field. Rule 9\u2019s prerequisite row ' +
  'is the deliberate exception. Put any abbreviation definitions into `designNotes`, because the ' +
  'questions using them are read in a different page group.\n' +
  '16. THE PATHWAY LINES ARE ONE EXCLUSIVE CHOICE AND THEIR PART NUMBERS ARE THE MAPPING. Where ' +
  'the cover prints two or more MUTUALLY EXCLUSIVE routes through the paper, each naming the parts ' +
  'it requires ("PART 1 and 2: Experienced candidates or Re-assessments" / "PART 1, 2, 3, 4, 5 and ' +
  '6: New and inexperienced candidates"), a candidate takes exactly ONE: emit a single `radio` ' +
  'whose `options` are those lines VERBATIM, part numbers included, with `coverSection` ' +
  '"pathway_prerequisites". Repeat each line in `designNotes` too, because those part numbers are ' +
  'the only printed statement of which parts a route requires — paraphrasing an option to ' +
  '"Experienced candidates" throws the mapping away. Where the routes print with NO boxes beside ' +
  'them, still emit the radio and say so in `note`. Where only ONE route is printed there is ' +
  'nothing to be exclusive between — emit it as a `check_cross`. A further route described only in ' +
  'prose elsewhere ("RPL can be used … however Part 1 and Part 2 must still be completed") is NOT ' +
  'one of these options: quote it in `designNotes`.\n' +
  '17. THE ASSESSMENT-METHOD LIST IS ONE TABLE, NOT ONE FIELD PER METHOD. "Methods used to assess ' +
  'competence: (Please check all methods used)" over a numbered list is a fixed-item checklist: ' +
  'ONE `repeating_group`, the method names as `fixedRows` in printed order WITHOUT their numbers, ' +
  'the item column FIRST (type text) with a tick column beside it, and `coverSection` ' +
  '"pathway_prerequisites" on that single field. Each part marks its own method row when it ' +
  'passes, which needs the rows to be addressable cells of ONE table — and `coverSection` is one ' +
  'value per field, so a run of loose checkboxes can neither be addressed nor say where it ' +
  'belongs. Keep every printed method, including one whose number is separated from the rest by a ' +
  'rotated gutter label — that label is the block\u2019s heading (rule 13), never a method.\n' +
  '18. A NUMBERED QUESTION THAT PRINTS NO CHOICES IS ONE FREE-TEXT ANSWER, NOT A CHOICE FIELD. Much ' +
  'of this class is short-answer: a numbered question with a blank space or ruled lines beneath it ' +
  'and NO lettered choices ("What action would you take if you found a Category A fault?"). Emit it ' +
  'as a single `textarea` (or `text` for a one-line answer) — NEVER a `radio`, and NEVER invent ' +
  '`options` for it. Rule 1 governs only questions that actually print lettered choices; this rule ' +
  'governs the rest, and the two together cover a set that MIXES both — a written questionnaire ' +
  'often runs multiple-choice, True/False and open questions under one heading, so read each on its ' +
  'own printed shape, not the shape of its neighbours. Where the question prints its own answer ' +
  'sub-lines ("Name three Category A faults: 1.___ 2.___ 3.___") it is still ONE field: say how ' +
  'many answers are expected in `description` rather than emitting one field per line. A ' +
  'short-answer question still takes its own outcome box under rule 11 wherever the part marks its ' +
  'questions. Inventing choices for an open question turns a written answer into a multiple-guess ' +
  'nobody wrote.\n' +
  '19. A BARE LETTERED CHOICE WITH NO QUESTION ABOVE IT IS THE TAIL OF A QUESTION YOU CANNOT SEE — ' +
  'EMIT NOTHING FOR IT. Because you are reading a page range (rule 13), a question stem can ' +
  'sit on a page you were not given while its later choices ("c) … d) … e) …") open your first ' +
  'page, or its earlier choices print on your last page while the rest continue past your range. A ' +
  'run of lettered lines with no numbered stem above them is NOT its own field, NOT a ' +
  '`checkbox_group` and NOT a checklist: emit nothing for it and record the fragment verbatim in ' +
  '`designNotes` ("page opens on orphan choices c)–e) with no stem — belongs to a question before ' +
  'this range; merge in review"). An orphaned option emitted as a field manufactures an extra ' +
  'answerable question the paper never asked, mis-numbers every field after it, and is the ' +
  'commonest way a batch boundary corrupts this class. The same holds for a lone stem whose choices ' +
  'all fall past your last page: emit the question with the choices you can see and note in ' +
  '`designNotes` that its options may continue beyond the range.\n' +
  '20. A QUESTION’S `label` IS THE PRINTED QUESTION, NEVER ITS NUMBER. Carry the question’s own ' +
  'words verbatim as the `label` ("When must a pre-start inspection be completed?"), dropping only ' +
  'the printed number/letter into `questionRef` per rule 3. NEVER emit a label that is just the ' +
  'reference — "Q1", "Part 1 Q1", "7" — with the question’s words left out, however long the ' +
  'question runs. The label is the only text a reviewer sees in the question bank, so a bare ' +
  'reference makes the bank unreadable; and placement finds a field on the page by matching its ' +
  'label against the page’s own printed text, so a label printed nowhere can never be placed. ' +
  'Where a question is genuinely unreadable in your pages (a scan artefact, a truncated stem), emit ' +
  'what is printed and say so in `note` — never substitute the reference for the words.';

const PROFILES: Partial<Record<DocumentType, string>> = {
  assessment: ASSESSMENT_PROFILE,
};

/**
 * Human-PROMOTED correction examples, per document type — the ONLY path from the
 * learning loop's evidence to the prompt.
 *
 * The loop stores how reviewers corrected each extraction and clusters the
 * recurring corrections into content-free shapes (`correction-shapes.ts`, the
 * `/pdf/corrections/candidates` surface). Nothing there touches the prompt. When
 * a shape recurs enough to be worth teaching, a PERSON reads it and writes a
 * general example HERE, in a PR the profile tests gate — including the anti-forms
 * guard, which runs over these examples exactly as it runs over the profile. No
 * code path mutates the prompt from stored data at runtime; that is the whole
 * point of the human gate (plan R8).
 *
 * EMPTY IS THE HONEST DEFAULT. A type nobody has promoted an example for reads
 * exactly as its base profile, byte for byte — see `appendLearnedExamples`. Each
 * entry states a printed SHAPE and its correct reading, never a fact about one
 * paper, so a promoted example generalises to a paper it has never seen.
 */
const LEARNED_EXAMPLES: Partial<Record<DocumentType, readonly string[]>> = {
  // None promoted yet. Add entries here via a reviewed PR, never at runtime.
};

/** The promoted examples for a type, or an empty list. */
export function learnedExamplesFor(type: DocumentType | undefined): readonly string[] {
  return (type && LEARNED_EXAMPLES[type]) ?? [];
}

/**
 * Append promoted examples to a base profile. Pure and byte-exact: an empty list
 * returns the base UNCHANGED (so a type with nothing promoted is identical to
 * before this seam existed), and a non-empty list adds one clearly-headed block.
 */
export function appendLearnedExamples(base: string, examples: readonly string[]): string {
  if (examples.length === 0) return base;
  const block =
    'LEARNED EXAMPLES (promoted from real reviewer corrections — each is a printed shape and ' +
    'its correct reading; apply them as you would the rules above):\n' +
    examples.map((e, i) => `${i + 1}. ${e}`).join('\n');
  return base ? `${base}\n${block}` : block;
}

/** The extra instructions for a document type, or empty when it has none. */
export function profileFor(type: DocumentType | undefined): string {
  return appendLearnedExamples((type && PROFILES[type]) ?? '', learnedExamplesFor(type));
}

/** Whether a type carries tuned instructions, as opposed to base behaviour. */
export function hasProfile(type: DocumentType | undefined): boolean {
  return profileFor(type).length > 0;
}
