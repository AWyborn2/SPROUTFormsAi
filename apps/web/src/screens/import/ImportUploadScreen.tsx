import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, FileDropzone, Icon } from '@formai/ui';
import { useForm } from '../../lib/data/hooks.js';
import { resetImportSession, setImportTarget, startExtraction } from '../../lib/data/import-session.js';
import { formatFileSize, validateUploadFile } from './upload-validation.js';
import { ImportStepper } from './ImportStepper.js';

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

  // Fresh session each time the wizard is entered from the top; the target
  // (if any) is set AFTER the reset so a plain "Import PDF" entry clears it.
  useEffect(() => {
    resetImportSession();
    setImportTarget(targetFormId);
  }, [targetFormId]);

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
    void startExtraction(file);
    navigate('/app/import/review');
  }

  return (
    <div className="fai-rise p-[30px_28px_60px]">
      <ImportStepper currentStep={0} />

      <div className="mx-auto max-w-[640px]">
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
