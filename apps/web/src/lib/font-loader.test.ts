import { describe, expect, it, vi } from 'vitest';
import { ensureFontLoaded, googleFontsCss2Url } from './font-loader.js';

/**
 * The loader touches the DOM, but the web vitest project runs in `node` (see
 * `apps/web/vitest.config.ts` — no jsdom is installed). `ensureFontLoaded`
 * therefore takes the document as an injectable second argument, defaulting
 * to the real `document`, and these tests hand it a minimal stand-in that
 * implements exactly the three members the loader uses.
 */
interface FakeLink {
  id: string;
  rel: string;
  href: string;
  crossOrigin: string;
}

function fakeDoc(over: { createElement?: () => FakeLink } = {}) {
  const appended: FakeLink[] = [];
  const doc = {
    getElementById: (id: string) => appended.find((el) => el.id === id) ?? null,
    createElement: over.createElement ?? (() => ({ id: '', rel: '', href: '', crossOrigin: '' })),
    head: {
      appendChild: (el: FakeLink) => {
        appended.push(el);
        return el;
      },
    },
  };
  return { doc: doc as unknown as Document, appended };
}

describe('googleFontsCss2Url', () => {
  it('requests only the weights the family actually has', () => {
    // Lora is 400–700: every branded weight is available.
    expect(googleFontsCss2Url('Lora')).toBe(
      'https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&display=swap',
    );
    // Oswald has 200/300 too — those are outside the branded set and dropped.
    expect(googleFontsCss2Url('Oswald')).toBe(
      'https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&display=swap',
    );
    // Anton ships a single weight; asking for 500–700 would fail the whole
    // css2 request, which is the bug this intersection exists to prevent.
    expect(googleFontsCss2Url('Anton')).toBe(
      'https://fonts.googleapis.com/css2?family=Anton:wght@400&display=swap',
    );
  });

  it('encodes multi-word families for the query string', () => {
    expect(googleFontsCss2Url('Playfair Display')).toBe(
      'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700&display=swap',
    );
    expect(googleFontsCss2Url('JetBrains Mono')).toContain('family=JetBrains+Mono:wght@');
  });

  it('returns null for a family outside the catalog', () => {
    for (const family of ['Comic Sans', 'Inter"); @import url(evil', '']) {
      expect(googleFontsCss2Url(family)).toBeNull();
    }
  });
});

describe('ensureFontLoaded', () => {
  it('injects one stylesheet link for a catalog family', () => {
    const { doc, appended } = fakeDoc();
    ensureFontLoaded('Lora', doc);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.rel).toBe('stylesheet');
    expect(appended[0]?.href).toBe(googleFontsCss2Url('Lora'));
  });

  it('is idempotent per family — repeat calls do not duplicate the link', () => {
    const { doc, appended } = fakeDoc();
    ensureFontLoaded('Lora', doc);
    ensureFontLoaded('Lora', doc);
    ensureFontLoaded('Lora', doc);
    expect(appended).toHaveLength(1);

    // A different family still gets its own link.
    ensureFontLoaded('Oswald', doc);
    expect(appended).toHaveLength(2);
    expect(new Set(appended.map((el) => el.id)).size).toBe(2);
  });

  it('injects nothing for an unknown family', () => {
    const { doc, appended } = fakeDoc();
    ensureFontLoaded('Comic Sans', doc);
    ensureFontLoaded('Inter"); @import url(evil', doc);
    expect(appended).toHaveLength(0);
  });

  it('swallows injection failures so the fallback stack keeps rendering', () => {
    const boom = vi.fn(() => {
      throw new Error('CSP blocked the element');
    });
    const { doc, appended } = fakeDoc({ createElement: boom as unknown as () => FakeLink });
    expect(() => ensureFontLoaded('Lora', doc)).not.toThrow();
    expect(appended).toHaveLength(0);

    // A missing document (SSR / no DOM) is a no-op, not a crash.
    expect(() => ensureFontLoaded('Lora', null)).not.toThrow();
  });
});
