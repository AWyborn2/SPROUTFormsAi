import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Dialog, Icon, useToast, type BadgeVariant } from '@formai/ui';
import { ApiError } from '../lib/data/api-client.js';
import {
  useArchiveForm,
  useCreateFillLink,
  useDeleteForm,
  useFillLinks,
  useForm,
  useForms,
  usePublishFormVersion,
  useRestoreForm,
  useRevokeFillLink,
} from '../lib/data/hooks.js';
import { FORM_ICON_STYLE } from '../lib/data/fixtures.js';
import { fillLinkUrl } from '../lib/fill-link-url.js';
import type { TemplateStatus } from '../lib/data/types.js';

/** The API's 409 bodies carry a machine code — the dialogs branch their copy on it. */
function apiErrorCode(err: unknown): string | undefined {
  if (err instanceof ApiError && err.body && typeof err.body === 'object') {
    return (err.body as { error?: string }).error;
  }
  return undefined;
}

function statusBadge(status: TemplateStatus) {
  const map: Record<TemplateStatus, { variant: BadgeVariant; label: string; dot?: boolean }> = {
    published: { variant: 'success', label: 'Published', dot: true },
    draft: { variant: 'neutral', label: 'Draft' },
    archived: { variant: 'neutral', label: 'Archived' },
  };
  const b = map[status];
  return (
    <Badge variant={b.variant} dot={b.dot}>
      {b.label}
    </Badge>
  );
}

