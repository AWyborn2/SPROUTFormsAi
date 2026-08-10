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

/**
 * One entry's picture, where the author uploaded one and turned that side on.
 *
 * THE PICTURES WERE STORED AND NEVER SHOWN. `MatchPresentation` has carried
 * `leftImages`, `rightImages` and an asset id per entry since the pair builder
 * could upload them — and this component rendered none of it. On the question
 * that needs it most, "match the statement with the appropriate signage", the
 * candidate was shown the extraction's WORDS for each sign ("Sign photo — red
 * pyramid cone with 'LOCATION … JOB CO-ORDINATOR' placard") instead of the sign.
 * That is not a matching question about signage; it is a reading comprehension
 * question about a description of signage.
 *
 * The text stays underneath rather than being replaced by the picture: it is
 * what the stored answer is keyed on, it is what a screen reader gets, and a
 * photo that fails to load must not leave an unlabelled box.
 */
function EntryImage({ src, alt }: { src: string | undefined; alt: string }) {
  if (!src) return null;
  return (
    <img
      src={src}
      alt={alt}
      className="mb-1 block max-h-24 w-auto max-w-full rounded-md border border-border-subtle object-contain"
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

  /** The answer currently paired to each statement, where one is. */
  const chosen = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of value) {
      const parsed = parsePairingOption(option);
      if (parsed) map.set(parsed.left, parsed.right);
    }
    return map;
  }, [value]);

  /*
    Pairing REPLACES rather than accumulates, because a line from a dot and a
    card in a slot are both singular by shape. Keeping the other statements'
    pairings intact is what makes this an edit rather than a reset.
  */
  const pair = (left: string, right: string | null) => {
    if (disabled) return;
    const kept = value.filter((option) => parsePairingOption(option)?.left !== left);
    onChange(right ? [...kept, pairingOption(left, right)] : kept);
    setPickedLeft(null);
  };

  const mode = presentation.mode;
  const images = presentation.images ?? {};

  /** A side entry's uploaded picture, by its printed index — `l0`, `r2`. */
  const pictureFor = (side: 'l' | 'r', index: number): string | undefined => {
    const on = side === 'l' ? presentation.leftImages : presentation.rightImages;
    if (!on || index < 0) return undefined;
    const key = images[matchAnchorKey(side, index)];
    return key ? `${IMAGE_BASE}${key}` : undefined;
  };

  /*
    DRAG IS A REAL GESTURE NOW, OR THE WORD GOES.

    `mode: 'drag'` rendered "Drop an answer here" over a tap-to-pick control:
    nothing was draggable, nothing accepted a drop, and an author who chose the
    drag presentation shipped a form that told candidates to do something it
    would not let them do. On a competency assessment that reads as a broken
    page, and a candidate who takes the instruction literally gets stuck.

    TAP STILL WORKS, and stays the primary path. A site assessment is filled on
    a phone, where HTML5 drag-and-drop does not fire at all — so drag is an
    ADDITION for the desktop authoring-and-review case, never the only way
    through. Every drop target is also a button.
  */
  const [draggingRight, setDraggingRight] = useState<string | null>(null);

  const dropOn = (left: string) => {
    if (disabled || !draggingRight) return;
    pair(left, draggingRight);
    setDraggingRight(null);
  };

  return (
    <div className="flex flex-col gap-2" role="group" aria-labelledby={labelId}>
      {mode === 'drag' && (
        /*
          The tray is what makes a drag possible: something to drag FROM that
          stays put while the pointer travels. An answer is never removed from
          it — the model lets one sign answer more than one statement, and a
          tray that emptied would make the second pairing undraggable.
        */
        <div className="flex flex-wrap gap-1.5 rounded-[10px] border border-dashed border-border bg-surface-sunken p-2">
          <span className="w-full text-[11px] text-text-tertiary">
            Drag an answer onto a statement, or tap a statement to choose one.
          </span>
          {rights.map((right, i) => (
            <span
              key={right}
              draggable={!disabled}
              onDragStart={(e) => {
                /*
                  The state is what the drop reads; `dataTransfer` is set for
                  the benefit of anything outside this component and is guarded
                  because a synthetic dispatch carries none. A throw here would
                  take down the fill surface mid-assessment over a decoration.
                */
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
              // Without this the browser refuses the drop outright.
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

            {/*
              The answers appear under the statement being paired, rather than
              in a permanent column. On a phone — where a site assessment is
              routinely filled — two columns and a connector line is a layout
              nobody can hit, and the pairing is the same either way.
            */}
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
