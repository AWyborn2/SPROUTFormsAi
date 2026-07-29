/**
 * The client surface over the assessment API.
 *
 * What is worth pinning here is the SHAPE of each request, because the routes
 * refuse malformed ones and a silent shape drift would surface to a user as an
 * unexplained 400 halfway through an assessment. In particular: a theory
 * outcome must be sent with NO outcome field (the server computes it), and a
 * not-satisfactory outcome must carry both a disposition and a reason.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();

vi.mock('./api-client.js', () => ({
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
    delete: (...a: unknown[]) => del(...a),
  },
  ApiError: class extends Error {},
}));

const { assessmentsApi, joinLinksApi } = await import('./assessments.js');

const CASE = '00000000-0000-4000-8000-00000000000c';
const ATTEMPT = '00000000-0000-4000-8000-00000000000a';

afterEach(() => vi.clearAllMocks());

describe('reads', () => {
  it('lists cases without any client-side filter argument', async () => {
    get.mockResolvedValue([]);
    await assessmentsApi.listCases();

    // Scope is applied server-side; sending a filter would imply the browser
    // had been given rows it then hid.
    expect(get).toHaveBeenCalledWith('/assessment-cases');
  });

  it('fetches one case by id', async () => {
    get.mockResolvedValue({});
    await assessmentsApi.getCase(CASE);

    expect(get).toHaveBeenCalledWith(`/assessment-cases/${CASE}`);
  });

  it('lists tools', async () => {
    get.mockResolvedValue([]);
    await assessmentsApi.listTools();

    expect(get).toHaveBeenCalledWith('/assessment-tools');
  });
});

describe('creating a case', () => {
  it('sends the pathway and candidate', async () => {
    post.mockResolvedValue({ id: CASE });
    await assessmentsApi.createCase({ toolId: 't', candidateUserId: 'u', pathway: 'new' });

    expect(post).toHaveBeenCalledWith('/assessment-cases', {
      toolId: 't',
      candidateUserId: 'u',
      pathway: 'new',
    });
  });

  it('carries the RPL justification when that pathway is chosen', async () => {
    post.mockResolvedValue({ id: CASE });
    await assessmentsApi.createCase({
      toolId: 't',
      candidateUserId: 'u',
      pathway: 'rpl',
      rplJustification: 'Twelve years on D8 at another site',
    });

    expect(post).toHaveBeenCalledWith(
      '/assessment-cases',
      expect.objectContaining({ rplJustification: 'Twelve years on D8 at another site' }),
    );
  });
});

describe('attempts', () => {
  it('opens an attempt against a part key', async () => {
    post.mockResolvedValue({ id: ATTEMPT, attemptNumber: 1, reused: false });
    await assessmentsApi.openAttempt(CASE, 'p1-theory');

    expect(post).toHaveBeenCalledWith(`/assessment-cases/${CASE}/parts/p1-theory/attempts`, {});
  });

  it('saves values under a values key', async () => {
    patch.mockResolvedValue({ id: ATTEMPT, hours: null, thresholdReached: false });
    await assessmentsApi.saveAttempt(CASE, ATTEMPT, { ai_29: 'True' });

    expect(patch).toHaveBeenCalledWith(`/assessment-cases/${CASE}/attempts/${ATTEMPT}`, {
      values: { ai_29: 'True' },
    });
  });
});

describe('recording an outcome', () => {
  it('sends no outcome for theory, leaving the server to compute it', async () => {
    post.mockResolvedValue({ outcome: 'satisfactory' });
    await assessmentsApi.recordOutcome({ caseId: CASE, attemptId: ATTEMPT });

    expect(post).toHaveBeenCalledWith(`/assessment-cases/${CASE}/attempts/${ATTEMPT}/outcome`, {});
  });

  it('sends outcome and assessor name for a practical', async () => {
    post.mockResolvedValue({ outcome: 'satisfactory' });
    await assessmentsApi.recordOutcome({
      caseId: CASE,
      attemptId: ATTEMPT,
      outcome: 'satisfactory',
      assessorName: 'A. Assessor',
    });

    expect(post).toHaveBeenCalledWith(`/assessment-cases/${CASE}/attempts/${ATTEMPT}/outcome`, {
      outcome: 'satisfactory',
      assessorName: 'A. Assessor',
    });
  });

  it('carries disposition and reason on a not-satisfactory outcome', async () => {
    post.mockResolvedValue({ outcome: 'not_satisfactory' });
    await assessmentsApi.recordOutcome({
      caseId: CASE,
      attemptId: ATTEMPT,
      outcome: 'not_satisfactory',
      disposition: 'coaching_then_retry',
      reason: 'Blade control inconsistent on grade',
    });

    expect(post).toHaveBeenCalledWith(`/assessment-cases/${CASE}/attempts/${ATTEMPT}/outcome`, {
      outcome: 'not_satisfactory',
      disposition: 'coaching_then_retry',
      reason: 'Blade control inconsistent on grade',
    });
  });

  it('never puts the case id in the body — it addresses the route', async () => {
    post.mockResolvedValue({ outcome: 'satisfactory' });
    await assessmentsApi.recordOutcome({ caseId: CASE, attemptId: ATTEMPT, outcome: 'satisfactory' });

    const [, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).not.toHaveProperty('caseId');
    expect(body).not.toHaveProperty('attemptId');
  });
});

describe('changing pathway', () => {
  it('requires a reason alongside the new pathway', async () => {
    patch.mockResolvedValue({ id: CASE, pathway: 'new', parts: [] });
    await assessmentsApi.changePathway(CASE, 'new', 'Failed Part 2; moving to full programme');

    expect(patch).toHaveBeenCalledWith(`/assessment-cases/${CASE}/pathway`, {
      pathway: 'new',
      reason: 'Failed Part 2; moving to full programme',
    });
  });
});

/**
 * Join links are bearer credentials printed on paper. The client must never
 * imply it has any say over the role — the API pins that — and the public
 * describe/accept pair must address the token, not the org.
 */
describe('join links', () => {
  it('creates a link without ever sending a role', async () => {
    post.mockResolvedValue({});
    await joinLinksApi.create({ label: 'Dozer intake', expiresAt: null, maxUses: 25 });

    const [path, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/team/join-links');
    expect(body).not.toHaveProperty('role');
    expect(body).toMatchObject({ label: 'Dozer intake', maxUses: 25 });
  });

  it('describes a link by token on the public path', async () => {
    get.mockResolvedValue({ orgName: 'X', usable: true });
    await joinLinksApi.describe('tok');

    expect(get).toHaveBeenCalledWith('/join/tok');
  });

  it('accepts against the token, never an org id', async () => {
    post.mockResolvedValue({ orgId: 'o', role: 'candidate', alreadyMember: false });
    await joinLinksApi.accept('tok');

    const [path, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/join/tok/accept');
    expect(body).toEqual({});
  });

  it('revokes by id', async () => {
    del.mockResolvedValue(undefined);
    await joinLinksApi.revoke('link-1');

    expect(del).toHaveBeenCalledWith('/team/join-links/link-1');
  });
});
