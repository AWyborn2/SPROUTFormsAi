import { useMemo, useState } from 'react';
import {
  groupPairingOptions,
  matchAnchorKey,
  pairingOption,
  parsePairingOption,
  type MatchPresentation,
} from '@formai/shared';

/**
 * A matching question a candidate can actually manipulate.
 *
 * THE VALUE IS UNCHANGED, AND THAT IS THE WHOLE CONTRACT. Whatever the
 * candidate does on screen, what gets stored is the same array of pairing
 * strings the grouped checkbox list produces — `"statement -> answer"`, built by
 * `pairingOption`. `markTheory` compares that array against `answerKey` as an
 * exact set and looks at nothing else, so marking, storage, the evidence export
 * and every existing test are untouched by this file. `matchPresentation` is
 * render-only by type for exactly this reason: if presentation could reach
 * marking there would be two places a question's verdict comes from.
 *
 * THE GROUPED LIST STAYS THE FALLBACK. A question with no `matchPresentation`
 * renders as it always has, and so does one whose presentation this component
 * cannot honour. The list is not a degraded mode — it is readable, accessible
 * and correct, and it is what every already-authored matching question uses.
 *
 * ONE ANSWER PER STATEMENT, ON SCREEN. The underlying model permits a
 * non-bijection — "match each hazard to its control" may pair one hazard with
 * two controls — but neither of these presentations can express that: a line
 * from a dot, or a card in a slot, is singular by shape. So the interactive
 * REPLACES a statement's pairing rather than adding to it.
 *
 * WHICH MEANS THE GUARD BELONGS AT AUTHORING TIME, NOT HERE. This component
 * cannot check the question against its key, because `stripMarkingSecrets`
 * removes `answerKey` from every payload a fill surface receives — by design,
 * and rightly. So the pair builder is where a non-bijective key is refused an
 * interactive presentation; by the time a candidate sees this, the choice has
 * already been made by somebody who could see the key.
 */

export interface MatchingFieldProps {
  options: readonly string[];
  value: readonly string[];
  presentation: MatchPresentation;
  disabled?: boolean;
  labelId: string;
  onChange: (next: string[]) => void;
}

/** Every distinct answer, in the order the options were built. */
function rightsOf(options: readonly string[]): string[] {
  const seen: string[] = [];
  for (const option of options) {
    const parsed = parsePairingOption(option);
    if (parsed && !seen.includes(parsed.right)) seen.push(parsed.right);
  }
  return seen;
}

/** Where an uploaded picture is served from — the same door every attachment uses. */
const IMAGE_BASE = '/api/uploads/file/';

function EntryImage({ src, alt, className }: { src: string | undefined; alt: string; className?: string }) {
  if (!src) return null;
  return (
    <img
      src={src}
      alt={alt}
      className={className ?? 'mb-1 block max-h-24 w-auto max-w-full rounded-md border border-border-subtle object-contain'}
    />
  );
}

