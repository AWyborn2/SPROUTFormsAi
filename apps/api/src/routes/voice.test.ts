import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@formai/db';
import type { FormField } from '@formai/shared';

const tenant = { userId: 'u1', orgId: 'org-1', role: 'admin' as const };
let sealSession: (t: typeof tenant) => string;

let mockDbValue: Db | null = null;
vi.mock('../db.js', () => ({
  get db() {
    return mockDbValue;
  },
  getDbStatus: () => 'unconfigured',
}));

/**
 * The mapper is stubbed — its own behaviour is covered in voice/map.test.ts —
 * but `SmartFillError` stays REAL, because the 422 path is exactly the route
 * recognising that error type.
 */
const mockMapTranscript = vi.fn();
vi.mock('../voice/map.js', async (importActual) => {
  const actual = await importActual<typeof import('../voice/map.js')>();
  return {
    ...actual,
    mapTranscriptToFields: (...args: unknown[]) => mockMapTranscript(...args),
  };
});

const { createApp } = await import('../app.js');
const { SmartFillError } = await import('../voice/map.js');
({ sealSession } = await import('../auth/workos.js'));

function startApp() {
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

function authHeader() {
  return { cookie: `fai_session=${sealSession(tenant)}` };
}

const FIELDS: FormField[] = [
  { id: 'site', type: 'text', label: 'Site name', required: true, source: 'built' },
  {
    id: 'shift',
    type: 'dropdown',
    label: 'Shift',
    required: false,
    source: 'built',
    options: ['Day', 'Night'],
  },
];

const TEMPLATE = { id: 't1', orgId: 'org-1', name: 'Site entry', currentVersionId: 'v1' };
const PUBLISHED_V1 = { id: 'v1', templateId: 't1', state: 'published', fields: FIELDS };
const ACTIVE_LINK = {
  id: 'fl1',
  token: 'tok_live',
  orgId: 'org-1',
  templateId: 't1',
  expiresAt: null,
  active: true,
};

const MAPPED = {
  mappings: [{ fieldId: 'site', value: 'Warehouse B', confidence: 0.9 }],
  unmapped: ['about'],
};

function fakeDb(opts: {
  planTier?: string;
  formTemplatesFindFirst?: unknown;
  formTemplateVersionsFindFirst?: unknown;
  fillLinksFindFirst?: unknown;
}) {
  return {
    query: {
      organizations: {
        findFirst: vi.fn().mockResolvedValue({ id: 'org-1', planTier: opts.planTier ?? 'business' }),
      },
      formTemplates: { findFirst: vi.fn().mockResolvedValue(opts.formTemplatesFindFirst) },
      formTemplateVersions: {
        findFirst: vi.fn().mockResolvedValue(opts.formTemplateVersionsFindFirst),
      },
      fillLinks: { findFirst: vi.fn().mockResolvedValue(opts.fillLinksFindFirst) },
    },
  } as unknown as Db;
}

/** The fields the mapper was actually handed — the assertion that matters. */
function mappedFields(): FormField[] {
  const call = mockMapTranscript.mock.calls[0]![0] as { fields: FormField[] };
  return call.fields;
}

afterEach(() => {
  vi.clearAllMocks();
  mockDbValue = null;
});

describe('POST /voice/smart-fill (authed)', () => {
  function post(base: string, body: unknown, headers = authHeader()) {
    return fetch(`${base}/voice/smart-fill`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('401s with no session cookie', async () => {
    mockDbValue = fakeDb({});
    const { server, base } = startApp();
    try {
      const res = await fetch(`${base}/voice/smart-fill`, { method: 'POST' });
      expect(res.status).toBe(401);
      expect(mockMapTranscript).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('403s with feature_not_available when the org plan lacks smartFill', async () => {
    mockDbValue = fakeDb({ planTier: 'team' });
    const { server, base } = startApp();
    try {
      const res = await post(base, { templateVersionId: 'v1', transcript: 'Warehouse B' });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; feature: string };
      expect(body.error).toBe('feature_not_available');
      expect(body.feature).toBe('smartFill');
      expect(mockMapTranscript).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('400s on a missing versionId, an empty transcript, or one over the cap', async () => {
    mockDbValue = fakeDb({ formTemplatesFindFirst: TEMPLATE, formTemplateVersionsFindFirst: PUBLISHED_V1 });
    const { server, base } = startApp();
    try {
      expect((await post(base, { transcript: 'Warehouse B' })).status).toBe(400);
      expect((await post(base, { templateVersionId: 'v1', transcript: '   ' })).status).toBe(400);
      expect(
        (await post(base, { templateVersionId: 'v1', transcript: 'a'.repeat(4001) })).status,
      ).toBe(400);
      expect(mockMapTranscript).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('404s for a version whose template belongs to another org', async () => {
    mockDbValue = fakeDb({
      formTemplateVersionsFindFirst: { ...PUBLISHED_V1, templateId: 't-other' },
      formTemplatesFindFirst: undefined,
    });
    const { server, base } = startApp();
    try {
      const res = await post(base, { templateVersionId: 'v1', transcript: 'Warehouse B' });
      expect(res.status).toBe(404);
      expect(mockMapTranscript).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('maps against the version’s stored fields, never any sent in the body', async () => {
    mockMapTranscript.mockResolvedValue(MAPPED);
    mockDbValue = fakeDb({
      formTemplatesFindFirst: TEMPLATE,
      formTemplateVersionsFindFirst: PUBLISHED_V1,
    });
    const { server, base } = startApp();
    try {
      const res = await post(base, {
        templateVersionId: 'v1',
        transcript: 'Warehouse B, day shift',
        // A caller trying to choose what the model answers against.
        fields: [{ id: 'ssn', type: 'text', label: 'Tax file number', required: true, source: 'built' }],
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(MAPPED);
      expect(mappedFields()).toEqual(FIELDS);
      expect(mockMapTranscript.mock.calls[0]![0]).toMatchObject({
        transcript: 'Warehouse B, day shift',
      });
    } finally {
      server.close();
    }
  });

  it('serves an unpublished draft — this door is the builder’s own preview', async () => {
    mockMapTranscript.mockResolvedValue({ mappings: [] });
    mockDbValue = fakeDb({
      formTemplatesFindFirst: TEMPLATE,
      formTemplateVersionsFindFirst: { ...PUBLISHED_V1, state: 'draft' },
    });
    const { server, base } = startApp();
    try {
      expect((await post(base, { templateVersionId: 'v1', transcript: 'Site B' })).status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('422s when no Anthropic key is configured', async () => {
    mockMapTranscript.mockRejectedValue(
      new SmartFillError('smart_fill_unavailable', 'no Anthropic client configured'),
    );
    mockDbValue = fakeDb({
      formTemplatesFindFirst: TEMPLATE,
      formTemplateVersionsFindFirst: PUBLISHED_V1,
    });
    const { server, base } = startApp();
    try {
      const res = await post(base, { templateVersionId: 'v1', transcript: 'Warehouse B' });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: 'smart_fill_unavailable' });
    } finally {
      server.close();
    }
  });

  it('500s when the model reply could not be parsed', async () => {
    mockMapTranscript.mockRejectedValue(new SmartFillError('smart_fill_failed', 'no tool block'));
    mockDbValue = fakeDb({
      formTemplatesFindFirst: TEMPLATE,
      formTemplateVersionsFindFirst: PUBLISHED_V1,
    });
    const { server, base } = startApp();
    try {
      const res = await post(base, { templateVersionId: 'v1', transcript: 'Warehouse B' });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'smart_fill_failed' });
    } finally {
      server.close();
    }
  });

  it('503s when the database is unavailable', async () => {
    mockDbValue = null;
    const { server, base } = startApp();
    try {
      expect((await post(base, { templateVersionId: 'v1', transcript: 'Site B' })).status).toBe(503);
    } finally {
      server.close();
    }
  });
});

/**
 * The public door has NO session: the link token is the only credential, so the
 * org — and therefore the plan entitlement — is resolved from the link itself.
 */
describe('POST /fill/:token/smart-fill (public)', () => {
  function post(base: string, token: string, body: unknown) {
    return fetch(`${base}/fill/${token}/smart-fill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('404s opaquely for an unknown, revoked or expired token', async () => {
    const { server, base } = startApp();
    try {
      mockDbValue = fakeDb({ fillLinksFindFirst: undefined });
      expect((await post(base, 'tok_unknown', { transcript: 'Site B' })).status).toBe(404);

      mockDbValue = fakeDb({ fillLinksFindFirst: { ...ACTIVE_LINK, active: false } });
      const revoked = await post(base, ACTIVE_LINK.token, { transcript: 'Site B' });
      expect(revoked.status).toBe(404);
      // Byte-identical to the unknown-token answer — a token must not be
      // probeable for "exists but revoked".
      expect(await revoked.json()).toEqual({ error: 'not_found' });

      mockDbValue = fakeDb({
        fillLinksFindFirst: { ...ACTIVE_LINK, expiresAt: new Date('2020-01-01T00:00:00Z') },
      });
      expect((await post(base, ACTIVE_LINK.token, { transcript: 'Site B' })).status).toBe(404);
      expect(mockMapTranscript).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('403s when the link’s org is on a plan without smartFill', async () => {
    mockDbValue = fakeDb({
      planTier: 'individual',
      fillLinksFindFirst: ACTIVE_LINK,
      formTemplatesFindFirst: TEMPLATE,
      formTemplateVersionsFindFirst: PUBLISHED_V1,
    });
    const { server, base } = startApp();
    try {
      const res = await post(base, ACTIVE_LINK.token, { transcript: 'Warehouse B' });
      expect(res.status).toBe(403);
      // No planTier and no upgrade copy — an anonymous respondent is not the
      // plan holder, and GET /fill/:token keeps plan out of its payload too.
      expect(await res.json()).toEqual({ error: 'feature_not_available', feature: 'smartFill' });
      expect(mockMapTranscript).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('400s on an empty transcript or one over the cap', async () => {
    mockDbValue = fakeDb({
      fillLinksFindFirst: ACTIVE_LINK,
      formTemplatesFindFirst: TEMPLATE,
      formTemplateVersionsFindFirst: PUBLISHED_V1,
    });
    const { server, base } = startApp();
    try {
      expect((await post(base, ACTIVE_LINK.token, {})).status).toBe(400);
      expect((await post(base, ACTIVE_LINK.token, { transcript: '' })).status).toBe(400);
      expect(
        (await post(base, ACTIVE_LINK.token, { transcript: 'a'.repeat(4001) })).status,
      ).toBe(400);
      expect(mockMapTranscript).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('404s when the form’s current version is no longer published', async () => {
    mockDbValue = fakeDb({
      fillLinksFindFirst: ACTIVE_LINK,
      formTemplatesFindFirst: TEMPLATE,
      formTemplateVersionsFindFirst: { ...PUBLISHED_V1, state: 'draft' },
    });
    const { server, base } = startApp();
    try {
      expect((await post(base, ACTIVE_LINK.token, { transcript: 'Site B' })).status).toBe(404);
      expect(mockMapTranscript).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('maps against the served version’s fields on a gated plan', async () => {
    mockMapTranscript.mockResolvedValue(MAPPED);
    mockDbValue = fakeDb({
      planTier: 'enterprise',
      fillLinksFindFirst: ACTIVE_LINK,
      formTemplatesFindFirst: TEMPLATE,
      formTemplateVersionsFindFirst: PUBLISHED_V1,
    });
    const { server, base } = startApp();
    try {
      const res = await post(base, ACTIVE_LINK.token, {
        transcript: 'Warehouse B, day shift',
        fields: [{ id: 'ssn', type: 'text', label: 'Tax file number', required: true, source: 'built' }],
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(MAPPED);
      expect(mappedFields()).toEqual(FIELDS);
    } finally {
      server.close();
    }
  });

  it('503s when the database is unavailable', async () => {
    mockDbValue = null;
    const { server, base } = startApp();
    try {
      expect((await post(base, ACTIVE_LINK.token, { transcript: 'Site B' })).status).toBe(503);
    } finally {
      server.close();
    }
  });
});
