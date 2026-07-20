import { describe, expect, it } from 'vitest';
import { fillLinkUrl } from './fill-link-url.js';

describe('fillLinkUrl', () => {
  it('joins origin and the API link path', () => {
    expect(fillLinkUrl('https://app.example.com', '/fill/abc123')).toBe(
      'https://app.example.com/fill/abc123',
    );
  });

  it('tolerates a trailing slash on the origin', () => {
    expect(fillLinkUrl('https://app.example.com/', '/fill/abc123')).toBe(
      'https://app.example.com/fill/abc123',
    );
  });

  it('tolerates a missing leading slash on the path', () => {
    expect(fillLinkUrl('https://app.example.com', 'fill/abc123')).toBe(
      'https://app.example.com/fill/abc123',
    );
  });
});
