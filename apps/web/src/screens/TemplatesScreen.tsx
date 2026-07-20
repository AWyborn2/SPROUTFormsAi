import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Icon, useToast, type BadgeVariant } from '@formai/ui';
import { ApiError } from '../lib/data/api-client.js';
import { useCreateFillLink, useFillLinks, useForm, useForms, useRevokeFillLink } from '../lib/data/hooks.js';
import { FORM_ICON_STYLE } from '../lib/data/fixtures.js';
import { fillLinkUrl } from '../lib/fill-link-url.js';
import type { TemplateStatus } from '../lib/data/types.js';

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
  // Auto-select the first real form until the user picks one; a hardcoded id
  // would fire guaranteed-404 requests against forms that don't exist.
  const effectiveId = forms.some((f) => f.id === selectedId) ? selectedId : forms[0]?.id;
  const { data: selected } = useForm(effectiveId);
  const { data: fillLinks = [] } = useFillLinks(effectiveId);
  const createLink = useCreateFillLink();
  const revokeLink = useRevokeFillLink();

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
      if (err instanceof ApiError && err.status === 409) {
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
            <span>Fills</span>
          </div>
          {forms.map((f) => {
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
                      <Badge variant="neutral">Draft</Badge>
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
    </div>
  );
}
