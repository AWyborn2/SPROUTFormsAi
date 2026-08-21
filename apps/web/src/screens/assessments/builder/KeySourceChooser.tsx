import { useState } from 'react';
import { Icon } from '@formai/ui';
import type { DraftAnswerKey, FormField, StructureSection } from '@formai/shared';
import { apiClient } from '../../../lib/data/api-client.js';
import { fileToBase64, IMPORT_REQUEST_TIMEOUT_MS } from '../../../lib/data/import-session.js';
import { matchGuideToQuestions, parseAnswerGuide, type GuideProblem } from './answer-guide.js';

/**
 * Seeding the answer key from a guide, instead of typing 31 answers.
 *
 * TWO ROUTES, BECAUSE TWO KINDS OF GUIDE EXIST. A JSON key is parsed and
 * matched in the browser — it is already structured, and sending it to a model
 * would add a way for it to come back different. A PDF guide goes to
 * `POST /answer-guides/match`, which is where the model lives and where an
 * answer key belongs: server-side, tenant-scoped, never with a key in the
 * client.
 *
 * THE TWO ROUTES ALIGN DIFFERENTLY, AND THAT IS THE POINT. JSON carries section
 * names and question NUMBERS, so it can only be aligned by order — guarded by
 * the count gate in `answer-guide.ts`. A PDF is read against each question's
 * own TEXT, so it matches by content and simply produces no answer for a
 * question the guide skips. The PDF route is the better one wherever a choice
 * exists; the JSON route exists because this repo already has a file in that
 * shape.
 *
 * NOTHING SEEDED IS VERIFIED. Both routes land answers as proposals with no
 * attestation. What the banner reports is how many were matched, and — with
 * equal prominence — everything that was not.
 */

export interface KeySourceChooserProps {
  sections: readonly StructureSection[];
  fields: readonly FormField[];
  excluded: ReadonlySet<string>;
  onSeed: (keys: DraftAnswerKey[]) => void;
}

interface Outcome {
  /** Choice keys seeded — rows with options in them. */
  seeded: number;
  /**
   * Model answers seeded for WRITTEN questions. Reported as its own number
   * because it is a different promise: a key auto-marks, a model answer is a
   * guide an assessor marks against. "15 answers seeded" over 4 keys and 11
   * guides would claim auto-marking for eleven questions the machine never
   * touches.
   */
  models: number;
  problems: GuideProblem[];
  note?: string;
}

export function KeySourceChooser({ sections, fields, excluded, onSeed }: KeySourceChooserProps) {
  const [busy, setBusy] = useState<'json' | 'pdf' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const readJson = async (file: File | undefined) => {
    if (!file) return;
    setBusy('json');
    setError(null);
    setOutcome(null);
    try {
      const parsed = parseAnswerGuide(JSON.parse(await file.text()));
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      const match = matchGuideToQuestions(parsed.entries, sections, fields, excluded);
      onSeed(match.keys);
      setOutcome({
        seeded: match.keys.filter((k) => k.answerKey.length > 0).length,
        models: match.keys.filter((k) => k.modelAnswer).length,
        problems: match.problems,
      });
    } catch {
      // A JSON parse failure is the common case here — somebody picked the
      // wrong file — and saying which file operation failed is what makes it
      // fixable.
      setError('That file could not be read as JSON. Check it is the answer key and not the assessment itself.');
    } finally {
      setBusy(null);
    }
  };

  const readPdf = async (file: File | undefined) => {
    if (!file) return;
    setBusy('pdf');
    setError(null);
    setOutcome(null);
    try {
      /*
        Only questions with options are sent. A heading or a text box has
        nothing for a guide to mark, and including one would spend context
        asking the model about something it cannot answer.
      */
      const questions = sections.flatMap((section) =>
        section.fields
          .map((f) => fields.find((x) => x.id === f.id))
          .filter((f): f is FormField => !!f && (f.options?.length ?? 0) > 0 && !excluded.has(f.id))
          .map((f) => ({
            fieldId: f.id,
            label: f.label,
            options: f.options ?? [],
            section: section.label,
          })),
      );

      if (questions.length === 0) {
        setError('There are no keyable questions to match a guide against yet.');
        return;
      }

      const result = await apiClient.post<{ answers: Record<string, string[]>; notes?: string[] }>(
        '/answer-guides/match',
        { pdfBase64: await fileToBase64(file), questions },
        { timeoutMs: IMPORT_REQUEST_TIMEOUT_MS },
      );

      const keys: DraftAnswerKey[] = Object.entries(result.answers ?? {}).map(([fieldId, answerKey]) => ({
        fieldId,
        answerKey,
        source: 'guide_document',
      }));
      onSeed(keys);
      setOutcome({
        seeded: keys.length,
        // The PDF route seeds choice keys only this round.
        models: 0,
        // The model's own notes are reported as problems, because that is what
        // they are: questions it declined to answer and why.
        problems: (result.notes ?? []).map((reason) => ({ section: 'From the guide', reason })),
        note:
          questions.length - keys.length === 1
            ? '1 question still needs keying by hand.'
            : `${questions.length - keys.length} questions still need keying by hand.`,
      });
    } catch {
      setError('The answer guide could not be read. Try again, or key this assessment by hand.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2.5 rounded-[14px] border border-border bg-surface-card p-4">
      <span className="block text-[14.5px] font-semibold">Start from a guide</span>
      <span className="block text-[11.5px] text-text-tertiary">
        Seeded answers are never counted as verified — you still confirm each one.
      </span>

      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 text-[11.5px] font-semibold text-text-secondary hover:bg-surface-hover">
          <Icon name="file-json" size={13} />
          {busy === 'json' ? 'Reading…' : 'Upload answer key (JSON)'}
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => void readJson(e.target.files?.[0])}
          />
        </label>

        <label className="inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 text-[11.5px] font-semibold text-text-secondary hover:bg-surface-hover">
          <Icon name="file-text" size={13} />
          {busy === 'pdf' ? 'Reading the guide…' : 'Upload answer guide (PDF)'}
          <input
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => void readPdf(e.target.files?.[0])}
          />
        </label>
      </div>

      {error && (
        <p role="alert" className="rounded-[10px] border border-danger bg-danger-soft p-[8px_10px] text-[11.5px] text-danger-text">
          {error}
        </p>
      )}

      {outcome && (
        <div className="flex flex-col gap-1.5">
          <p className="rounded-[10px] border border-border-subtle bg-surface-sunken p-[8px_10px] text-[11.5px] text-text-secondary">
            <strong>
              {outcome.seeded} answer{outcome.seeded === 1 ? '' : 's'}
              {outcome.models > 0 &&
                ` · ${outcome.models} model answer${outcome.models === 1 ? '' : 's'}`}{' '}
              seeded
            </strong>
            , none verified. {outcome.note}
          </p>
          {/*
            Problems are rendered at the SAME prominence as the count, never
            folded behind a disclosure. A section that did not seed is the part
            an author has to act on, and a banner reporting only the successes
            reads as "done".
          */}
          {outcome.problems.map((problem, i) => (
            <p
              key={i}
              className="rounded-[10px] border border-warning bg-warning-soft p-[8px_10px] text-[11.5px] text-warning-text"
            >
              {problem.reason}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
