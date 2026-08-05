import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Icon, Input, useToast } from '@formai/ui';
import type { FormBrand, FormBrandKit } from '@formai/shared';
import { resolveBrandKit } from '@formai/shared';
import { BrandColorFields } from '../../components/branding/BrandColorFields.js';
import { BrandedFormPreview } from '../../components/branding/BrandedFormPreview.js';
import { FontPicker } from '../../components/branding/FontPicker.js';
import { LogoUploadControl } from '../../components/branding/LogoUploadControl.js';
import { ThemeCustomizer } from '../../components/branding/ThemeCustomizer.js';
import { ThemePresetGallery } from '../../components/branding/ThemePresetGallery.js';
import { ApiError } from '../../lib/data/api-client.js';
import {
  useCreateFormBrand,
  useDeleteFormBrand,
  useFormBrands,
  useUpdateFormBrand,
} from '../../lib/data/hooks.js';
import { ensureFontLoaded } from '../../lib/font-loader.js';
import { useOnboarding } from '../../lib/onboarding.js';
import type { PreviewRegion } from '../../lib/theme-editor.js';

/**
 * Client brands — the identities this org's forms are presented in.
 *
 * WHY THIS SCREEN EXISTS SEPARATELY FROM BRANDING SETTINGS. The branding screen
 * edits ONE kit: ours. That is the right model for an org whose forms are its
 * own. A subcontractor fills out their clients' documents, so most of their
 * forms carry somebody else's brand and their own is one among several — the
 * question "what does OUR form look like" and "what does a BBM form look like"
 * are different questions with different answers, and a single editor cannot
 * hold both.
 *
 * Everything a brand sets is a PATCH over the org's own kit, so a brand that
 * only sets a primary colour still picks up the org's font. That is why every
 * control here shows the resolved value rather than an empty box: the author is
 * always looking at what the form will actually render.
 *
 * WHAT THIS DOES NOT CHANGE. The evidence PDF is untouched — `round-trip.ts`
 * draws onto the client's original document, so its letterhead and layout were
 * never ours to theme. This is the on-screen fill surface only.
 */
