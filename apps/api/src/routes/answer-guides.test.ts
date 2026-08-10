/**
 * POST /answer-guides/match.
 *
 * The guide is the complete answer key to a safety-critical assessment, so the
 * property this file exists to pin is that the door is the authenticated,
 * org-scoped one — and that a missing model key reports as a configuration
 * state rather than as a fault, so an operator is told what to fix.
 */
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';

const tenant = { userId: 'u1', orgId: 'org-1', role: 'admin' as const };

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

const matchAnswerGuide = vi.fn();
vi.mock('../pdf/answer-guide.js', () => ({
  matchAnswerGuide: (...args: unknown[]) => matchAnswerGuide(...args),
}));

const getAnthropic = vi.fn(() => ({ messages: { create: vi.fn() } }));
vi.mock('../anthropic.js', () => ({ getAnthropic: () => getAnthropic() }));

const { createApp } = await import('../app.js');
const { sealSession } = await import('../auth/workos.js');

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

function authHeader() {
  return { cookie: `fai_session=${sealSession(tenant)}`, 'content-type': 'application/json' };
}

const QUESTIONS = [{ fieldId: 'q1', label: 'Q1', options: ['a', 'b'] }];
const BODY = { pdfBase64: Buffer.from('%PDF-').toString('base64'), questions: QUESTIONS };

async function post(base: string, body: unknown, headers: Record<string, string> = authHeader()) {
  return fetch(`${base}/answer-guides/match`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /answer-guides/match', () => {
  it('refuses an unauthenticated caller', async () => {
    // Repository read access to an answer key was already treated as answer
    // access; an unauthenticated route would make a URL enough.
    const { server, base } = startApp();
    try {
      const res = await post(base, BODY, { 'content-type': 'application/json' });
      expect(res.status).toBe(401);
      expect(matchAnswerGuide).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('returns the matcher’s answers and notes', async () => {
    matchAnswerGuide.mockResolvedValueOnce({ answers: { q1: ['a'] }, notes: ['a note'] });
    const { server, base } = startApp();
    try {
      const res = await post(base, BODY);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ answers: { q1: ['a'] }, notes: ['a note'] });
    } finally {
      server.close();
    }
  });

  it('rejects a body carrying both an assetId and inline bytes', async () => {
    // Two sources means one of them is ignored, and which one is not visible
    // to the caller.
    const { server, base } = startApp();
    try {
      const res = await post(base, { ...BODY, assetId: 'org-1/x.pdf' });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('rejects a body carrying neither', async () => {
    const { server, base } = startApp();
    try {
      const res = await post(base, { questions: QUESTIONS });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('rejects a question with no options, rather than absorbing it', async () => {
    // A question with nothing to choose between cannot be keyed from a guide,
    // and sending one is a caller bug worth surfacing.
    const { server, base } = startApp();
    try {
      const res = await post(base, {
        pdfBase64: BODY.pdfBase64,
        questions: [{ fieldId: 'q1', label: 'Q1', options: [] }],
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it('reports a missing model key as 422, not 500', async () => {
    // Same mapping as the extraction path: a configuration state, not a fault.
    matchAnswerGuide.mockRejectedValueOnce(new Error('guide_match_unavailable: no client'));
    const { server, base } = startApp();
    try {
      const res = await post(base, BODY);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('guide_match_unavailable');
    } finally {
      server.close();
    }
  });

  it('reports any other failure as 500', async () => {
    matchAnswerGuide.mockRejectedValueOnce(new Error('boom'));
    const { server, base } = startApp();
    try {
      const res = await post(base, BODY);
      expect(res.status).toBe(500);
    } finally {
      server.close();
    }
  });
});
