import { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { ExtractedField, ExtractionStatus } from '@formai/shared';

// Vite resolves the worker asset to a served URL.
import workerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

interface PageRender {
  dataUrl: string;
  width: number;
  height: number;
}

interface FieldHighlight {
  id: string;
  position: NonNullable<ExtractedField['sourcePosition']>;
  status: ExtractionStatus;
}

interface PdfViewerProps {
  pdfBase64?: string;
  assetId?: string | null;
  highlights?: FieldHighlight[];
  selectedFieldId?: string | null;
  onSelectField?: (id: string) => void;
  className?: string;
}

const CONF = {
  ok: { color: 'var(--success)', bg: 'var(--success-soft)' },
  review: { color: 'var(--warning)', bg: 'var(--warning-soft)' },
  low: { color: 'var(--danger)', bg: 'var(--danger-soft)' },
} as const;

export function PdfViewer({
  pdfBase64,
  assetId,
  highlights = [],
  selectedFieldId,
  onSelectField,
  className = '',
}: PdfViewerProps) {
  const [pages, setPages] = useState<PageRender[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadPdf = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let source: Uint8Array;
      if (pdfBase64) {
        const binary = atob(pdfBase64);
        source = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) source[i] = binary.charCodeAt(i);
      } else if (assetId && assetId.trim().length > 0) {
        const res = await fetch(`/api/pdf/asset/${assetId}`, { credentials: 'include' });
        if (!res.ok) throw new Error(`Failed to load PDF (${res.status})`);
        source = new Uint8Array(await res.arrayBuffer());
      } else {
        throw new Error('No PDF source provided');
      }

      const pdf = await pdfjs.getDocument({ data: source }).promise;
      const rendered: PageRender[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const scale = 1.5;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d')!;
        await page.render({ canvas, viewport }).promise;
        rendered.push({
          dataUrl: canvas.toDataURL('image/png'),
          width: viewport.width,
          height: viewport.height,
        });
      }
      setPages(rendered);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to render PDF');
    } finally {
      setLoading(false);
    }
  }, [pdfBase64, assetId]);

  useEffect(() => {
    loadPdf();
  }, [loadPdf]);

  if (loading) {
    return (
      <div className={`flex flex-col items-center justify-center gap-3 py-12 ${className}`}>
        <span
          className="h-8 w-8 rounded-full border-[3px] border-border border-r-accent"
          style={{ animation: 'faiSpin .7s linear infinite' }}
        />
        <span className="text-[13px] text-text-secondary">Loading PDF…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`rounded-md border border-danger/30 bg-danger-soft p-4 text-[13px] text-danger-text ${className}`}>
        {error}
      </div>
    );
  }

  if (pages.length === 0) return null;

  return (
    <div className={`flex flex-col gap-4 ${className}`}>
      {pages.map((page, pageIndex) => (
        <div
          key={pageIndex}
          id={`pdf-page-${pageIndex}`}
          className="relative mx-auto"
          style={{ width: page.width, height: page.height }}
        >
          <img
            src={page.dataUrl}
            alt={`Page ${pageIndex + 1}`}
            className="max-w-full rounded-md border border-border shadow-sm"
            style={{ width: page.width, height: page.height, display: 'block' }}
          />
          {highlights
            .filter((h) => h.position.page === pageIndex)
            .map((h) => {
              const scaleX = page.width / h.position.pageWidth;
              const scaleY = page.height / h.position.pageHeight;
              const isSelected = h.id === selectedFieldId;
              const left = h.position.x * scaleX;
              const top = page.height - (h.position.y + h.position.height) * scaleY;
              const width = h.position.width * scaleX;
              const height = h.position.height * scaleY;
              return (
                <div
                  key={h.id}
                  className="absolute cursor-pointer rounded-[3px] transition-all"
                  style={{
                    left,
                    top: Math.max(0, top),
                    width: Math.max(2, width),
                    height: Math.max(2, height),
                    border: `2px solid ${CONF[h.status].color}`,
                    backgroundColor: CONF[h.status].bg,
                    opacity: isSelected ? 0.6 : 0.25,
                    boxShadow: isSelected
                      ? `0 0 0 3px ${CONF[h.status].color}`
                      : undefined,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectField?.(h.id);
                  }}
                  title={`${h.id}`}
                />
              );
            })}
        </div>
      ))}
    </div>
  );
}
