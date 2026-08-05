// @vitest-environment jsdom
/**
 * The pair builder.
 *
 * The build rules themselves live in `matching.ts` and are tested there; the
 * seeding and the refusal-to-value conversion are tested without a DOM in
 * `matching-authoring.test.ts`. What is left for this file is what only the
 * component decides: that a ticked cell becomes a keyed pairing, that a
 * question which will not build is never handed upward, and that the three
 * edits which can silently corrupt a keyed question — renaming a half, removing
 * a row, choosing a presentation — do not.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { pairingOption } from '@formai/shared';
import { PairBuilder } from './PairBuilder.js';
import { seedFromField } from './matching-authoring.js';

vi.mock('@formai/ui', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

function seed(lefts: string[], rights: string[]) {
  return { lefts, rights, correct: [], origin: 'both_sides' as const };
}

const tick = (name: string) => fireEvent.click(screen.getByRole('checkbox', { name }));
const save = () => fireEvent.click(screen.getByRole('button', { name: /save pairs/i }));

describe('PairBuilder', () => {
  it('builds the options and key from the ticked pairings', () => {
    const onSave = vi.fn();
    render(
      <PairBuilder
        seed={seed(['Restricted area', 'Fire point'], ['Red triangle', 'Red square'])}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    tick('Restricted area matches Red triangle');
    tick('Fire point matches Red square');
    save();

    expect(onSave).toHaveBeenCalledTimes(1);
    const [built] = onSave.mock.calls[0]!;
    // Every left × every right, grouped by left — the shape `matching.ts` builds.
    expect(built.options).toEqual([
      pairingOption('Restricted area', 'Red triangle'),
      pairingOption('Restricted area', 'Red square'),
      pairingOption('Fire point', 'Red triangle'),
      pairingOption('Fire point', 'Red square'),
    ]);
    expect(built.answerKey).toEqual([
      pairingOption('Restricted area', 'Red triangle'),
      pairingOption('Fire point', 'Red square'),
    ]);
  });

  it('refuses to save a question that will not build, and says why in place', () => {
    // A question with no correct pairing marks nobody. Saving it would put an
    // unanswerable question in a section that must be passed.
    const onSave = vi.fn();
    render(
      <PairBuilder seed={seed(['Restricted area'], ['Red triangle'])} onSave={onSave} onCancel={() => {}} />,
    );

    save();

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('at least one correct pairing');
  });

  it('surfaces the shared refusal verbatim rather than rewording it', () => {
    render(
      <PairBuilder
        seed={seed(['Restricted area', 'Restricted area'], ['Red triangle'])}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );

    // Two identical prompts render two cells with the same accessible name —
    // which is exactly the ambiguity the build refuses. Tick the first.
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Restricted area matches Red triangle' })[0]!);
    save();

    expect(screen.getByRole('alert').textContent).toContain('Duplicate prompt "Restricted area"');
  });

  it('lets one prompt hold more than one correct match', () => {
    // The model permits non-bijections deliberately — "match each hazard to its
    // control" may pair one hazard with two controls. Radio behaviour here
    // would make an authorable printed shape unauthorable.
    const onSave = vi.fn();
    render(
      <PairBuilder
        seed={seed(['Restricted area'], ['Red triangle', 'Red square'])}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    tick('Restricted area matches Red triangle');
    tick('Restricted area matches Red square');
    save();

    expect(onSave.mock.calls[0]![0].answerKey).toHaveLength(2);
  });

  it('unticking removes exactly the one pairing', () => {
    const onSave = vi.fn();
    render(
      <PairBuilder
        seed={seed(['Restricted area'], ['Red triangle', 'Red square'])}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    tick('Restricted area matches Red triangle');
    tick('Restricted area matches Red square');
    tick('Restricted area matches Red triangle');
    save();

    expect(onSave.mock.calls[0]![0].answerKey).toEqual([pairingOption('Restricted area', 'Red square')]);
  });

  it('carries a prompt’s pairings through a rename', () => {
    /*
      The key stores the TEXT of both halves. Fixing a typo after keying would
      otherwise orphan every pairing naming the old text, and the build would
      refuse with "which is not listed" — which reads as a bug rather than as
      the consequence of the edit the author just made.
    */
    const onSave = vi.fn();
    render(
      <PairBuilder seed={seed(['Restrictd area'], ['Red triangle'])} onSave={onSave} onCancel={() => {}} />,
    );

    tick('Restrictd area matches Red triangle');
    fireEvent.change(screen.getByLabelText('Statements 1'), {
      target: { value: 'Restricted area' },
    });
    save();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0].answerKey).toEqual([
      pairingOption('Restricted area', 'Red triangle'),
    ]);
  });

  it('warns when a statement has no correct match, without blocking the save', () => {
    // A partially-keyed question builds, so this cannot be an error — but
    // exact-set marking fails every candidate who pairs the unkeyed statement
    // correctly, so it cannot be silence either.
    render(
      <PairBuilder
        seed={seed(['Restricted area', 'Fire point'], ['Red triangle'])}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );

    tick('Restricted area matches Red triangle');

    expect(screen.getByText(/no correct match yet/).textContent).toContain('Fire point');
    const saveButton = screen.getByRole('button', { name: /save pairs/i }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
  });

  it('shows the seed note when a side is missing', () => {
    render(
      <PairBuilder
        seed={seedFromField({ matchLeft: ['Restricted area'] })}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/Only the prompts were read/)).toBeTruthy();
  });

  it('records the presentation without letting it reach the key', () => {
    // matchPresentation is render-only by type. If it could reach marking there
    // would be two places a question's verdict comes from.
    const onSave = vi.fn();
    render(
      <PairBuilder seed={seed(['Restricted area'], ['Red triangle'])} onSave={onSave} onCancel={() => {}} />,
    );

    tick('Restricted area matches Red triangle');
    fireEvent.click(screen.getByRole('button', { name: /drag to match/i }));
    save();

    const [built, presentation] = onSave.mock.calls[0]!;
    expect(presentation.mode).toBe('drag');
    expect(built.answerKey).toEqual([pairingOption('Restricted area', 'Red triangle')]);
    expect(JSON.stringify(built)).not.toContain('drag');
  });

  it('drops a removed row’s image and shifts the ones after it down', () => {
    /*
      Image slots are keyed by index. Leaving them alone on a removal would show
      row 3's photograph against row 2's statement — on a question about
      signage that is a different question, not a cosmetic fault.
    */
    const onSave = vi.fn();
    render(
      <PairBuilder
        seed={seed(['One', 'Two', 'Three'], ['A'])}
        presentation={{ mode: 'line', leftImages: true, images: { l0: 'k0', l1: 'k1', l2: 'k2' } }}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove Statements 2' }));
    tick('One matches A');
    save();

    // l1 ("Two") is gone; l2 ("Three") has moved down into l1.
    expect(onSave.mock.calls[0]![1].images).toEqual({ l0: 'k0', l1: 'k2' });
  });

  it('removing a row drops the pairings that named it', () => {
    // Otherwise the key still names a prompt the question no longer offers, and
    // the build refuses with a message about a row the author cannot see.
    const onSave = vi.fn();
    render(
      <PairBuilder seed={seed(['One', 'Two'], ['A'])} onSave={onSave} onCancel={() => {}} />,
    );

    tick('One matches A');
    tick('Two matches A');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Statements 2' }));
    save();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0].answerKey).toEqual([pairingOption('One', 'A')]);
  });
});
