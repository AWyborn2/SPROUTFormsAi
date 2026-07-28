import { useEffect, useId, useRef, useState } from 'react';
import {
  ALLOWED_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  type SubmissionFileRef,
} from '@formai/shared';
import { ApiError, uploadAttachment } from '../../lib/data/api-client.js';
import { CHC_BORDER, CHC_RED } from './chc-intake-styles.js';

/**
 * A CHC intake file input that stores the bytes.
 *
 * The prototype held the picked file in a local object URL and never sent it
 * anywhere, which is fine for a mock and useless for an intake: the whole point
 * of the profile photo and the licence image is that someone downstream can
 * open them. So the file uploads on pick, and the field only reports a value
 * once storage has accepted it — `null` while uploading, so a form submitted
 * mid-upload fails validation rather than recording a licence that is not
 * there.
 *
 * Uses the authenticated `/uploads` door: this screen lives inside the app
 * shell, behind a session.
 */
export function ChcFileField({
  label,
  hint,
  accept,
  value,
  error,
  onChange,
}: {
  label: string;
  hint: string;
  /** Narrower than the server allow-list where the form is narrower (photos are images only). */
  accept: string;
  value: SubmissionFileRef | null;
  error?: string;
  onChange: (ref: SubmissionFileRef | null) => void;
}) {
  const [progress, setProgress] = useState<number | null>(null);
  const [localError, setLocalError] = useState('');
  const [preview, setPreview] = useState('');
  const previewRef = useRef('');
  const inputRef = useRef<HTMLInputElement>(null);
  // Programmatic association: the visible caption alone names nothing for a
  // screen reader — the input needs the label's `for`, and the hint and error
  // linked so they announce with the field rather than as loose text.
  const id = useId();
  const describedBy =
    [`${id}-hint`, localError || error ? `${id}-err` : null].filter(Boolean).join(' ') ||
    undefined;

  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );

  const uploading = progress !== null;
  const shown = localError || error;

  async function onPick(file: File | undefined) {
    if (!file) return;
    setLocalError('');

    // Checked here as well as on the server: a local refusal is instant and
    // names the actual problem, where letting it through means base64-ing
    // megabytes to be told the same thing by a 400.
    if (!ALLOWED_ATTACHMENT_TYPES[file.type] || !accept.split(',').includes(file.type)) {
      setLocalError(`Choose a ${hint} file.`);
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setLocalError(
        `That file is ${formatBytes(file.size)} — the limit is ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
      );
      return;
    }

    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = file.type.startsWith('image/') ? URL.createObjectURL(file) : '';
    setPreview(previewRef.current);

    setProgress(0);
    try {
      onChange(await uploadAttachment<SubmissionFileRef>('/uploads', file, setProgress));
    } catch (err) {
      onChange(null);
      setPreview('');
      setLocalError(
        err instanceof ApiError && err.status === 413
          ? 'That file is too large — the limit is 10 MB.'
          : err instanceof ApiError && err.status === 400
            ? "That file's contents don't match its type. Try re-saving it."
            : err instanceof ApiError && err.status === 401
              ? 'Your session expired. Sign in again, then re-attach the file.'
              : 'Upload failed — check your connection and try again.',
      );
    } finally {
      setProgress(null);
    }
  }

  function clear() {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = '';
    setPreview('');
    setLocalError('');
    onChange(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <div data-chc-error={shown ? 'true' : undefined}>
      <label
        htmlFor={id}
        style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#333', marginBottom: 6 }}
      >
        {label}
        <span style={{ color: CHC_RED }}> *</span>
      </label>

      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept}
        disabled={uploading}
        aria-invalid={shown ? true : undefined}
        aria-describedby={describedBy}
        onChange={(e) => void onPick(e.target.files?.[0])}
        style={{
          width: '100%',
          padding: 8,
          border: `1px solid ${CHC_BORDER}`,
          borderRadius: 6,
          fontSize: 13,
          boxSizing: 'border-box',
          fontFamily: 'inherit',
          cursor: uploading ? 'progress' : 'pointer',
          background: '#FAFBFC',
        }}
      />
      <div id={`${id}-hint`} style={{ fontSize: 11, color: '#767676', marginTop: 3 }}>
        {hint}
      </div>

      {preview && (
        <img
          src={preview}
          alt={`Preview of ${label}`}
          style={{
            width: 80,
            height: 60,
            objectFit: 'cover',
            borderRadius: 6,
            marginTop: 6,
            border: '1px solid #E2E8F0',
            opacity: uploading ? 0.6 : 1,
          }}
        />
      )}

      {uploading && (
        <div style={{ marginTop: 6 }}>
          <div
            style={{
              height: 4,
              borderRadius: 999,
              background: '#E2E8F0',
              overflow: 'hidden',
            }}
          >
            {/* Scaled, not widened. `width` is a layout property, so animating
                it re-runs layout on every XHR progress event — and those fire
                continuously through a multi-megabyte upload on exactly the
                low-end phones this form is filled on. `transform` composites. */}
            <div
              style={{
                height: '100%',
                width: '100%',
                background: '#2E75B6',
                transform: `scaleX(${(progress ?? 0) / 100})`,
                transformOrigin: 'left',
                transition: 'transform 0.2s',
              }}
            />
          </div>
          <div style={{ fontSize: 11, color: '#767676', marginTop: 3 }}>Uploading… {progress}%</div>
        </div>
      )}

      {value && !uploading && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            color: '#2E75B6',
            marginTop: 4,
            fontWeight: 500,
          }}
        >
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            ✓ {value.fileName} · {formatBytes(value.size)}
          </span>
          {/* Padded to a ~44px hit target with negative margins cancelling the
              layout cost — this form is filled from phones in site offices, and
              a 15px text link is a miss-tap next to a licence you just chose. */}
          <button
            type="button"
            onClick={clear}
            aria-label={`Remove ${value.fileName}`}
            style={{
              margin: '-14px 0 -14px auto',
              padding: '14px 10px',
              flexShrink: 0,
              background: 'none',
              border: 'none',
              color: CHC_RED,
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Remove
          </button>
        </div>
      )}

      {shown && (
        <div id={`${id}-err`} role="alert" style={{ color: CHC_RED, fontSize: 12, marginTop: 3 }}>
          {shown}
        </div>
      )}
    </div>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
