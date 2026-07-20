import { useRef, useState } from 'react';
import { Icon } from '@formai/ui';
import { useUploadOrgLogo } from '../../lib/data/hooks.js';
import { LogoValidationError, prepareLogoUpload } from '../../lib/logo-image.js';

interface LogoUploadControlProps {
  /** Current `branding.logoAssetUrl`, or null when none is set. */
  value: string | null;
  /** Glyph shown on the empty state before a logo exists. */
  initial: string;
  /** Background for that glyph — the org's own primary colour. */
  swatchColor: string;
  /** Called with the new public URL, or null when the logo is removed. */
  onChange: (url: string | null) => void;
  /**
   * Optional hook for work that needs the original bytes (palette extraction).
   * Runs after a successful upload and outside its error handling: it is
   * cosmetic, so a failure there must never surface as an upload error.
   */
  onUploaded?: (file: File) => void | Promise<void>;
}

/**
 * Validate → rasterise (SVG only) → upload → hand back the public URL.
 *
 * Shared by the onboarding wizard and the branding settings screen, which is
 * what makes a logo editable after onboarding (R10) rather than only during
 * it. The control never persists anything itself: the owning screen decides
 * when the surrounding branding kit is written via `PATCH /org`.
 */
export function LogoUploadControl({
  value,
  initial,
  swatchColor,
  onChange,
  onUploaded,
}: LogoUploadControlProps) {
  const uploadLogo = useUploadOrgLogo();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const prepared = await prepareLogoUpload(file);
      const { url } = await uploadLogo.mutateAsync(prepared);
      onChange(url);
      setFileName(file.name);
    } catch (err) {
      setError(
        err instanceof LogoValidationError
          ? err.message
          : 'That logo could not be uploaded — you can continue and add one later.',
      );
      return;
    }
    await onUploaded?.(file);
  };

  const remove = () => {
    onChange(null);
    setFileName(null);
    setError(null);
  };

  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/svg+xml,image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          void onPickFile(e.target.files?.[0]);
          // Reset so re-picking the same file still fires onChange.
          e.target.value = '';
        }}
      />
      {value ? (
        <div className="flex items-center gap-[13px] rounded-md border-[1.5px] border-border bg-surface-sunken p-[14px]">
          <img
            src={value}
            alt="Your uploaded logo"
            className="h-11 w-11 flex-none rounded-[10px] border border-border bg-white object-contain p-1"
          />
          <div className="min-w-0 flex-1">
            <span className="block truncate font-ui text-[13.5px] font-semibold text-text-primary">
              {fileName ?? 'Your logo'}
            </span>
            <span className="block text-xs text-text-tertiary">Shown on every branded form</span>
          </div>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadLogo.isPending}
            className="fai-chip-btn rounded-md border border-border px-2.5 py-1.5 text-xs font-semibold text-text-secondary"
          >
            Replace
          </button>
          <button
            onClick={remove}
            className="fai-chip-btn rounded-md border border-border px-2.5 py-1.5 text-xs font-semibold text-text-secondary"
          >
            Remove
          </button>
        </div>
      ) : (
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadLogo.isPending}
          className="fai-chip-btn flex w-full items-center gap-[13px] rounded-md border-[1.5px] border-dashed border-border-strong bg-surface-sunken p-[14px] text-left"
        >
          <span
            className="grid h-11 w-11 flex-none place-items-center rounded-[10px] font-heading text-[17px] font-bold text-white"
            style={{ background: swatchColor }}
          >
            {initial}
          </span>
          <span className="flex-1">
            <span className="block font-ui text-[13.5px] font-semibold text-text-primary">
              {uploadLogo.isPending ? 'Uploading…' : 'Upload your logo'}
            </span>
            <span className="block text-xs text-text-tertiary">
              SVG, PNG, JPEG or WebP · up to 2 MB
            </span>
          </span>
          <Icon name="upload" size={17} className="text-text-tertiary" />
        </button>
      )}
      {error && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-danger">
          <Icon name="info" size={13} className="mt-px flex-none" />
          {error}
        </p>
      )}
    </div>
  );
}
