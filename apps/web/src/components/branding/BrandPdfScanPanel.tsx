import { useRef, useState } from 'react';
import { Icon } from '@formai/ui';
import type { FormBrandKit } from '@formai/shared';
import { useScanBrandFromPdf, useUploadOrgLogo } from '../../lib/data/hooks.js';
import type { BrandPdfScan } from '../../lib/data/types.js';

interface BrandPdfScanPanelProps {
  /** Applies one part of the proposal — a colour, or an uploaded logo URL. */
  onApply: (patch: FormBrandKit) => void;
  disabled?: boolean;
}

/** A client's document, decently sized. Larger and it is a scan, not a form. */
const MAX_PDF_BYTES = 25 * 1024 * 1024;

/**
 * "Start from the client's form" — read their colours and logo off their own PDF.
 *
 * THE REVIEW STEP IS THE FEATURE, not a formality. A document's most-used
 * colour may be its table borders rather than its letterhead, and its images
 * are its logo, its hazard pictograms and its site photographs alike — so
 * everything is offered as a swatch or a thumbnail to click, one at a time,
 * and nothing is applied until it is clicked. Applying the whole proposal in
 * one button would be faster and wrong: the author would then have to work out
 * which of four changes was the bad one.
 *
 * A thin result is the normal case rather than an error. Plenty of real forms
 * are black and white, or carry their letterhead as a flattened scan this
 * cannot read into. The panel says which happened, so "nothing found" reads as
 * a fact about the document instead of a failure of the product.
 */
export function BrandPdfScanPanel({ onApply, disabled }: BrandPdfScanPanelProps) {
  const scan = useScanBrandFromPdf();
  const uploadLogo = useUploadOrgLogo();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<BrandPdfScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [appliedLogo, setAppliedLogo] = useState<number | null>(null);

  async function onPickFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setResult(null);
    setAppliedLogo(null);
    if (file.size > MAX_PDF_BYTES) {
      setError('That file is too large — 25 MB is the limit.');
      return;
    }
    const buffer = await file.arrayBuffer();
    // Chunked rather than one spread: a 25 MB document is ~26 million arguments
    // to `String.fromCharCode`, which overflows the call stack.
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    setFileName(file.name);
    scan.mutate(
      { pdfBase64: btoa(binary) },
      {
        onSuccess: setResult,
        onError: () =>
          setError('We could not read that document. You can set the colours by hand instead.'),
      },
    );
  }

  /**
   * Uploads the chosen candidate through the ordinary logo door and applies the
   * URL it returns. The scan hands back base64 precisely so the ones nobody
   * picks leave nothing behind.
   */
  async function applyLogo(index: number) {
    const logo = result?.logos[index];
    if (!logo) return;
    setError(null);
    try {
      const { url } = await uploadLogo.mutateAsync({
        imageBase64: logo.imageBase64,
        mimeType: logo.mimeType,
        usage: 'brand',
      });
      onApply({ logoAssetUrl: url });
      setAppliedLogo(index);
    } catch {
      setError('That logo could not be saved — try another, or upload one yourself.');
    }
  }

  const nothingFound = result && result.colors.length === 0 && result.logos.length === 0;

  return (
    <div className="rounded-md border border-dashed border-border-strong p-3.5">
      <div className="mb-1 flex items-center gap-2">
        <Icon name="sparkles" size={14} className="text-accent" />
        <span className="text-[13px] font-semibold">Start from the client&rsquo;s form</span>
      </div>
      <p className="mb-2.5 text-[12px] text-text-tertiary">
        Upload one of their PDFs and we&rsquo;ll read its colours and logo. Nothing is applied until
        you click it.
      </p>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(e) => {
          void onPickFile(e.target.files?.[0]);
          // Reset so re-picking the same file still fires onChange.
          e.target.value = '';
        }}
      />
      <button
        type="button"
        disabled={disabled || scan.isPending}
        onClick={() => fileInputRef.current?.click()}
        className="fai-chip-btn flex w-full items-center gap-2.5 rounded-md border border-border bg-surface-card px-3 py-2 text-left disabled:opacity-60"
      >
        <Icon name="file-up" size={15} className="flex-none text-text-tertiary" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">
          {scan.isPending ? 'Reading…' : (fileName ?? 'Choose a PDF')}
        </span>
      </button>

      {error && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-danger">
          <Icon name="info" size={13} className="mt-px flex-none" />
          {error}
        </p>
      )}

      {result && (
        <div className="mt-3 flex flex-col gap-3">
          {result.colors.length > 0 && (
            <div>
              <div className="mb-1.5 text-[11.5px] font-semibold text-text-secondary">
                Colours in this document
              </div>
              {/* One click, one colour role. Which swatch is "the" primary is
                  exactly the judgement the author is here to make. */}
              <div className="flex flex-wrap gap-1.5">
                {result.colors.map((hex) => (
                  <div key={hex} className="flex items-center gap-1">
                    <span
                      className="h-6 w-6 flex-none rounded border border-border"
                      style={{ background: hex }}
                      title={hex}
                    />
                    <div className="flex flex-col">
                      {(
                        [
                          ['primaryColor', 'Primary'],
                          ['accentColor', 'Accent'],
                        ] as const
                      ).map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => onApply({ [key]: hex })}
                          className="text-left text-[10.5px] font-semibold text-accent hover:underline"
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.logos.length > 0 && (
            <div>
              <div className="mb-1.5 text-[11.5px] font-semibold text-text-secondary">
                Images that might be their logo
              </div>
              <div className="flex flex-wrap gap-2">
                {result.logos.map((logo, i) => (
                  <button
                    key={`${logo.width}x${logo.height}-${i}`}
                    type="button"
                    disabled={uploadLogo.isPending}
                    onClick={() => void applyLogo(i)}
                    aria-label={`Use this ${logo.width} by ${logo.height} image as the logo`}
                    className={`fai-chip-btn flex items-center gap-2 rounded-md border bg-white p-1.5 disabled:opacity-60 ${
                      appliedLogo === i ? 'border-border-accent' : 'border-border'
                    }`}
                  >
                    <img
                      src={`data:${logo.mimeType};base64,${logo.imageBase64}`}
                      alt=""
                      className="h-9 w-auto max-w-[90px] object-contain"
                    />
                    {appliedLogo === i && <Icon name="check" size={13} className="text-success" />}
                  </button>
                ))}
              </div>
            </div>
          )}

          {nothingFound && (
            <p className="text-[12px] text-text-tertiary">
              Nothing usable in this one — set the colours and logo yourself below.
            </p>
          )}

          {result.notes.map((note) => (
            <p key={note} className="text-[11.5px] text-text-tertiary">
              {note}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
