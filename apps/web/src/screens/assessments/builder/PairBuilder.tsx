import { useMemo, useState } from 'react';
import { Icon } from '@formai/ui';
import {
  MATCH_MODES,
  type MatchMode,
  type MatchPresentation,
  type MatchingPair,
  type BuiltMatchingQuestion,
} from '@formai/shared';
import { uploadAttachment } from '../../../lib/data/api-client.js';
import {
  buildFromDraft,
  unpairedPrompts,
  type MatchSeed,
  type MatchSeedOrigin,
} from './matching-authoring.js';

/**
 * Authoring one matching question: the two printed lists, and which pairings
 * are correct.
 *
 * WHY THIS SCREEN EXISTS AT ALL. `matching.ts` has modelled these questions
 * completely for some time — options are the pairings, the key is an exact set,
 * `markTheory` needs no special case — and nothing has ever populated it. A
 * matching question therefore reached a published tool as unanswerable text
 * sitting in a section that must be passed, which `validateManifest` names as a
 * hard problem. This is the surface that fills the gap.
 *
 * THE TWO LISTS ARE THE DOCUMENT'S; THE PAIRINGS ARE THE AUTHOR'S. Extraction
 * rule 10 reads both sides verbatim and is explicitly forbidden from guessing
 * the correspondences — so the lists arrive seeded and the matrix arrives
 * empty, every time, including when the printed rows looked like an answer
 * table. `matching-authoring.ts` decides what may be seeded; this component
 * never infers.
 *
 * NOTHING IS SAVED THAT WILL NOT BUILD. Save runs `buildFromDraft` and renders
 * a refusal in place rather than writing a question the marker cannot use. The
 * refusals come from `buildMatchingQuestion` verbatim — they were written for a
 * person, and a second wording here is a second thing to keep true.
 */

const ORIGIN_TONE: Record<MatchSeedOrigin, string> = {
  both_sides: 'border-border-subtle bg-surface-sunken text-text-secondary',
  existing: 'border-border-subtle bg-surface-sunken text-text-secondary',
  one_side: 'border-warning bg-warning-soft text-warning-text',
  split_options: 'border-warning bg-warning-soft text-warning-text',
  blank: 'border-warning bg-warning-soft text-warning-text',
};

const MODE_LABELS: Record<MatchMode, string> = {
  line: 'Draw a line',
  drag: 'Drag to match',
};

export interface PairBuilderProps {
  /** What the editor opens with — see `seedFromField`. */
  seed: MatchSeed;
  /** The question's current presentation, where it has been saved before. */
  presentation?: MatchPresentation;
  onSave: (built: BuiltMatchingQuestion, presentation: MatchPresentation) => void;
  onCancel: () => void;
}

/** A row's image slot key, matching `MatchPresentation.images`: `l0`, `r2`. */
function slotKey(side: 'l' | 'r', index: number): string {
  return `${side}${index}`;
}

