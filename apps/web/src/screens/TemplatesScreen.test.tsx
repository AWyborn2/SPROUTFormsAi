// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CHC_FIELD_IDS, chcIntakeFields, DEFAULT_CONTAINER } from '@formai/shared';
import type { FormDetail, FormSummary } from '../lib/data/types.js';

/**
 * The drift banner is the only place a stale intake template is visible.
 *
 * `ChcIntakeScreen` renders its questions from code, so a published version
 * that has fallen behind still serves a form that looks complete and submits
 * without complaint — the gap only shows up later, as an answer missing from a
 * starter's record. These tests pin the two things that make the banner
 * trustworthy: it appears when a question is genuinely absent, and the version
 * it publishes ADDS without disturbing anything already on the form.
 */

const SUMMARY: FormSummary = {
  id: 'form-1',
  name: 'CHC BBM Induction Intake Request Form',
  dept: 'Operations',
  icon: 'clipboard-list',
  status: 'published',
  version: 'v3',
  owner: null,
  updated: '2 days ago',
  submissions: 12,
  currentVersionId: 'ver-3',
  sourceType: 'built_from_scratch',
};

let detail: FormDetail | undefined;
let formsList: FormSummary[] = [SUMMARY];
const publishFieldsMutate = vi.fn();

vi.mock('../lib/data/hooks.js', () => ({
  useForms: () => ({ data: formsList }),
  useForm: () => ({ data: detail }),
  useFillLinks: () => ({ data: [] }),
  useCreateFillLink: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useRevokeFillLink: () => ({ mutate: vi.fn(), isPending: false }),
  useArchiveForm: () => ({ mutate: vi.fn(), isPending: false }),
  useRestoreForm: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteForm: () => ({ mutate: vi.fn(), isPending: false }),
  usePublishFormVersion: () => ({ mutate: vi.fn(), isPending: false }),
  usePublishVersion: () => ({ mutate: publishFieldsMutate, isPending: false }),
  useSetFormVoiceInput: () => ({ mutate: vi.fn(), isPending: false }),
  // An org with no client brands — the picker hides itself entirely, which is
  // the state every assertion in this file was written against.
  useFormBrands: () => ({ data: [] }),
  useSetFormBrand: () => ({ mutate: vi.fn(), isPending: false }),
  useForkDraftVersion: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

vi.mock('@formai/ui', async () => {
  const actual = await vi.importActual<typeof import('@formai/ui')>('@formai/ui');
  return { ...actual, useToast: () => ({ toast: vi.fn() }) };
});

const { TemplatesScreen } = await import('./TemplatesScreen.js');

function formDetail(fields = chcIntakeFields()): FormDetail {
  return {
    ...SUMMARY,
    fields,
    container: DEFAULT_CONTAINER,
    versions: [],
    voiceInput: null,
    brandId: null,
  };
}

/** The published version as it stood before Ethnicity was added to the form. */
function staleFields() {
  return chcIntakeFields().filter((f) => f.id !== CHC_FIELD_IDS.ethnicity);
}

afterEach(() => {
  vi.clearAllMocks();
  detail = undefined;
  formsList = [SUMMARY];
});

describe('TemplatesScreen — intake drift banner', () => {
  it('names the question the published version is missing', () => {
    detail = formDetail(staleFields());
    render(<TemplatesScreen />);

    expect(screen.getByText('A question is missing')).toBeDefined();
    expect(screen.getByText('Ethnicity')).toBeDefined();
  });

  it('stays out of the way when the version is in step', () => {
    detail = formDetail();
    render(<TemplatesScreen />);

    expect(screen.queryByText('A question is missing')).toBeNull();
    expect(screen.queryByText('Add and publish')).toBeNull();
  });

  it('says nothing about a form that is not the intake', () => {
    detail = formDetail([
      { id: 'q1', type: 'text', label: 'Anything', required: false, source: 'built' },
    ]);
    render(<TemplatesScreen />);

    expect(screen.queryByText('A question is missing')).toBeNull();
  });

  it.each(['draft', 'archived'] as const)('stays quiet on a %s form', (status) => {
    // Neither is collecting anything, and publishing a version to an archived
    // form would put it back in circulation as a side effect of "add a field".
    detail = { ...formDetail(staleFields()), status };
    render(<TemplatesScreen />);

    expect(screen.queryByText('A question is missing')).toBeNull();
  });

  it('publishes a version that ADDS the question and disturbs nothing else', () => {
    const before = staleFields();
    detail = formDetail(before);
    render(<TemplatesScreen />);

    fireEvent.click(screen.getByText('Add and publish'));
    fireEvent.click(screen.getByText('Add & publish'));

    expect(publishFieldsMutate).toHaveBeenCalledTimes(1);
    const [{ formId, fields }] = publishFieldsMutate.mock.calls[0] as [
      { formId: string; fields: typeof before },
    ];
    expect(formId).toBe('form-1');
    // Exactly one field more, and every original survives untouched and in order.
    expect(fields).toHaveLength(before.length + 1);
    expect(fields.filter((f) => f.id !== CHC_FIELD_IDS.ethnicity)).toEqual(before);
    // Back in Personal Details under Gender, not appended after the uploads.
    const ids = fields.map((f) => f.id);
    expect(ids.indexOf(CHC_FIELD_IDS.ethnicity)).toBe(ids.indexOf(CHC_FIELD_IDS.gender) + 1);
  });

  it('asks before publishing — the banner alone changes nothing', () => {
    detail = formDetail(staleFields());
    render(<TemplatesScreen />);

    fireEvent.click(screen.getByText('Add and publish'));
    expect(publishFieldsMutate).not.toHaveBeenCalled();
  });
});

describe('TemplatesScreen — status tabs', () => {
  const archived: FormSummary = {
    ...SUMMARY,
    id: 'form-2',
    name: 'Retired checklist',
    status: 'archived',
    currentVersionId: 'ver-9',
  };
  const draft: FormSummary = {
    ...SUMMARY,
    id: 'form-3',
    name: 'Unfinished permit',
    status: 'draft',
    currentVersionId: null,
    version: '—',
  };

  it('keeps archived documents out of "All" — their own tab is the way in', () => {
    formsList = [SUMMARY, archived, draft];
    render(<TemplatesScreen />);

    expect(screen.queryByText('Retired checklist')).toBeNull();
    expect(screen.getByText('Unfinished permit')).toBeDefined();

    fireEvent.click(screen.getByText('Archived'));
    expect(screen.getByText('Retired checklist')).toBeDefined();
    expect(screen.queryByText('Unfinished permit')).toBeNull();
  });

  it('narrows to drafts on the Drafts tab', () => {
    formsList = [SUMMARY, archived, draft];
    render(<TemplatesScreen />);

    fireEvent.click(screen.getByText('Drafts'));
    expect(screen.getByText('Unfinished permit')).toBeDefined();
    expect(screen.queryByText('CHC BBM Induction Intake Request Form')).toBeNull();
  });

  it('counts from the whole library so a filtered view cannot misreport a tab as empty', () => {
    formsList = [SUMMARY, archived, draft];
    render(<TemplatesScreen />);

    // A search that matches nothing leaves the tab counts standing.
    fireEvent.change(screen.getByLabelText('Search documents'), { target: { value: 'zzz' } });
    expect(screen.getByText('No documents match these filters.')).toBeDefined();
    const archivedTab = screen.getByText('Archived').closest('button')!;
    expect(archivedTab.textContent).toContain('1');
  });

  it('says an empty tab is empty rather than pretending the workspace is', () => {
    formsList = [SUMMARY];
    render(<TemplatesScreen />);

    fireEvent.click(screen.getByText('Archived'));
    expect(screen.getByText('No archived documents.')).toBeDefined();
    expect(screen.queryByText(/No documents yet/)).toBeNull();
  });
});
