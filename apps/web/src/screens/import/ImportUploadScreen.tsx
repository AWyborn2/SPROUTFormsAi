import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, FileDropzone, Icon } from '@formai/ui';
import { resetImportSession, startExtraction } from '../../lib/data/import-session.js';
import { formatFileSize, validateUploadFile } from './upload-validation.js';
import { ImportStepper } from './ImportStepper.js';

/** Import step 1 — upload the source PDF. */
export function ImportUploadScreen() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fresh session each time the wizard is entered from the top.
  useEffect(() => {
    resetImportSession();
  }, []);

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
        <h3 className="mb-1.5 text-[23px]">Convert an existing PDF</h3>
        <p className="mb-6 text-[14.5px] text-text-secondary">
          Bring across a form you already use. We preserve the original layout so the digital version —
          and its PDF export — match the paper one.
        </p>

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
