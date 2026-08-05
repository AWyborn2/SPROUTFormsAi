/**
 * Editing a client's brand by describing the change.
 *
 * Every test here is about NOT TRUSTING WHAT COMES BACK. A theme value ends up
 * in a CSS custom property on a page a client's staff will open, so "the model
 * returned it" is not a reason to emit it — a colour must be six hex digits, a
 * font must be one the loader can actually request, and every token must be
 * inside its real range.
 *
 * The second property is that a refused value is REPORTED, never corrected.
 * Clamping "400px round" to 40 leaves the author believing the instruction was
 * understood; saying it did nothing is what makes them ask again.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FormBrandKit } from '@formai/shared';
import { BRAND_EDIT_TOOL_NAME, proposeBrandEdit } from './edit.js';

const CURRENT: FormBrandKit = {
  primaryColor: '#253439',
  formFont: 'Inter',
  theme: { radius: 14, density: 'comfortable' },
};

/** An Anthropic stand-in returning one forced tool call. */
function anthropicReturning(input: Record<string, unknown>) {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: 'tool_use', name: BRAND_EDIT_TOOL_NAME, input }],
  });
  return { client: { messages: { create } }, create };
}

describe('proposeBrandEdit', () => {
  it('reports a missing client as a configuration state, not a fault', async () => {
    // Mirrors the extraction path's `extraction_unavailable`, so the route can
    // map it to a 422 and tell an operator what to fix.
    await expect(proposeBrandEdit(CURRENT, 'make it navy')).rejects.toThrow(
      /brand_edit_unavailable/,
    );
  });

  it('returns the patch as a patch — only what changed', async () => {
    const { client } = anthropicReturning({
      primaryColor: '#0d1a59',
      summary: 'Navy primary.',
    });
    const result = await proposeBrandEdit(CURRENT, 'make it navy', { anthropic: client });
    expect(result.patch).toEqual({ primaryColor: '#0d1a59' });
    expect(result.summary).toBe('Navy primary.');
  });

  it('PUTS THE CURRENT SETTINGS IN THE PROMPT', async () => {
    /*
      "A bit tighter" and "slightly rounder" are relative. Without the starting
      point the model answers them from nothing, which is how "slightly rounder"
      becomes a 40px radius.
    */
    const { client, create } = anthropicReturning({ summary: 'x' });
    await proposeBrandEdit(CURRENT, 'a bit tighter', { anthropic: client });
    const sent = JSON.stringify(create.mock.calls[0]![0]);
    expect(sent).toContain('#253439');
    expect(sent).toContain('theme.radius: 14');
    expect(sent).toContain('a bit tighter');
  });

  it('forces the tool call rather than accepting prose', async () => {
    const { client, create } = anthropicReturning({ summary: 'x' });
    await proposeBrandEdit(CURRENT, 'navy', { anthropic: client });
    expect(create.mock.calls[0]![0]).toMatchObject({
      tool_choice: { type: 'tool', name: BRAND_EDIT_TOOL_NAME },
    });
  });

  it('REFUSES A COLOUR THAT IS NOT A HEX VALUE, and says so', async () => {
    // These reach CSS custom properties on a page a client's staff will open.
    const { client } = anthropicReturning({
      primaryColor: 'url(https://evil.example/x)',
      summary: 'Applied.',
    });
    const result = await proposeBrandEdit(CURRENT, 'brand it', { anthropic: client });
    expect(result.patch.primaryColor).toBeUndefined();
    expect(result.notes.join(' ')).toMatch(/is not a colour/i);
  });

  it('refuses a font the loader cannot request', async () => {
    /*
      An unknown family emits a Google Fonts request that fails, and the form
      renders in a fallback nobody chose — silently, because nothing errored.
    */
    const { client } = anthropicReturning({ formFont: 'Definitely Not A Font', summary: 'x' });
    const result = await proposeBrandEdit(CURRENT, 'use a serif', { anthropic: client });
    expect(result.patch.formFont).toBeUndefined();
    expect(result.notes.join(' ')).toMatch(/not one of the fonts/i);
  });

  it('accepts a font that is in the catalog', async () => {
    const { client } = anthropicReturning({ formFont: 'Roboto', summary: 'x' });
    expect((await proposeBrandEdit(CURRENT, 'use Roboto', { anthropic: client })).patch.formFont).toBe(
      'Roboto',
    );
  });

  it('DROPS AN OUT-OF-RANGE TOKEN rather than clamping it', async () => {
    // Clamping turns "400px round" into a silent 40 and leaves the author
    // believing the instruction was understood.
    const { client } = anthropicReturning({ theme: { radius: 400 }, summary: 'Rounder.' });
    const result = await proposeBrandEdit(CURRENT, 'much rounder', { anthropic: client });
    expect(result.patch.theme?.radius).toBeUndefined();
    expect(result.notes.join(' ')).toMatch(/outside what this setting allows/i);
  });

  it('keeps the legal part of a patch whose other half was refused', async () => {
    // A partly-wrong answer should still land the part that was right, or the
    // author retypes a request that mostly worked.
    const { client } = anthropicReturning({
      theme: { density: 'compact', layout: 'spiral' },
      summary: 'Tighter.',
    });
    const result = await proposeBrandEdit(CURRENT, 'tighter', { anthropic: client });
    expect(result.patch.theme).toEqual({ density: 'compact' });
    expect(result.notes).toHaveLength(1);
  });

  it('passes the model’s own notes through', async () => {
    // "I could not change the logo" is the most useful thing it can say, and
    // it is the thing this cannot do.
    const { client } = anthropicReturning({
      summary: 'Nothing.',
      notes: ['I cannot change the logo — upload one instead.'],
    });
    const result = await proposeBrandEdit(CURRENT, 'use their logo', { anthropic: client });
    expect(result.notes).toContain('I cannot change the logo — upload one instead.');
  });

  it('SAYS SO when a confident-sounding answer changed nothing', async () => {
    /*
      The failure this exists to prevent: the author reads "Navy headings", sees
      nothing move in the preview, and concludes the preview is broken rather
      than that the request did not land.
    */
    const { client } = anthropicReturning({ summary: 'Navy headings and tighter spacing.' });
    const result = await proposeBrandEdit(CURRENT, 'navy', { anthropic: client });
    expect(result.patch).toEqual({});
    expect(result.notes.join(' ')).toMatch(/changed the brand/i);
  });

  it('does not add a "nothing changed" note when something was already refused', async () => {
    // The refusal already explains the empty patch; a second note repeating it
    // is noise on top of the answer.
    const { client } = anthropicReturning({ primaryColor: 'teal-ish', summary: 'x' });
    expect((await proposeBrandEdit(CURRENT, 'teal', { anthropic: client })).notes).toHaveLength(1);
  });

  it('survives a reply with no tool call at all', async () => {
    // Defensive: `tool_choice` makes this near-impossible, and a throw here
    // would surface as a 500 on a cosmetic feature.
    const client = { messages: { create: vi.fn().mockResolvedValue({ content: [] }) } };
    const result = await proposeBrandEdit(CURRENT, 'navy', { anthropic: client });
    expect(result.patch).toEqual({});
    expect(result.summary).toBe('');
  });
});
