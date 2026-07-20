import { Icon } from '@formai/ui';
import { ALT_LABEL, MOD_LABEL, SHIFT_LABEL } from './platform.js';

interface Row {
  label: string;
  keys: string[];
}
interface Group {
  label: string;
  rows: Row[];
}

const GROUPS: Group[] = [
  {
    label: 'Global',
    rows: [
      { label: 'Command palette', keys: [MOD_LABEL, 'K'] },
      { label: 'Shortcuts reference', keys: ['?'] },
      { label: 'Close / cancel', keys: ['Esc'] },
      { label: 'Confirm / submit', keys: ['Enter'] },
    ],
  },
  {
    label: 'Navigation',
    rows: [
      { label: 'Move through controls', keys: ['Tab'] },
      { label: 'Move backwards', keys: [SHIFT_LABEL, 'Tab'] },
      { label: 'Move in lists / menus', keys: ['↑', '↓'] },
      { label: 'Toggle focused checkbox', keys: ['Space'] },
    ],
  },
  {
    label: 'Form builder',
    rows: [
      { label: 'Undo / redo', keys: [MOD_LABEL, 'Z'] },
      { label: 'Duplicate field', keys: [MOD_LABEL, 'D'] },
      { label: 'Copy / paste field', keys: [MOD_LABEL, 'C'] },
      { label: 'Delete field', keys: ['Del'] },
      { label: 'Reorder field', keys: [ALT_LABEL, '↑', '↓'] },
      { label: 'Add field', keys: [MOD_LABEL, 'Enter'] },
    ],
  },
];

/** The "?" shortcuts reference overlay. */
export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--surface-overlay)] p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Keyboard shortcuts"
        className="fai-rise w-full max-w-2xl rounded-xl border border-border bg-surface-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-lg">Keyboard shortcuts</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-md text-text-secondary hover:bg-surface-hover"
          >
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="grid gap-6 sm:grid-cols-3">
          {GROUPS.map((g) => (
            <div key={g.label}>
              <div className="mb-3 font-mono text-[11px] uppercase tracking-wide text-text-tertiary">
                {g.label}
              </div>
              <ul className="flex flex-col gap-2.5">
                {g.rows.map((r) => (
                  <li key={r.label} className="flex items-center justify-between gap-2">
                    <span className="font-ui text-[13px] text-text-secondary">{r.label}</span>
                    <span className="flex gap-1">
                      {r.keys.map((k, i) => (
                        <span key={i} className="kbd">
                          {k}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
