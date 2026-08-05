import { useMemo, useState } from 'react';
import { groupPairingOptions, pairingOption, parsePairingOption, type MatchPresentation } from '@formai/shared';

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

  return (
    <div className="flex flex-col gap-2" role="group" aria-labelledby={labelId}>
      {groups.map((group) => {
        const answer = chosen.get(group.left) ?? null;
        const picking = pickedLeft === group.left;

        return (
          <div
            key={group.left}
            className={`rounded-[10px] border p-2.5 ${
              picking ? 'border-accent bg-surface-accent-soft' : 'border-border-subtle'
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
                {group.left}
              </button>

              {answer ? (
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-accent bg-accent px-2.5 py-1 text-[12px] font-semibold text-accent-contrast">
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
                  {mode === 'line' ? 'Choose an answer' : 'Drop an answer here'}
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
