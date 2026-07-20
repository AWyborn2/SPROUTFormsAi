import { useRef, useState } from 'react';
import { cn } from '../utils/cn.js';
import { Icon } from './Icon.js';

export interface FileDropzoneProps {
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  /** 0–100; renders a progress bar when >= 0 and < 100. */
  progress?: number;
  /** Name of the currently-selected file, if any. */
  selectedName?: string;
  hint?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Drag-and-drop file input with full keyboard activation (the whole zone is a
 * button — Enter/Space opens the native picker) and an optional progress bar.
 */
export function FileDropzone({
  onFiles,
  accept,
  multiple,
  progress,
  selectedName,
  hint = 'PDF up to 25 MB',
  disabled,
  className,
}: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const uploading = typeof progress === 'number' && progress >= 0 && progress < 100;

  function pick() {
    if (!disabled) inputRef.current?.click();
  }

  function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    onFiles(Array.from(list));
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={pick}
        disabled={disabled}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!disabled) handleFiles(e.dataTransfer.files);
        }}
        className={cn(
          'flex w-full flex-col items-center justify-center gap-3 rounded-xl border-[1.5px] border-dashed px-6 py-12 text-center transition-colors',
          dragging
            ? 'border-border-accent bg-surface-accent-soft'
            : 'border-border-strong bg-surface-sunken hover:bg-surface-hover',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        <span
          className={cn(
            'grid h-14 w-14 place-items-center rounded-2xl',
            dragging ? 'bg-accent text-[#12321f]' : 'bg-surface-card text-text-tertiary',
          )}
        >
          <Icon name={selectedName ? 'file-check-2' : 'upload-cloud'} size={26} />
        </span>
        {selectedName ? (
          <span className="font-ui text-sm font-semibold text-text-primary">{selectedName}</span>
        ) : (
          <>
            <span className="font-ui text-[15px] font-semibold text-text-primary">
              Drag a file here, or <span className="text-text-accent">browse</span>
            </span>
            <span className="text-[13px] text-text-tertiary">{hint}</span>
          </>
        )}
      </button>

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => handleFiles(e.target.files)}
      />

      {uploading && (
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-xs text-text-tertiary">
            <span>Uploading…</span>
            <span>{Math.round(progress!)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-pill bg-surface-sunken">
            <div
              className="h-full rounded-pill bg-accent transition-[width] duration-base"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