export function MatchingField({
  options,
  value,
  presentation,
  disabled = false,
  labelId,
  onChange,
}: MatchingFieldProps) {
  const groups = useMemo(() => groupPairingOptions(options), [options]);
  const rights = useMemo(() => rightsOf(options), [options]);
  const [pickedLeft, setPickedLeft] = useState<string | null>(null);

  const chosen = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of value) {
      const parsed = parsePairingOption(option);
      if (parsed) map.set(parsed.left, parsed.right);
    }
    return map;
  }, [value]);

  const pair = (left: string, right: string | null) => {
    if (disabled) return;
    const kept = value.filter((option) => parsePairingOption(option)?.left !== left);
    onChange(right ? [...kept, pairingOption(left, right)] : kept);
    setPickedLeft(null);
  };

  const mode = presentation.mode;
  const imgMap = presentation.images ?? {};
  const hasImages = presentation.leftImages || presentation.rightImages;

  const pictureFor = (side: 'l' | 'r', index: number): string | undefined => {
    const on = side === 'l' ? presentation.leftImages : presentation.rightImages;
    if (!on || index < 0) return undefined;
    const key = imgMap[matchAnchorKey(side, index)];
    return key ? `${IMAGE_BASE}${key}` : undefined;
  };

  const [draggingRight, setDraggingRight] = useState<string | null>(null);

  const dropOn = (left: string) => {
    if (disabled || !draggingRight) return;
    pair(left, draggingRight);
    setDraggingRight(null);
  };

  if (hasImages) {
    return <ImageMatchLayout
      groups={groups}
      rights={rights}
      chosen={chosen}
      pair={pair}
      pickedLeft={pickedLeft}
      setPickedLeft={setPickedLeft}
      draggingRight={draggingRight}
      setDraggingRight={setDraggingRight}
      dropOn={dropOn}
      disabled={disabled}
      mode={mode}
      labelId={labelId}
      pictureFor={pictureFor}
    />;
  }

  return (
    <div className="flex flex-col gap-2" role="group" aria-labelledby={labelId}>
      {mode === 'drag' && (
        <div className="flex flex-wrap gap-1.5 rounded-[10px] border border-dashed border-border bg-surface-sunken p-2">
          <span className="w-full text-[11px] text-text-tertiary">
            Drag an answer onto a statement, or tap a statement to choose one.
          </span>
          {rights.map((right, i) => (
            <span
              key={right}
              draggable={!disabled}
              onDragStart={(e) => {
                if (e.dataTransfer) {
                  e.dataTransfer.effectAllowed = 'copy';
                  e.dataTransfer.setData('text/plain', right);
                }
                setDraggingRight(right);
              }}
              onDragEnd={() => setDraggingRight(null)}
              className={`inline-flex max-w-full flex-col rounded-lg border px-2.5 py-1 text-[12px] ${
                disabled ? 'border-border text-text-tertiary' : 'cursor-grab border-border text-text-secondary'
              } ${draggingRight === right ? 'opacity-50' : ''}`}
            >
              <EntryImage src={pictureFor('r', i)} alt={right} />
              {right}
            </span>
          ))}
        </div>
      )}

      {groups.map((group, leftIndex) => {
        const answer = chosen.get(group.left) ?? null;
        const picking = pickedLeft === group.left;
        const over = draggingRight !== null;

        return (
          <div
            key={group.left}
            onDragOver={(e) => {
              if (disabled || !draggingRight) return;
              e.preventDefault();
              if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            }}
            onDrop={(e) => {
              e.preventDefault();
              dropOn(group.left);
            }}
            className={`rounded-[10px] border p-2.5 ${
              picking || over ? 'border-accent bg-surface-accent-soft' : 'border-border-subtle'
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={disabled}
                aria-pressed={picking}
                onClick={() => setPickedLeft(picking ? null : group.left)}
                className="min-w-0 flex-1 text-left text-[13px] font-semibold text-text-secondary disabled:opacity-60"
              >
                <EntryImage src={pictureFor('l', leftIndex)} alt={group.left} />
                {group.left}
              </button>

              {answer ? (
                <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-accent bg-accent px-2.5 py-1 text-[12px] font-semibold text-accent-contrast">
                  <EntryImage src={pictureFor('r', rights.indexOf(answer))} alt={answer} />
                  {answer}
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`Clear the answer for ${group.left}`}
                    onClick={() => pair(group.left, null)}
                    className="leading-none"
                  >
                    ×
                  </button>
                </span>
              ) : (
                <span className="text-[11.5px] text-text-tertiary">
                  {mode === 'line' ? 'Choose an answer' : 'Drop an answer here, or tap to choose'}
                </span>
              )}
            </div>

            {picking && !disabled && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {rights.map((right) => (
                  <button
                    key={right}
                    type="button"
                    aria-label={`Match ${group.left} to ${right}`}
                    onClick={() => pair(group.left, right)}
                    className={`rounded-lg border px-2.5 py-1 text-[12px] ${
                      answer === right
                        ? 'border-accent bg-surface-accent-soft font-semibold text-text-accent'
                        : 'border-border text-text-secondary hover:bg-surface-hover'
                    }`}
                  >
                    <EntryImage src={pictureFor('r', rights.indexOf(right))} alt={right} />
                    {right}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Two-column image layout                                           */
/* ------------------------------------------------------------------ */

interface ImageMatchLayoutProps {
  groups: ReturnType<typeof groupPairingOptions>;
  rights: string[];
  chosen: Map<string, string>;
  pair: (left: string, right: string | null) => void;
  pickedLeft: string | null;
  setPickedLeft: (v: string | null) => void;
  draggingRight: string | null;
  setDraggingRight: (v: string | null) => void;
  dropOn: (left: string) => void;
  disabled: boolean;
  mode: string;
  labelId: string;
  pictureFor: (side: 'l' | 'r', index: number) => string | undefined;
}

function ImageMatchLayout({
  groups,
  rights,
  chosen,
  pair,
  pickedLeft,
  setPickedLeft,
  draggingRight,
  setDraggingRight,
  dropOn,
  disabled,
  mode,
  labelId,
  pictureFor,
}: ImageMatchLayoutProps) {
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-3">
      <p className="text-[11px] text-text-tertiary">
        {mode === 'drag'
          ? 'Drag an answer card onto a statement, or tap a statement then tap an answer.'
          : 'Tap a statement, then tap the matching answer.'}
      </p>

      <div className="grid grid-cols-2 gap-4">
        {/* -------- LEFT COLUMN: Statements -------- */}
        <div className="flex flex-col gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
            Statements
          </span>
          {groups.map((group, leftIndex) => {
            const answer = chosen.get(group.left) ?? null;
            const picking = pickedLeft === group.left;
            const isOver = draggingRight !== null;

            return (
              <div
                key={group.left}
                onDragOver={(e) => {
                  if (disabled || !draggingRight) return;
                  e.preventDefault();
                  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  dropOn(group.left);
                }}
                className={`relative flex flex-col rounded-lg border p-2 transition-colors ${
                  picking
                    ? 'border-accent bg-surface-accent-soft'
                    : isOver
                      ? 'border-dashed border-accent/60 bg-surface-accent-soft/40'
                      : answer
                        ? 'border-accent/40 bg-surface-card'
                        : 'border-border-subtle bg-surface-card'
                }`}
              >
                <button
                  type="button"
                  disabled={disabled}
                  aria-pressed={picking}
                  onClick={() => setPickedLeft(picking ? null : group.left)}
                  className="text-left disabled:opacity-60"
                >
                  <EntryImage
                    src={pictureFor('l', leftIndex)}
                    alt={group.left}
                    className="mb-1.5 block h-auto w-full max-w-full rounded border border-border-subtle object-contain"
                  />
                  <span className="block text-[12px] leading-snug text-text-secondary">
                    {group.left}
                  </span>
                </button>

                {answer ? (
                  <div className="mt-2 flex items-center gap-1.5 rounded border border-accent/30 bg-surface-accent-soft/60 px-2 py-1">
                    <EntryImage
                      src={pictureFor('r', rights.indexOf(answer))}
                      alt={answer}
                      className="block h-8 w-8 rounded object-contain"
                    />
                    <span className="flex-1 truncate text-[11px] font-medium text-text-accent">
                      {answer}
                    </span>
                    <button
                      type="button"
                      disabled={disabled}
                      aria-label={`Clear the answer for ${group.left}`}
                      onClick={() => pair(group.left, null)}
                      className="shrink-0 text-[11px] text-text-tertiary hover:text-danger"
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <span className="mt-2 block text-center text-[10.5px] text-text-tertiary">
                    {picking ? 'Pick an answer from the right' : 'Tap to pair'}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* -------- RIGHT COLUMN: Answers -------- */}
        <div className="flex flex-col gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
            Answers
          </span>
          {rights.map((right, i) => {
            const isUsed = [...chosen.values()].includes(right);
            return (
              <button
                key={right}
                type="button"
                draggable={mode === 'drag' && !disabled}
                onDragStart={(e) => {
                  if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = 'copy';
                    e.dataTransfer.setData('text/plain', right);
                  }
                  setDraggingRight(right);
                }}
                onDragEnd={() => setDraggingRight(null)}
                disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  if (pickedLeft) {
                    pair(pickedLeft, right);
                  }
                }}
                className={`flex flex-col rounded-lg border p-2 text-left transition-colors ${
                  draggingRight === right
                    ? 'opacity-50'
                    : ''
                } ${
                  pickedLeft
                    ? 'cursor-pointer border-accent/40 hover:border-accent hover:bg-surface-accent-soft'
                    : mode === 'drag' && !disabled
                      ? 'cursor-grab border-border'
                      : 'border-border'
                } ${
                  isUsed ? 'bg-surface-sunken opacity-70' : 'bg-surface-card'
                }`}
              >
                <EntryImage
                  src={pictureFor('r', i)}
                  alt={right}
                  className="mb-1.5 block h-auto w-full max-w-full rounded border border-border-subtle object-contain"
                />
                <span className="block text-[12px] leading-snug text-text-secondary">
                  {right}
                </span>
                {isUsed && (
                  <span className="mt-1 text-[10px] font-medium text-text-accent">
                    Paired
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
