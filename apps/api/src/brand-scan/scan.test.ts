import { describe, expect, it, vi } from 'vitest';
import { pickFont, rankColors, runBrandScan, type Fetcher } from './scan.js';
import type { SafeFetchResult } from './safe-fetch.js';

function reply(url: string, body: string, contentType = 'text/html'): SafeFetchResult {
  return { url, status: 200, contentType, body };
}

/** A fetcher backed by a fixed map of URL -> body. Anything else rejects. */
function fakeFetcher(pages: Record<string, string>): Fetcher {
  return vi.fn(async (url: string) => {
    const body = pages[url];
    if (body === undefined) throw new Error(`no fixture for ${url}`);
    return reply(url, body);
  });
}

const PAGE = 'https://example.com/';

describe('runBrandScan', () => {
  it('proposes a palette, font and logo from a well-marked-up page', async () => {
    const fetcher = fakeFetcher({
      [PAGE]: `
        <meta name="theme-color" content="#3366cc">
        <meta property="og:site_name" content="Example Co">
        <link rel="apple-touch-icon" href="/touch.png">
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lora">
      `,
    });

    const out = await runBrandScan(PAGE, fetcher);
    expect(out.siteName).toBe('Example Co');
    expect(out.colors.primary).toBe('#3366cc');
    expect(out.font).toBe('Lora');
    expect(out.logoCandidates).toContain('https://example.com/touch.png');
    expect(out.empty).toBe(false);
  });

  it('reads the manifest when one is declared', async () => {
    const fetcher = fakeFetcher({
      [PAGE]: '<link rel="manifest" href="/m.json">',
      'https://example.com/m.json': JSON.stringify({
        theme_color: '#cc2244',
        icons: [{ src: '/icon-512.png', sizes: '512x512' }],
      }),
    });

    const out = await runBrandScan(PAGE, fetcher);
    expect(out.palette).toContain('#cc2244');
    expect(out.logoCandidates).toContain('https://example.com/icon-512.png');
  });

  it('reads linked stylesheets for brand variables', async () => {
    const fetcher = fakeFetcher({
      [PAGE]: '<link rel="stylesheet" href="/s.css">',
      'https://example.com/s.css': ':root{--brand-primary:#0d7a4f}',
    });

    const out = await runBrandScan(PAGE, fetcher);
    expect(out.colors.primary).toBe('#0d7a4f');
  });

  /**
   * Covers R16. A sub-resource that fails must not sink the whole scan — the
   * page-level signals still stand on their own.
   */
  it('survives a manifest or stylesheet that cannot be fetched', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === PAGE) {
        return reply(
          PAGE,
          '<meta name="theme-color" content="#3366cc"><link rel="manifest" href="/gone.json">',
        );
      }
      throw new Error('404');
    });

    const out = await runBrandScan(PAGE, fetcher);
    expect(out.colors.primary).toBe('#3366cc');
  });

  /** Covers R16. Nothing found is a valid outcome that degrades to manual. */
  it('reports empty for a page with no signals', async () => {
    const out = await runBrandScan(PAGE, fakeFetcher({ [PAGE]: '<p>hello</p>' }));
    expect(out.empty).toBe(true);
    expect(out.notes.join(' ')).toMatch(/pick them by hand|upload one/);
  });

  it('explains when a site is client-rendered and yielded nothing', async () => {
    const fetcher = fakeFetcher({ [PAGE]: `<div id="root"></div>${'x'.repeat(3000)}` });
    const out = await runBrandScan(PAGE, fetcher);
    expect(out.notes.join(' ')).toMatch(/renders most of its styling in the browser/);
  });

  /**
   * The scan never writes anything; a hostile page can at worst produce a bad
   * suggestion that the owner sees and rejects.
   */
  it('returns a proposal without persisting anything', async () => {
    const fetcher = fakeFetcher({
      [PAGE]: '<meta name="theme-color" content="#3366cc">',
    });
    const out = await runBrandScan(PAGE, fetcher);
    expect(out).not.toHaveProperty('saved');
    expect(out.sourceUrl).toBe(PAGE);
  });

  it('propagates a fetch failure on the page itself', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('blocked');
    });
    await expect(runBrandScan(PAGE, fetcher)).rejects.toThrow('blocked');
  });
});

describe('rankColors', () => {
  it('dedupes, drops greyscale, and caps the palette', () => {
    const out = rankColors([
      '#3366CC',
      '#3366cc',
      '#ffffff',
      '#111111',
      '#cc2244',
      '#0d7a4f',
      '#884400',
      '#553311',
      '#221199',
      '#777777',
    ]);
    expect(out[0]).toBe('#3366cc');
    expect(out).not.toContain('#ffffff');
    expect(out.length).toBeLessThanOrEqual(6);
    expect(new Set(out).size).toBe(out.length);
  });

  it('preserves source order, so theme-color stays first', () => {
    expect(rankColors(['#cc2244', '#0d7a4f'])[0]).toBe('#cc2244');
  });
});

describe('pickFont', () => {
  it('takes the first family the catalog knows', () => {
    expect(pickFont(['Definitely Not A Font', 'Lora'])).toBe('Lora');
  });

  /**
   * A site's real font is often self-hosted or licensed. Proposing it anyway
   * would produce a theme that silently renders as the fallback stack, so the
   * scan says so instead of guessing.
   */
  it('explains rather than guessing when nothing is available', () => {
    const notes: string[] = [];
    expect(pickFont(['Proprietary Brand Sans'], notes)).toBeNull();
    expect(notes.join(' ')).toMatch(/isn't available in the font picker/);
  });

  it('returns null with no note when no fonts were found at all', () => {
    const notes: string[] = [];
    expect(pickFont([], notes)).toBeNull();
    expect(notes).toEqual([]);
  });
});