/** Form library — the list of every template with its version history. */
export function TemplatesScreen() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: forms = [] } = useForms();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [showArchived, setShowArchived] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);
  const [publishTargetId, setPublishTargetId] = useState<string | undefined>(undefined);
  const archivedCount = forms.filter((f) => f.status === 'archived').length;
  // Archived forms leave the active list by default; the toggle brings them back.
  const visibleForms = showArchived ? forms : forms.filter((f) => f.status !== 'archived');
  // Auto-select the first VISIBLE form until the user picks one (the fallback
  // must run against the filtered array, so selection degrades when the
  // selected form gets archived away or deleted); a hardcoded id would fire
  // guaranteed-404 requests against forms that don't exist.
  const effectiveId = visibleForms.some((f) => f.id === selectedId) ? selectedId : visibleForms[0]?.id;
  const { data: selected } = useForm(effectiveId);
  const { data: fillLinks = [] } = useFillLinks(effectiveId);
  const createLink = useCreateFillLink();
  const revokeLink = useRevokeFillLink();
  const archiveForm = useArchiveForm();
  const restoreForm = useRestoreForm();
  const deleteForm = useDeleteForm();
  const publishVersion = usePublishFormVersion();
  const publishTarget = selected?.versions.find((v) => v.id === publishTargetId);

  // Newest active link (the API lists active only, newest first).
  const activeLink = fillLinks[0];

  /** Copy the shareable URL — reusing the newest active link, minting one if none. */
  async function copyFillLink() {
    if (!selected) return;
    try {
      const link = activeLink ?? (await createLink.mutateAsync({ formId: selected.id }));
      await navigator.clipboard.writeText(fillLinkUrl(window.location.origin, link.url));
      toast({
        variant: 'success',
        message: 'Fill link copied — anyone with it can open and submit this form.',
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && apiErrorCode(err) === 'form_archived') {
        // Same status as form_not_published but the wrong nudge would be worse:
        // "publish it" on an archived form silently restores it.
        toast({
          variant: 'warning',
          message: 'This form is archived — restore it to create new fill links.',
        });
      } else if (err instanceof ApiError && err.status === 409) {
        toast({
          variant: 'warning',
          message: 'Publish this form first — fill links only work on published forms.',
        });
      } else if (err instanceof ApiError && err.status === 403) {
        toast({ variant: 'warning', message: "You don't have permission to create fill links." });
      } else {
        toast({ variant: 'danger', message: 'Could not copy the fill link — try again.' });
      }
    }
  }

  function onRevoke(linkId: string) {
    if (!selected) return;
    revokeLink.mutate(
      { formId: selected.id, linkId },
      {
        onSuccess: () =>
          toast({ variant: 'success', message: 'Fill link revoked — the old URL no longer works.' }),
        onError: (err) => {
          if (err instanceof ApiError && err.status === 403) {
            toast({ variant: 'warning', message: "You don't have permission to revoke fill links." });
          } else {
            toast({ variant: 'danger', message: 'Could not revoke the link — try again.' });
          }
        },
      },
    );
  }

  function onArchive() {
    if (!selected) return;
    archiveForm.mutate(selected.id, {
      onSuccess: () =>
        toast({
          variant: 'success',
          message: 'Form archived — existing fill links keep working; find it under "Show archived".',
        }),
      onError: (err) => {
        if (err instanceof ApiError && err.status === 403) {
          toast({ variant: 'warning', message: "You don't have permission to archive forms." });
        } else {
          toast({ variant: 'danger', message: 'Could not archive the form — try again.' });
        }
      },
    });
  }

  function onRestore() {
    if (!selected) return;
    restoreForm.mutate(selected.id, {
      onSuccess: () => toast({ variant: 'success', message: 'Form restored.' }),
      onError: (err) => {
        if (err instanceof ApiError && err.status === 403) {
          toast({ variant: 'warning', message: "You don't have permission to restore forms." });
        } else {
          toast({ variant: 'danger', message: 'Could not restore the form — try again.' });
        }
      },
    });
  }

  function onConfirmDelete() {
    if (!selected) return;
    deleteForm.mutate(selected.id, {
      onSuccess: () => {
        setDeleteOpen(false);
        setSelectedId(undefined);
        toast({ variant: 'success', message: 'Draft deleted.' });
      },
      onError: (err) => {
        const code = apiErrorCode(err);
        if (err instanceof ApiError && err.status === 409 && code) {
          // Keep the dialog open and let its body explain the conflict — the
          // two 409s need different copy and different ways out.
          setDeleteError(code);
        } else if (err instanceof ApiError && err.status === 403) {
          setDeleteOpen(false);
          toast({ variant: 'warning', message: "You don't have permission to delete forms." });
        } else {
          setDeleteOpen(false);
          toast({ variant: 'danger', message: 'Could not delete the draft — try again.' });
        }
      },
    });
  }

  function onConfirmPublishVersion() {
    if (!selected || !publishTarget) return;
    publishVersion.mutate(
      { formId: selected.id, versionId: publishTarget.id },
      {
        onSuccess: () => {
          setPublishTargetId(undefined);
          toast({ variant: 'success', message: `${publishTarget.label} is now live — fill links serve it immediately.` });
        },
        onError: (err) => {
          setPublishTargetId(undefined);
          if (err instanceof ApiError && err.status === 409) {
            toast({ variant: 'warning', message: 'That version is already published.' });
          } else if (err instanceof ApiError && err.status === 403) {
            toast({ variant: 'warning', message: "You don't have permission to publish versions." });
          } else {
            toast({ variant: 'danger', message: 'Could not publish the version — try again.' });
          }
        },
      },
    );
  }

  return (
    <div className="fai-rise mx-auto max-w-[1160px] p-[30px_28px_60px]">
      <div className="mb-[18px] flex items-center justify-between gap-4">
        <p className="max-w-[520px] text-sm text-text-secondary">
          Every form in your workspace — imported or built from scratch. Select one to see its
          version history.
        </p>
        <div className="flex flex-none gap-2.5">
          <Button variant="outline" size="sm" leadingIcon="file-up" onClick={() => navigate('/app/import')}>
            Import PDF
          </Button>
          <Button size="sm" leadingIcon="plus" onClick={() => navigate('/app/forms/build')}>
            New form
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(230px,1fr)]">
        {/* Form list */}
        <div className="overflow-hidden rounded-lg border border-border bg-surface-card shadow-xs">
          <div className="flex items-center gap-[14px] border-b border-border-subtle p-[11px_20px] font-mono text-[10.5px] uppercase tracking-wider text-text-tertiary">
            <span className="flex-1">Form</span>
            {archivedCount > 0 && (
              <button
                onClick={() => setShowArchived((s) => !s)}
                aria-pressed={showArchived}
                className="flex items-center gap-1 font-mono text-[10.5px] uppercase tracking-wider text-text-tertiary hover:text-text-secondary"
              >
                <Icon name={showArchived ? 'eye-off' : 'archive'} size={12} />
                {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
              </button>
            )}
            <span>Fills</span>
          </div>
          {visibleForms.map((f) => {
            const style = FORM_ICON_STYLE[f.icon] ?? { bg: 'var(--surface-sunken)', color: 'var(--text-secondary)' };
            const isSel = f.id === effectiveId;
            return (
              <button
                key={f.id}
                onClick={() => setSelectedId(f.id)}
                aria-pressed={isSel}
                className="fai-row flex w-full items-center gap-[13px] border-b border-l-[3px] border-border-subtle p-[14px_18px_14px_15px] text-left last:border-b-0 hover:bg-surface-hover"
                style={{
                  borderLeftColor: isSel ? 'var(--border-accent)' : 'transparent',
                  background: isSel ? 'var(--surface-accent-soft)' : 'transparent',
                }}
              >
                <span className="grid h-[38px] w-[38px] flex-none place-items-center rounded-[9px]" style={{ background: style.bg }}>
                  <Icon name={f.icon} size={19} color={style.color} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 truncate font-ui text-sm font-semibold">{f.name}</span>
                    {statusBadge(f.status)}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-text-tertiary">
                    {f.dept} · {f.version} · {f.updated}
                  </span>
                </span>
                <span className="flex-none text-right">
                  <span className="block font-heading text-[15px] font-bold">{f.submissions}</span>
                  <span className="block font-mono text-[10px] uppercase tracking-wide text-text-tertiary">
                    Fills
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {/* Version history */}
        <div className="sticky top-4 rounded-lg border border-border bg-surface-card shadow-xs">
          <div className="border-b border-border-subtle p-[20px_20px_16px]">
            <div className="mb-1.5 flex items-center justify-between gap-2.5">
              <span className="font-mono text-[10.5px] uppercase tracking-wider text-text-tertiary">
                Version history
              </span>
              {selected && statusBadge(selected.status)}
            </div>
            <div className="font-heading text-[17px] font-bold">{selected?.name}</div>
            <div className="mt-px text-[12.5px] text-text-tertiary">
              {selected?.dept} · {selected?.version}
            </div>
            <div className="mt-[14px] flex flex-col gap-2">
              <Button
                size="sm"
                block
                variant="outline"
                leadingIcon="pencil"
                disabled={!selected}
                onClick={() => navigate(`/app/forms/build?form=${effectiveId}`)}
              >
                Edit in builder
              </Button>
              <Button
                size="sm"
                block
                variant="outline"
                leadingIcon="link"
                disabled={!selected || createLink.isPending}
                onClick={() => void copyFillLink()}
              >
                Copy fill link
              </Button>
              {selected?.sourceType === 'pdf_import' && (
                <Button
                  size="sm"
                  block
                  variant="outline"
                  leadingIcon="file-up"
                  disabled={!selected}
                  onClick={() => navigate(`/app/import?form=${effectiveId}`)}
                >
                  Re-extract from PDF
                </Button>
              )}
              {selected && selected.status !== 'archived' && (
                <Button
                  size="sm"
                  block
                  variant="outline"
                  leadingIcon="archive"
                  disabled={archiveForm.isPending}
                  onClick={onArchive}
                >
                  Archive
                </Button>
              )}
              {selected?.status === 'archived' && (
                <Button
                  size="sm"
                  block
                  variant="outline"
                  leadingIcon="archive-restore"
                  disabled={restoreForm.isPending}
                  onClick={onRestore}
                >
                  Restore
                </Button>
              )}
              {selected?.status === 'draft' && (
                <Button
                  size="sm"
                  block
                  variant="outline"
                  leadingIcon="trash-2"
                  className="text-danger-text"
                  onClick={() => {
                    setDeleteError(undefined);
                    setDeleteOpen(true);
                  }}
                >
                  Delete draft
                </Button>
              )}
              {activeLink && (
                <div className="flex items-center gap-2 rounded-md border border-border-subtle bg-surface-sunken p-[8px_10px]">
                  <Icon name="link" size={13} className="flex-none text-text-tertiary" />
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-secondary"
                    title={fillLinkUrl(window.location.origin, activeLink.url)}
                  >
                    {activeLink.url}
                  </span>
                  <button
                    onClick={() => onRevoke(activeLink.id)}
                    disabled={revokeLink.isPending}
                    className="flex-none text-[11.5px] font-semibold text-danger-text hover:underline disabled:opacity-60"
                  >
                    Revoke
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="p-[18px_20px_4px]">
            {(selected?.versions ?? []).map((v, i, arr) => (
              <div key={v.id} className="flex gap-[13px]">
                <div className="flex flex-none flex-col items-center pt-0.5">
                  <span
                    className="h-3 w-3 rounded-full border-2"
                    style={{
                      background: i === 0 ? 'var(--accent)' : 'var(--surface-card)',
                      borderColor: i === 0 ? 'var(--accent)' : 'var(--border-strong)',
                    }}
                  />
                  {i < arr.length - 1 && <span className="my-[3px] w-0.5 flex-1 bg-border-subtle" />}
                </div>
                <div className="flex-1 pb-[18px]">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12.5px] font-semibold">{v.label}</span>
                    {v.state === 'draft' ? (
                      <>
                        <Badge variant="neutral">Draft</Badge>
                        <button
                          onClick={() => setPublishTargetId(v.id)}
                          className="text-[11.5px] font-semibold text-text-accent hover:underline"
                        >
                          Publish
                        </button>
                      </>
                    ) : i === 0 ? (
                      <Badge variant="success" dot>
                        Current
                      </Badge>
                    ) : null}
                  </div>
                  {v.note && (
                    <div className="mt-[3px] text-[12.5px] leading-snug text-text-secondary">{v.note}</div>
                  )}
                  <div className="mt-[3px] text-[11.5px] text-text-tertiary">
                    {v.publishedBy} · {v.publishedAt} · {v.fieldCount} fields
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <Dialog
        open={deleteOpen}
        onClose={() => !deleteForm.isPending && setDeleteOpen(false)}
        title="Delete this draft?"
        description={
          deleteError === 'form_has_submissions'
            ? 'This draft already has fills, so it can’t be deleted — deleting it would destroy submission data. Archive it instead to take it out of the list while keeping its fills.'
            : deleteError === 'form_not_draft'
              ? 'This form is no longer a draft, so it can’t be deleted. Archive it instead to take it out of circulation.'
              : `"${selected?.name ?? ''}" and its version history will be permanently deleted. This can’t be undone.`
        }
        size="sm"
        footer={
          deleteError ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setDeleteOpen(false)}>
                Close
              </Button>
              <Button
                size="sm"
                leadingIcon="archive"
                disabled={archiveForm.isPending}
                onClick={() => {
                  setDeleteOpen(false);
                  onArchive();
                }}
              >
                Archive instead
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" disabled={deleteForm.isPending} onClick={() => setDeleteOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                leadingIcon="trash-2"
                disabled={deleteForm.isPending}
                onClick={onConfirmDelete}
              >
                Delete draft
              </Button>
            </>
          )
        }
      />

      <Dialog
        open={!!publishTarget}
        onClose={() => !publishVersion.isPending && setPublishTargetId(undefined)}
        title={`Publish ${publishTarget?.label ?? 'this version'}?`}
        description={
          selected?.status === 'archived'
            ? 'Publishing will restore this archived form and put it back in circulation. Live fill links will serve the new version immediately.'
            : 'Live fill links will switch to this version immediately. Fills already in progress against the current version still submit under the version they were opened with.'
        }
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={publishVersion.isPending}
              onClick={() => setPublishTargetId(undefined)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              leadingIcon="rocket"
              disabled={publishVersion.isPending}
              onClick={onConfirmPublishVersion}
            >
              {selected?.status === 'archived' ? 'Publish & restore' : 'Publish now'}
            </Button>
          </>
        }
      />
    </div>
  );
}
