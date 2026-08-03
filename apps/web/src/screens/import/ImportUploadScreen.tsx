import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, FileDropzone, Icon } from '@formai/ui';
import { DOCUMENT_TYPE_HINTS, DOCUMENT_TYPE_LABELS, DOCUMENT_TYPES, type DocumentType } from '@formai/shared';
import { useDiscardImportDraft, useForm, useImportDrafts } from '../../lib/data/hooks.js';
import { store } from '../../lib/data/store.js';
import type { ImportSnapshot } from '../../lib/data/import-draft-store.js';
import {
  clearSavedImport,
  latestSavedImport,
  resetImportSession,
  restoreImportSnapshot,
  setImportTarget,
  startExtraction,
} from '../../lib/data/import-session.js';
import { formatFileSize, validateUploadFile } from './upload-validation.js';
import { ImportStepper } from './ImportStepper.js';

/** "3 minutes ago" — how long an interruption lasted, in the words used about one. */
function howLongAgo(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** How much of the saved work is placement — the part that costs hours to redo. */
function describeProgress(snapshot: ImportSnapshot): string {
  const fields = snapshot.fields.length;
  const confirmed = snapshot.placements.filter((p) => p.confirmed).length;
  const placement = confirmed > 0 ? `, ${confirmed} placement${confirmed === 1 ? '' : 's'} confirmed` : '';
  return `${fields} field${fields === 1 ? '' : 's'}${placement}`;
}

/**
 * Import step 1 — upload the source PDF. With `?form=<id>` the wizard runs in
 * re-extract mode: the result becomes a new version of that existing form.
 */
export function ImportUploadScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const targetFormId = searchParams.get('form');
  const { data: targetForm } = useForm(targetFormId ?? undefined);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [documentType, setDocumentType] = useState<DocumentType>('generic');

  /**
   * Unfinished work from a previous visit, offered rather than restored.
   *
   * OFFERED, because resuming replaces whatever is in the wizard and the
   * reviewer may well have come here to start something else entirely. Silently
   * reinstating an old document under a screen headed "upload a PDF" would be
   * the wizard deciding what they meant.
   */
  const [resumable, setResumable] = useState<ImportSnapshot | null>(null);

  // Fresh session each time the wizard is entered from the top; the target
  // (if any) is set AFTER the reset so a plain "Import PDF" entry clears it.
  useEffect(() => {
    resetImportSession();
    setImportTarget(targetFormId);
  }, [targetFormId]);

  useEffect(() => {
    let live = true;
    void latestSavedImport().then((snapshot) => {
      if (live) setResumable(snapshot);
    });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Imports saved on the server, as distinct from the local autosave above.
   *
   * Both are offered here because this is the one screen a reviewer reaches
   * when they mean to work on an import — but they answer different questions:
   * the banner is "you were interrupted", this is "you parked something, or a
   * colleague did".
   */
  const { data: drafts = [] } = useImportDrafts();
  const discardDraft = useDiscardImportDraft();
  const [openingDraft, setOpeningDraft] = useState<string | null>(null);

  async function openDraft(id: string) {
    setOpeningDraft(id);
    try {
      const draft = await store.getImportDraft(id);
      if (!restoreImportSnapshot(draft.snapshot)) {
        setOpeningDraft(null);
        return;
      }
      setImportTarget(targetFormId);
      navigate('/app/import/review');
    } catch {
      setOpeningDraft(null);
    }
  }

  function resume() {
    if (!resumable) return;
    if (!restoreImportSnapshot(resumable)) return;
    // Re-extract mode is a property of THIS visit, not of the saved work: the
    // snapshot carries the target it was saved with, and the restore reinstates
    // it, so a plain "Import PDF" entry must not inherit an old retarget.
    setImportTarget(targetFormId);
    navigate('/app/import/review');
  }

  async function discardResumable() {
    if (!resumable?.assetId) return;
    await clearSavedImport(resumable.assetId);
    setResumable(null);
  }

  function handleFiles(files: File[]) {
    const candidate = files[0];
    if (!candidate) return;
    const problem = validateUploadFile(candidate);
    if (problem) {
      setFile(null);
      setError(problem);
      return;
    }
    setError(null);
    setFile(candidate);
  }

  function handleExtract() {
    if (!file) return;
    // Fire-and-forget — the review screen renders upload/extract progress.
    void startExtraction(file, documentType);
    navigate('/app/import/review');
  }

  return (
    <div className="fai-rise p-[30px_28px_60px]">
      <ImportStepper currentStep={0} />

      <div className="mx-auto max-w-[640px]">
        {resumable && (
          <div className="mb-6 rounded-lg border border-border-accent bg-surface-accent-soft p-[14px_18px]">
            <div className="flex items-start gap-2.5">
              <Icon name="rotate-ccw" size={16} className="mt-0.5 flex-none text-accent" />
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-semibold">Pick up where you left off</div>
                <div className="mt-0.5 text-[12.5px] text-text-secondary">
                  <span className="font-medium">{resumable.fileName}</span> · {describeProgress(resumable)}{' '}
                  · saved {howLongAgo(resumable.savedAt)}
                </div>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <Button size="sm" leadingIcon="rotate-ccw" onClick={resume}>
                Resume
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void discardResumable()}>
                Discard
              </Button>
            </div>
          </div>
        )}

        {drafts.length > 0 && (
          <div className="mb-6 overflow-hidden rounded-lg border border-border bg-surface-card">
            <div className="border-b border-border-subtle px-[18px] py-3">
              <div className="text-[13.5px] font-semibold">Saved imports</div>
              <div className="mt-0.5 text-[12px] text-text-tertiary">
                Mappings parked to finish later — yours or a colleague’s.
              </div>
            </div>
            {drafts.map((draft) => (
              <div
                key={draft.id}
                className="flex items-center gap-3 border-b border-border-subtle px-[18px] py-2.5 last:border-b-0"
              >
                <Icon name="file-clock" size={15} className="flex-none text-text-tertiary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{draft.name}</div>
                  <div className="text-[11px] text-text-tertiary">
                    saved {howLongAgo(draft.updatedAt)}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={openingDraft === draft.id}
                  onClick={() => void openDraft(draft.id)}
                >
                  {openingDraft === draft.id ? 'Opening…' : 'Open'}
                </Button>
                <button
                  onClick={() => discardDraft.mutate(draft.id)}
                  aria-label={`Discard ${draft.name}`}
                  className="fai-chip-btn grid h-[28px] w-[28px] flex-none place-items-center rounded-sm text-text-tertiary hover:bg-surface-hover"
                >
                  <Icon name="trash-2" size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

        {targetFormId ? (
          <>
            <h3 className="mb-1.5 text-[23px]">Re-extract from an updated PDF</h3>
            <p className="mb-4 text-[14.5px] text-text-secondary">
              Upload the updated PDF — the extracted fields become a new version of the existing form,
              keeping its fill links, submissions, and version history.
            </p>
            <div className="mb-6 flex items-center gap-2.5 rounded-md border border-border-accent bg-surface-accent-soft p-[10px_14px]">
              <Icon name="refresh-cw" size={16} className="flex-none text-accent" />
              <span className="text-[13px]">
                Updating <span className="font-semibold">{targetForm?.name ?? 'form'}</span>
                {targetForm ? ` · currently ${targetForm.version}` : ''}
              </span>
            </div>
          </>
        ) : (
          <>
            <h3 className="mb-1.5 text-[23px]">Convert an existing PDF</h3>
            <p className="mb-6 text-[14.5px] text-text-secondary">
              Bring across a form you already use. We preserve the original layout so the digital version —
              and its PDF export — match the paper one.
            </p>
          </>
        )}

        <FileDropzone
          accept="application/pdf"
          selectedName={file?.name}
          hint="PDF up to 25 MB · multi-page supported"
          onFiles={handleFiles}
        />

        {error && (
          <p role="alert" className="mt-3 text-[13px] text-danger">
            {error}
          </p>
        )}

        {file && (
          <div className="mt-4 flex items-center gap-3 rounded-md border border-border-accent bg-surface-card p-[12px_14px]">
            <span className="grid h-11 w-[38px] flex-none place-items-center rounded-[5px] bg-danger-soft">
              <Icon name="file-text" size={20} className="text-danger" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-semibold">{file.name}</div>
              <div className="text-xs text-text-tertiary">
                {formatFileSize(file.size)} · ready to extract
              </div>
            </div>
            <Icon name="check-circle-2" size={18} className="flex-none text-accent" />
          </div>
        )}

        {file && (
          <div className="mt-4">
            <label
              htmlFor="import-document-type"
              className="block text-[13.5px] font-semibold"
            >
              What kind of document is this?
            </label>
            <p className="mt-0.5 text-xs text-text-tertiary">
              Tunes how the fields are read. Leave it on General form if none fits.
            </p>
            <select
              id="import-document-type"
              value={documentType}
              onChange={(e) => setDocumentType(e.target.value as DocumentType)}
              className="mt-2 w-full rounded-md border border-border bg-surface-card p-[9px_11px] text-[13.5px]"
            >
              {DOCUMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {DOCUMENT_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-text-tertiary">{DOCUMENT_TYPE_HINTS[documentType]}</p>
          </div>
        )}

        <div className="mt-[22px] flex items-center justify-between">
          <button onClick={() => navigate('/app/forms')} className="text-[13.5px] text-text-tertiary">
            Cancel
          </button>
          <Button trailingIcon="sparkles" disabled={!file} onClick={handleExtract}>
            Extract fields
          </Button>
        </div>
      </div>
    </div>
  );
}