export function PairBuilder({ seed, presentation, onSave, onCancel }: PairBuilderProps) {
  const [lefts, setLefts] = useState<string[]>(() => [...seed.lefts]);
  const [rights, setRights] = useState<string[]>(() => [...seed.rights]);
  const [correct, setCorrect] = useState<MatchingPair[]>(() => [...seed.correct]);
  const [mode, setMode] = useState<MatchMode>(presentation?.mode ?? 'line');
  const [leftImages, setLeftImages] = useState(!!presentation?.leftImages);
  const [rightImages, setRightImages] = useState(!!presentation?.rightImages);
  const [images, setImages] = useState<Record<string, string>>(() => ({ ...(presentation?.images ?? {}) }));
  const [error, setError] = useState<string | null>(null);

  const question = useMemo(() => ({ lefts, rights, correct }), [lefts, rights, correct]);
  const unpaired = useMemo(() => unpairedPrompts(question), [question]);

  /*
    A STATEMENT WITH TWO CORRECT ANSWERS CANNOT BE DRAWN AS AN INTERACTIVE.

    A line from a dot, and a card in a slot, are both singular by shape — one
    answer per statement is all either can express. The model permits a
    non-bijection deliberately, and the grouped checkbox list can express it, so
    the question is authorable; it just cannot use these presentations.

    The check has to live HERE. A fill surface never sees `answerKey` —
    `stripMarkingSecrets` removes it from every payload, by design — so the
    renderer cannot make this judgement, and a candidate would be handed a
    question they physically cannot answer correctly.
  */
  const multiAnswerPrompts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const pair of correct) counts.set(pair.left, (counts.get(pair.left) ?? 0) + 1);
    return [...counts.entries()].filter(([, n]) => n > 1).map(([left]) => left);
  }, [correct]);

  const isPaired = (left: string, right: string) =>
    correct.some((p) => p.left === left && p.right === right);

  /*
    A pairing TOGGLES, and a prompt may hold more than one.

    `MatchingQuestion.correct` is explicitly not required to be a bijection —
    "match each hazard to its control" may use one control twice, and may pair
    one hazard with two controls. Forcing radio behaviour here would make the
    builder unable to author a question shape the model already supports and the
    paper already prints.
  */
  const togglePair = (left: string, right: string) => {
    setError(null);
    setCorrect((prev) =>
      isPaired(left, right)
        ? prev.filter((p) => !(p.left === left && p.right === right))
        : [...prev, { left, right }],
    );
  };

  /*
    Renaming an entry CARRIES ITS PAIRINGS.

    The key is stored as the text of both halves, so editing a typo in a prompt
    after keying it would otherwise orphan every pairing that named the old
    text — and `buildMatchingQuestion` would then refuse with "Correct pairing
    names prompt …, which is not listed", which reads as a bug rather than as
    the consequence of a rename.
  */
  const renameEntry = (side: 'l' | 'r', index: number, value: string) => {
    setError(null);
    const list = side === 'l' ? lefts : rights;
    const previous = list[index];
    if (previous === undefined) return;
    const next = [...list];
    next[index] = value;
    (side === 'l' ? setLefts : setRights)(next);
    setCorrect((prev) =>
      prev.map((p) =>
        side === 'l'
          ? p.left === previous
            ? { ...p, left: value }
            : p
          : p.right === previous
            ? { ...p, right: value }
            : p,
      ),
    );
  };

  const removeEntry = (side: 'l' | 'r', index: number) => {
    setError(null);
    const list = side === 'l' ? lefts : rights;
    const removed = list[index];
    if (removed === undefined) return;
    (side === 'l' ? setLefts : setRights)(list.filter((_, i) => i !== index));
    setCorrect((prev) => prev.filter((p) => (side === 'l' ? p.left !== removed : p.right !== removed)));
    /*
      Image slots are keyed by INDEX, so removing a row shifts every slot after
      it. Re-keying rather than leaving them is what stops row 3's photograph
      reappearing against row 2's statement — a wrong picture on a question
      about signage is a wrong question, not a cosmetic fault.
    */
    setImages((prev) => {
      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(prev)) {
        const keySide = key.slice(0, 1) as 'l' | 'r';
        const keyIndex = Number(key.slice(1));
        if (keySide !== side) next[key] = value;
        else if (keyIndex < index) next[key] = value;
        else if (keyIndex > index) next[slotKey(side, keyIndex - 1)] = value;
        // keyIndex === index is the removed row's own slot, and is dropped.
      }
      return next;
    });
  };

  const addEntry = (side: 'l' | 'r') => {
    setError(null);
    (side === 'l' ? setLefts : setRights)((prev: string[]) => [...prev, '']);
  };

  const save = () => {
    const result = buildFromDraft({
      lefts: lefts.map((l) => l.trim()).filter(Boolean),
      rights: rights.map((r) => r.trim()).filter(Boolean),
      correct: correct.map((p) => ({ left: p.left.trim(), right: p.right.trim() })),
    });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const next: MatchPresentation = {
      mode,
      ...(leftImages ? { leftImages: true } : {}),
      ...(rightImages ? { rightImages: true } : {}),
      ...(Object.keys(images).length > 0 ? { images } : {}),
    };
    onSave(result.built, next);
  };

  const optionCount = lefts.filter((l) => l.trim()).length * rights.filter((r) => r.trim()).length;

  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-border bg-surface-card p-4">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block text-[14.5px] font-semibold">Matching pairs</span>
          <span className="mt-0.5 block text-[11.5px] text-text-tertiary">
            {lefts.length} prompt{lefts.length === 1 ? '' : 's'} × {rights.length} answer
            {rights.length === 1 ? '' : 's'} · {optionCount} pairing
            {optionCount === 1 ? '' : 's'} · {correct.length} keyed correct
          </span>
        </span>
      </div>

      {seed.note && (
        <p className={`rounded-[10px] border p-[8px_10px] text-[11.5px] ${ORIGIN_TONE[seed.origin]}`}>
          {seed.note}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <EntryList
          title="Statements"
          side="l"
          entries={lefts}
          images={images}
          showImages={leftImages}
          onToggleImages={() => setLeftImages((v) => !v)}
          onRename={renameEntry}
          onRemove={removeEntry}
          onAdd={() => addEntry('l')}
          onImage={(key, assetKey) => setImages((prev) => ({ ...prev, [key]: assetKey }))}
        />
        <EntryList
          title="Matches"
          side="r"
          entries={rights}
          images={images}
          showImages={rightImages}
          onToggleImages={() => setRightImages((v) => !v)}
          onRename={renameEntry}
          onRemove={removeEntry}
          onAdd={() => addEntry('r')}
          onImage={(key, assetKey) => setImages((prev) => ({ ...prev, [key]: assetKey }))}
        />
      </div>

      {lefts.length > 0 && rights.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11.5px] font-semibold text-text-secondary">
            Tick the correct pairings
          </span>
          <div className="fai-scroll overflow-auto">
            <table className="w-full border-collapse text-[11.5px]">
              <thead>
                <tr>
                  <th className="border-b border-border-subtle p-[6px_8px] text-left font-semibold text-text-tertiary">
                    Statement
                  </th>
                  {rights.map((right, i) => (
                    <th
                      key={`h${i}`}
                      className="border-b border-border-subtle p-[6px_8px] text-left font-semibold text-text-tertiary"
                    >
                      {right || <em className="text-text-tertiary">(blank)</em>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lefts.map((left, li) => (
                  <tr key={`r${li}`}>
                    <td className="border-b border-border-subtle p-[6px_8px] text-text-secondary">
                      {left || <em className="text-text-tertiary">(blank)</em>}
                    </td>
                    {rights.map((right, ri) => {
                      const on = isPaired(left, right);
                      return (
                        <td key={`c${li}-${ri}`} className="border-b border-border-subtle p-[4px_8px]">
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={on}
                            aria-label={`${left || 'blank'} matches ${right || 'blank'}`}
                            disabled={!left.trim() || !right.trim()}
                            onClick={() => togglePair(left, right)}
                            className={`grid h-[22px] w-[22px] place-items-center rounded-md border disabled:opacity-40 ${
                              on
                                ? 'border-accent bg-accent text-accent-contrast'
                                : 'border-border text-text-tertiary hover:bg-surface-hover'
                            }`}
                          >
                            {on && <Icon name="check" size={12} />}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {unpaired.length > 0 && (
        <p className="rounded-[10px] border border-warning bg-warning-soft p-[8px_10px] text-[11.5px] text-warning-text">
          {unpaired.length} statement{unpaired.length === 1 ? ' has' : 's have'} no correct match yet
          {' — '}
          {unpaired.join(', ')}. Marking is an exact set, so a candidate who pairs
          {unpaired.length === 1 ? ' it' : ' them'} correctly is still marked wrong.
        </p>
      )}

      <div className="flex items-center gap-2">
        <span className="text-[11.5px] font-semibold text-text-secondary">On screen</span>
        {MATCH_MODES.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            className={`inline-flex h-[27px] items-center rounded-lg border px-2.5 text-[11px] font-semibold ${
              mode === m
                ? 'border-accent bg-surface-accent-soft text-text-accent'
                : 'border-border text-text-secondary hover:bg-surface-hover'
            }`}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
        <span className="text-[11px] text-text-tertiary">Presentation only — never how it is marked.</span>
      </div>

      {multiAnswerPrompts.length > 0 && (
        <p className="rounded-[10px] border border-warning bg-warning-soft p-[8px_10px] text-[11.5px] text-warning-text">
          {multiAnswerPrompts.join(', ')} {multiAnswerPrompts.length === 1 ? 'has' : 'have'} more
          than one correct match, which an on-screen line or drag cannot express — one answer per
          statement is all either shape allows. This question will render as the grouped list
          instead, which can. The key itself is unaffected.
        </p>
      )}

      {error && (
        <p role="alert" className="rounded-[10px] border border-danger bg-danger-soft p-[8px_10px] text-[11.5px] text-danger-text">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          className="inline-flex h-[30px] items-center gap-1.5 rounded-lg bg-accent px-3 text-[11.5px] font-semibold text-accent-contrast"
        >
          <Icon name="check" size={13} />
          Save pairs
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-[30px] items-center rounded-lg border border-border px-3 text-[11.5px] font-semibold text-text-secondary hover:bg-surface-hover"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

interface EntryListProps {
  title: string;
  side: 'l' | 'r';
  entries: string[];
  images: Record<string, string>;
  showImages: boolean;
  onToggleImages: () => void;
  onRename: (side: 'l' | 'r', index: number, value: string) => void;
  onRemove: (side: 'l' | 'r', index: number) => void;
  onAdd: () => void;
  onImage: (key: string, assetKey: string) => void;
}

function EntryList({
  title,
  side,
  entries,
  images,
  showImages,
  onToggleImages,
  onRename,
  onRemove,
  onAdd,
  onImage,
}: EntryListProps) {
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border border-border-subtle p-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[11.5px] font-semibold text-text-secondary">{title}</span>
        <label className="inline-flex items-center gap-1.5 text-[11px] text-text-tertiary">
          <input type="checkbox" checked={showImages} onChange={onToggleImages} />
          Images
        </label>
      </div>

      {entries.map((entry, i) => (
        <div key={`${side}${i}`} className="flex items-start gap-1.5">
          <span className="mt-[7px] w-4 flex-none text-[11px] text-text-tertiary">{i + 1}</span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <input
              value={entry}
              aria-label={`${title} ${i + 1}`}
              onChange={(e) => onRename(side, i, e.target.value)}
              className="h-[30px] w-full rounded-lg border border-border bg-surface-page px-2 text-[11.5px]"
            />
            {showImages && (
              <ImageSlot
                slot={slotKey(side, i)}
                assetKey={images[slotKey(side, i)]}
                onUploaded={onImage}
              />
            )}
          </span>
          <button
            type="button"
            aria-label={`Remove ${title} ${i + 1}`}
            onClick={() => onRemove(side, i)}
            className="mt-[2px] grid h-[26px] w-[26px] flex-none place-items-center rounded-lg border border-border text-text-tertiary hover:bg-surface-hover"
          >
            <Icon name="trash-2" size={12} />
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={onAdd}
        className="inline-flex h-[27px] items-center gap-1.5 self-start rounded-lg border border-border px-2.5 text-[11px] font-semibold text-text-secondary hover:bg-surface-hover"
      >
        <Icon name="plus" size={12} />
        Add
      </button>
    </div>
  );
}

interface ImageSlotProps {
  slot: string;
  assetKey?: string;
  onUploaded: (slot: string, assetKey: string) => void;
}

/**
 * One row's picture.
 *
 * NOT a port of the handoff's `image-slot.js`. That element persists through a
 * `.image-slots.state.json` sidecar the design tool writes beside the document,
 * which has no meaning outside it. This posts to the repo's existing `/uploads`
 * route — the same door, the same validator and the same org-scoped storage
 * namespace as every other attachment — and keeps only the returned storage
 * KEY, because `MatchPresentation.images` reaches the field served to a fill
 * surface and a data URL there would put a few hundred kilobytes of base64 into
 * every copy of it.
 */
function ImageSlot({ slot, assetKey, onUploaded }: ImageSlotProps) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setFailed(false);
    try {
      const ref = await uploadAttachment<{ key: string }>('/uploads', file);
      onUploaded(slot, ref.key);
    } catch {
      // A slot that silently stayed empty reads as "no picture printed", which
      // is a different statement from "the upload failed".
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="flex items-center gap-1.5">
      <label className="inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2 text-[11px] text-text-secondary hover:bg-surface-hover">
        <Icon name="image" size={12} />
        {busy ? 'Uploading…' : assetKey ? 'Replace' : 'Add image'}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => void upload(e.target.files?.[0])}
        />
      </label>
      {assetKey && !busy && <Icon name="check" size={12} className="text-text-accent" />}
      {failed && <span className="text-[11px] text-danger-text">Upload failed — try again.</span>}
    </span>
  );
}
