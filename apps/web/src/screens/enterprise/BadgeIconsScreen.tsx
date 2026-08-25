import { useState, useRef } from 'react';
import { Button, Dialog, Icon, IconButton, Input, useToast } from '@formai/ui';
import {
  useBadgeIcons,
  useCreateBadgeIcon,
  useUpdateBadgeIcon,
  useDeleteBadgeIcon,
  useSession,
} from '../../lib/data/hooks.js';
import type { BadgeIcon } from '../../lib/data/types.js';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export function BadgeIconsScreen() {
  const { toast } = useToast();
  const { data: session } = useSession();
  const { data: icons = [], isLoading } = useBadgeIcons();
  const create = useCreateBadgeIcon();
  const update = useUpdateBadgeIcon();
  const remove = useDeleteBadgeIcon();

  const canManage = session?.role === 'owner' || session?.role === 'admin';

  const [uploadOpen, setUploadOpen] = useState(false);
  const [editIcon, setEditIcon] = useState<BadgeIcon | null>(null);
  const [deleteIcon, setDeleteIcon] = useState<BadgeIcon | null>(null);

  // Upload form state
  const [displayName, setDisplayName] = useState('');
  const [keywords, setKeywords] = useState('');
  const [fileData, setFileData] = useState<{ base64: string; fileName: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Edit form state
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editKeywords, setEditKeywords] = useState('');

  function resetUpload() {
    setUploadOpen(false);
    setDisplayName('');
    setKeywords('');
    setFileData(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.svg')) {
      toast({ variant: 'warning', message: 'Only SVG files are accepted.' });
      e.target.value = '';
      return;
    }
    if (file.size > 512 * 1024) {
      toast({ variant: 'warning', message: 'Icon must be 512 KB or smaller.' });
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1] ?? '';
      setFileData({ base64, fileName: file.name });
      if (!displayName) setDisplayName(file.name.replace(/\.svg$/i, '').replace(/[-_]/g, ' '));
    };
    reader.readAsDataURL(file);
  }

  function submitUpload() {
    if (!fileData) {
      toast({ variant: 'warning', message: 'Choose an SVG file to upload.' });
      return;
    }
    const name = displayName.trim();
    if (!name) {
      toast({ variant: 'warning', message: 'Give the icon a display name.' });
      return;
    }
    const slug = slugify(name);
    if (!slug) {
      toast({ variant: 'warning', message: 'The name must contain at least one letter or number.' });
      return;
    }
    const kw = keywords
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);

    create.mutate(
      { fileBase64: fileData.base64, slug, displayName: name, keywords: kw.length ? kw : undefined },
      {
        onSuccess: () => {
          resetUpload();
          toast({ variant: 'success', message: 'Icon uploaded.' });
        },
        onError: (err: unknown) => {
          const msg = (err as { message?: string }).message;
          toast({ variant: 'danger', message: msg ?? 'Could not upload the icon — try again.' });
        },
      },
    );
  }

  function openEdit(icon: BadgeIcon) {
    setEditIcon(icon);
    setEditDisplayName(icon.displayName);
    setEditKeywords(icon.keywords.join(', '));
  }

  function submitEdit() {
    if (!editIcon) return;
    const name = editDisplayName.trim();
    if (!name) {
      toast({ variant: 'warning', message: 'Display name cannot be empty.' });
      return;
    }
    const kw = editKeywords
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);

    update.mutate(
      { id: editIcon.id, displayName: name, keywords: kw },
      {
        onSuccess: () => {
          setEditIcon(null);
          toast({ variant: 'success', message: 'Icon updated.' });
        },
        onError: () => toast({ variant: 'danger', message: 'Could not update the icon — try again.' }),
      },
    );
  }

  function confirmDelete() {
    if (!deleteIcon) return;
    remove.mutate(deleteIcon.id, {
      onSuccess: () => {
        setDeleteIcon(null);
        toast({ variant: 'success', message: `${deleteIcon.displayName} removed.` });
      },
      onError: () => toast({ variant: 'danger', message: 'Could not delete the icon — try again.' }),
    });
  }

  return (
    <div className="fai-rise mx-auto max-w-[980px] p-[30px_28px_60px]">
      <div className="mb-[18px] flex items-center justify-between gap-4">
        <p className="max-w-[620px] text-sm text-text-secondary">
          Upload SVG icons used as badge artwork on the profile page. Each icon can be tagged with
          keywords so competencies are matched to the right badge automatically.
        </p>
        {canManage && (
          <Button size="sm" onClick={() => setUploadOpen(true)}>
            <Icon name="upload" size={14} />
            Upload icon
          </Button>
        )}
      </div>

      {isLoading && <p className="py-8 text-center text-sm text-text-tertiary">Loading…</p>}

      {!isLoading && icons.length === 0 && (
        <div className="rounded-lg border border-border bg-surface-secondary p-10 text-center">
          <Icon name="image" size={32} className="mx-auto mb-2 text-text-tertiary" />
          <p className="text-sm text-text-secondary">No badge icons uploaded yet.</p>
          {canManage && (
            <p className="mt-1 text-xs text-text-tertiary">
              Upload an SVG to get started — it will appear on the profile badge wall.
            </p>
          )}
        </div>
      )}

      {icons.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-4">
          {icons.map((icon) => (
            <div
              key={icon.id}
              className="group relative flex flex-col items-center gap-2 rounded-lg border border-border bg-surface p-4"
            >
              <img
                src={`/api${icon.iconUrl}`}
                alt={icon.displayName}
                className="h-12 w-12 object-contain"
              />
              <span className="text-center text-xs font-medium text-text-primary">
                {icon.displayName}
              </span>
              {icon.keywords.length > 0 && (
                <span className="text-center text-[10px] text-text-tertiary">
                  {icon.keywords.join(', ')}
                </span>
              )}
              {canManage && (
                <div className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <IconButton
                    size="sm"
                    variant="ghost"
                    icon="pencil"
                    aria-label="Edit"
                    onClick={() => openEdit(icon)}
                  />
                  <IconButton
                    size="sm"
                    variant="ghost"
                    icon="trash-2"
                    aria-label="Delete"
                    onClick={() => setDeleteIcon(icon)}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Upload dialog */}
      <Dialog open={uploadOpen} onClose={resetUpload} title="Upload badge icon">
        <div className="flex flex-col gap-4 p-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">SVG file</label>
            <input
              ref={fileRef}
              type="file"
              accept=".svg"
              onChange={handleFileChange}
              className="block w-full text-sm"
            />
          </div>
          <Input
            label="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Excavator"
          />
          <Input
            label="Keywords (comma-separated)"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="e.g. excavator, digger, 360"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={resetUpload}>
              Cancel
            </Button>
            <Button onClick={submitUpload} disabled={create.isPending}>
              {create.isPending ? 'Uploading…' : 'Upload'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editIcon} onClose={() => setEditIcon(null)} title="Edit badge icon">
        <div className="flex flex-col gap-4 p-4">
          {editIcon && (
            <img
              src={`/api${editIcon.iconUrl}`}
              alt={editIcon.displayName}
              className="mx-auto h-16 w-16 object-contain"
            />
          )}
          <Input
            label="Display name"
            value={editDisplayName}
            onChange={(e) => setEditDisplayName(e.target.value)}
          />
          <Input
            label="Keywords (comma-separated)"
            value={editKeywords}
            onChange={(e) => setEditKeywords(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditIcon(null)}>
              Cancel
            </Button>
            <Button onClick={submitEdit} disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deleteIcon} onClose={() => setDeleteIcon(null)} title="Delete icon?">
        <div className="flex flex-col gap-4 p-4">
          <p className="text-sm text-text-secondary">
            Remove <strong>{deleteIcon?.displayName}</strong>? This cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteIcon(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDelete} disabled={remove.isPending}>
              {remove.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