export function ClientBrandsScreen() {
  const { toast } = useToast();
  const { branding: orgKit } = useOnboarding();
  const { data: brands, isLoading } = useFormBrands();
  const createBrand = useCreateFormBrand();
  const updateBrand = useUpdateFormBrand();
  const deleteBrand = useDeleteFormBrand();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<FormBrandKit>({});
  const [name, setName] = useState('');
  const [customizing, setCustomizing] = useState(false);
  const [highlight, setHighlight] = useState<PreviewRegion | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FormBrand | null>(null);

  const selected = brands?.find((b) => b.id === selectedId) ?? null;

  // Selecting a brand loads its stored patch into the working draft. Keyed on
  // the id alone: re-running on every `brands` change would discard in-progress
  // edits each time an unrelated query refetched.
  useEffect(() => {
    if (!selected) return;
    setDraft(selected.branding);
    setName(selected.name);
    setCustomizing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  /*
    The kit the form will actually render: the org's own, patched by this
    brand's draft. Every control below reads from THIS rather than from the
    sparse patch, so an unset colour shows the value it inherits instead of an
    empty swatch that looks like a mistake.
  */
  const resolved = useMemo(() => resolveBrandKit(orgKit, draft), [orgKit, draft]);

  useEffect(() => {
    ensureFontLoaded(resolved.formFont);
  }, [resolved.formFont]);

  const dirty =
    !!selected && (name !== selected.name || JSON.stringify(draft) !== JSON.stringify(selected.branding));

  function patch(next: FormBrandKit) {
    setDraft((prev) => ({ ...prev, ...next }));
  }

  function onCreate() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setAddError(null);
    createBrand.mutate(
      { name: trimmed },
      {
        onSuccess: (brand) => {
          setAddOpen(false);
          setNewName('');
          setSelectedId(brand.id);
        },
        onError: (err) => {
          // 409 is the unique index, and it is the only failure the author can
          // act on — everything else is a retry.
          setAddError(
            err instanceof ApiError && err.status === 409
              ? 'A brand with that name already exists.'
              : 'Could not add the brand — try again.',
          );
        },
      },
    );
  }

  function onSave() {
    if (!selected) return;
    updateBrand.mutate(
      { id: selected.id, name: name.trim() || selected.name, branding: draft },
      {
        onSuccess: () =>
          toast({
            variant: 'success',
            message: `${name.trim() || selected.name} updated — every form using it changed too.`,
          }),
        onError: (err) =>
          toast({
            variant: 'danger',
            message:
              err instanceof ApiError && err.status === 409
                ? 'A brand with that name already exists.'
                : 'Could not save the brand — try again.',
          }),
      },
    );
  }

  function onDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    deleteBrand.mutate(target.id, {
      onSuccess: () => {
        setDeleteTarget(null);
        if (selectedId === target.id) setSelectedId(null);
        toast({
          variant: 'success',
          message: `${target.name} removed. Its forms use your own branding now.`,
        });
      },
      onError: () => {
        setDeleteTarget(null);
        toast({ variant: 'danger', message: 'Could not remove the brand — try again.' });
      },
    });
  }

  return (
    <div className="fai-rise mx-auto max-w-[1100px] p-[30px_28px_60px]">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-[21px] font-bold">Client brands</h1>
          <p className="mt-1 max-w-[620px] text-[13.5px] text-text-secondary">
            Make an online form look like the client&rsquo;s own. Assign a brand to a form in the
            form library — anything a brand doesn&rsquo;t set falls back to your own branding.
          </p>
        </div>
        <Button leadingIcon="plus" onClick={() => setAddOpen(true)}>
          Add brand
        </Button>
      </div>

      {isLoading ? (
        <div className="text-[13.5px] text-text-tertiary">Loading brands…</div>
      ) : (brands?.length ?? 0) === 0 ? (
        <div className="rounded-xl border border-dashed border-border-strong bg-surface-sunken p-[34px] text-center">
          <Icon name="palette" size={26} className="mx-auto mb-3 text-text-tertiary" />
          <div className="mb-1 font-heading text-[15px] font-bold">No client brands yet</div>
          <p className="mx-auto max-w-[420px] text-[13px] text-text-secondary">
            Add one for each client whose forms you fill out. Every form you leave unassigned keeps
            using your own branding.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[220px_minmax(0,1fr)_minmax(0,380px)]">
          {/* Brand list */}
          <div className="flex flex-col gap-1.5">
            {brands!.map((brand) => {
              const active = brand.id === selectedId;
              return (
                <button
                  key={brand.id}
                  type="button"
                  onClick={() => setSelectedId(brand.id)}
                  aria-current={active ? 'true' : undefined}
                  className={`fai-chip-btn flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-left ${
                    active
                      ? 'border-border-accent bg-surface-card shadow-sm'
                      : 'border-border-subtle bg-surface-sunken'
                  }`}
                >
                  <span
                    className="h-4 w-4 flex-none rounded-full border border-border"
                    style={{
                      background: resolveBrandKit(orgKit, brand.branding).primaryColor,
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
                    {brand.name}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Editor */}
          {selected ? (
            <div className="rounded-xl border border-border bg-surface-card p-[22px]">
              <Input
                label="Brand name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                leadingIcon="tag"
              />

              <div className="mb-[9px] mt-[22px] text-[13px] font-semibold">Style preset</div>
              <div className="mb-[22px]">
                <ThemePresetGallery
                  theme={draft.theme ?? {}}
                  onChange={(theme) => patch({ theme })}
                />
              </div>

              <div className="mb-[9px] text-[13px] font-semibold">Client logo</div>
              <div className="mb-[22px]">
                {/* `usage: 'brand'` only changes the audit wording — the bytes,
                    the key namespace and the public URL are the org's own
                    either way, because a client's logo IS an image this org
                    uploaded. */}
                <LogoUploadControl
                  value={draft.logoAssetUrl ?? null}
                  initial={(name.trim()[0] ?? '?').toUpperCase()}
                  swatchColor={resolved.primaryColor}
                  uploadUsage="brand"
                  onChange={(url) => patch({ logoAssetUrl: url })}
                />
                <p className="mt-1.5 text-[11.5px] text-text-tertiary">
                  Shown instead of yours on this client&rsquo;s forms.
                </p>
              </div>

              <div className="mb-[11px] text-[13px] font-semibold">Client colours</div>
              <div className="mb-[22px]">
                {/* Fed the RESOLVED kit, not the sparse patch: an unset colour
                    shows what it inherits from your own branding rather than a
                    blank swatch that reads as a mistake. */}
                <BrandColorFields branding={resolved} onChange={(next) => patch(next)} />
              </div>

              <div className="mb-[9px] text-[13px] font-semibold">Form font</div>
              <FontPicker value={resolved.formFont} onPick={(family) => patch({ formFont: family })} />

              <button
                type="button"
                onClick={() => setCustomizing((v) => !v)}
                aria-expanded={customizing}
                className="mt-[22px] flex w-full items-center justify-between rounded-md border border-dashed border-border-strong px-3.5 py-2.5 text-left"
              >
                <span className="text-[13px] font-semibold">
                  Customize theme
                  <span className="ml-1.5 font-normal text-text-tertiary">
                    typography, buttons, density, layout…
                  </span>
                </span>
                <Icon
                  name={customizing ? 'chevron-down' : 'chevron-right'}
                  size={14}
                  className="text-text-tertiary"
                />
              </button>
              {customizing && (
                <div className="mt-3">
                  <ThemeCustomizer
                    theme={draft.theme ?? {}}
                    onChange={(next) => patch({ theme: { ...draft.theme, ...next } })}
                    onHighlight={setHighlight}
                  />
                </div>
              )}

              <div className="mt-[22px] flex items-center gap-2.5">
                <Button leadingIcon="check" loading={updateBrand.isPending} disabled={!dirty} onClick={onSave}>
                  Save brand
                </Button>
                <Button variant="ghost" leadingIcon="trash-2" onClick={() => setDeleteTarget(selected)}>
                  Remove
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-border-strong bg-surface-sunken p-[34px] text-center text-[13px] text-text-secondary">
              Pick a brand to edit it.
            </div>
          )}

          {/* Live preview — the same component the branding screen and the
              onboarding wizard use, resolved exactly the way the server
              resolves it for a real fill link. */}
          {selected && (
            <div className="sticky top-4">
              <BrandedFormPreview
                orgName={name || selected.name}
                branding={resolved}
                highlight={highlight}
              />
            </div>
          )}
        </div>
      )}

      <Dialog
        open={addOpen}
        onClose={() => {
          setAddOpen(false);
          setAddError(null);
        }}
        title="Add a client brand"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button loading={createBrand.isPending} disabled={!newName.trim()} onClick={onCreate}>
              Add brand
            </Button>
          </>
        }
      >
        <p className="mb-3.5 text-[13px] text-text-secondary">
          Name it after the client. You can set their logo and colours next.
        </p>
        <Input
          label="Client name"
          value={newName}
          autoFocus
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCreate();
          }}
        />
        {addError && (
          <p role="alert" className="mt-2 text-[12.5px] text-danger">
            {addError}
          </p>
        )}
      </Dialog>

      <Dialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={`Remove ${deleteTarget?.name ?? 'brand'}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={deleteBrand.isPending} onClick={onDelete}>
              Remove brand
            </Button>
          </>
        }
      >
        {/* Stated plainly because it is the question the author is actually
            asking. Forms are NOT deleted with the brand — they fall back to
            the org's own branding, which is visible and recoverable. */}
        <p className="text-[13px] text-text-secondary">
          Forms using this brand aren&rsquo;t deleted — they go back to your own branding, and you
          can assign them to another brand at any time.
        </p>
      </Dialog>
    </div>
  );
}
