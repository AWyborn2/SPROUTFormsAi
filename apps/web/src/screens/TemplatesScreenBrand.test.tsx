// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_CONTAINER } from '@formai/shared';
import type { FormBrand } from '@formai/shared';
import type { FormDetail, FormSummary } from '../lib/data/types.js';

/**
 * Assigning a form to a client's brand, from the form library rail.
 *
 * The two properties that matter here are both about NOT MISLEADING SOMEBODY
 * about whose document they are looking at. The control hides itself when the
 * org has no brands, so an org that only ever uses its own branding never sees
 * a picker with a single option; and "no brand" reads as "your own branding"
 * rather than "none", because a form with no brand is not unbranded — it
 * renders in the org's own theme.
 */

const SUMMARY: FormSummary = {
  id: 'form-1',
  name: 'Site access permit',
  dept: 'Operations',
  icon: 'file-text',
  status: 'published',
  version: 'v1',
  updated: '2 days ago',
  submissions: 3,
  currentVersionId: 'ver-1',
  sourceType: 'pdf_import',
};

let detail: FormDetail;
let brands: FormBrand[];
const setBrandMutate = vi.fn();

vi.mock('../lib/data/hooks.js', () => ({
  useForms: () => ({ data: [SUMMARY] }),
  useForm: () => ({ data: detail }),
  useFillLinks: () => ({ data: [] }),
  useCreateFillLink: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useRevokeFillLink: () => ({ mutate: vi.fn(), isPending: false }),
  useArchiveForm: () => ({ mutate: vi.fn(), isPending: false }),
  useRestoreForm: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteForm: () => ({ mutate: vi.fn(), isPending: false }),
  usePublishFormVersion: () => ({ mutate: vi.fn(), isPending: false }),
  usePublishVersion: () => ({ mutate: vi.fn(), isPending: false }),
  useSetFormVoiceInput: () => ({ mutate: vi.fn(), isPending: false }),
  useFormBrands: () => ({ data: brands }),
  useSetFormBrand: () => ({ mutate: setBrandMutate, isPending: false }),
  useForkDraftVersion: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@formai/ui', async () => {
  const actual = await vi.importActual<typeof import('@formai/ui')>('@formai/ui');
  return { ...actual, useToast: () => ({ toast: vi.fn() }) };
});

const { TemplatesScreen } = await import('./TemplatesScreen.js');

function brand(over: Partial<FormBrand> & { id: string; name: string }): FormBrand {
  return { branding: {}, createdAt: '2026-01-01T00:00:00.000Z', ...over };
}

beforeEach(() => {
  detail = {
    ...SUMMARY,
    fields: [],
    container: DEFAULT_CONTAINER,
    versions: [],
    voiceInput: null,
    brandId: null,
  };
  brands = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the brand picker in the form rail', () => {
  it('is not rendered at all when the org has no client brands', () => {
    // An org that only uses its own branding should never meet this concept.
    render(<TemplatesScreen />);
    expect(screen.queryByLabelText('Brand for this form')).toBeNull();
  });

  it('lists the org’s brands once there are any', () => {
    brands = [brand({ id: 'b-1', name: 'BBM' }), brand({ id: 'b-2', name: 'Acme' })];
    render(<TemplatesScreen />);
    const select = screen.getByLabelText('Brand for this form') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Your own branding',
      'BBM',
      'Acme',
    ]);
  });

  it('calls the unassigned option “your own branding”, not “none”', () => {
    /*
      A form with no brand is not unbranded — it renders in the org's own
      theme. "None" would read as "this form has no styling", which is a
      different and untrue statement.
    */
    brands = [brand({ id: 'b-1', name: 'BBM' })];
    render(<TemplatesScreen />);
    expect(screen.getByText('Your own branding')).toBeTruthy();
  });

  it('assigns the chosen brand to the selected form', () => {
    brands = [brand({ id: 'b-1', name: 'BBM' })];
    render(<TemplatesScreen />);
    fireEvent.change(screen.getByLabelText('Brand for this form'), { target: { value: 'b-1' } });
    expect(setBrandMutate).toHaveBeenCalledWith(
      { formId: 'form-1', brandId: 'b-1' },
      expect.anything(),
    );
  });

  it('sends NULL rather than an empty string when clearing the brand', () => {
    // The API distinguishes them: `''` is not a uuid and would 400, leaving
    // the form stuck on a client's brand with no visible reason.
    brands = [brand({ id: 'b-1', name: 'BBM' })];
    detail = { ...detail, brandId: 'b-1' };
    render(<TemplatesScreen />);
    fireEvent.change(screen.getByLabelText('Brand for this form'), { target: { value: '' } });
    expect(setBrandMutate).toHaveBeenCalledWith(
      { formId: 'form-1', brandId: null },
      expect.anything(),
    );
  });

  it('shows the form’s current brand as the selected option', () => {
    brands = [brand({ id: 'b-1', name: 'BBM' }), brand({ id: 'b-2', name: 'Acme' })];
    detail = { ...detail, brandId: 'b-2' };
    render(<TemplatesScreen />);
    expect((screen.getByLabelText('Brand for this form') as HTMLSelectElement).value).toBe('b-2');
  });
});
