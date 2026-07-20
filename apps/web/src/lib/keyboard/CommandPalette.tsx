import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@formai/ui';
import { SCREENS } from '../screens.js';
import { MOD_LABEL } from './platform.js';

interface Command {
  type: 'action' | 'nav';
  icon: string;
  label: string;
  hint: string;
  run: () => void;
}

/** Cmd/Ctrl+K command palette — navigate the app by keyboard. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commands = useMemo<Command[]>(() => {
    const go = (path: string) => () => {
      navigate(path);
      onClose();
    };
    const actions: Command[] = [
      { type: 'action', icon: 'file-up', label: 'Import a PDF', hint: 'Action', run: go('/app/import') },
      { type: 'action', icon: 'plus', label: 'New form from scratch', hint: 'Action', run: go('/app/forms/build') },
      { type: 'action', icon: 'user-plus', label: 'Invite a teammate', hint: 'Action', run: go('/app/team') },
    ];
    // Parameterised paths (the public /fill/:token page) can't be navigated
    // to without a concrete token, so they don't belong in the palette.
    const nav: Command[] = SCREENS.filter((s) => !s.path.includes(':')).map((s) => ({
      type: 'nav',
      icon: s.icon,
      label: s.label,
      hint: s.group.split(' ')[0] ?? '',
      run: go(s.path),
    }));
    const all = [...actions, ...nav];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((c) => c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q));
  }, [query, navigate, onClose]);

  useEffect(() => {
    if (index > commands.length - 1) setIndex(Math.max(0, commands.length - 1));
  }, [commands.length, index]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, commands.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commands[index]?.run();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--surface-overlay)] p-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Command palette"
        className="fai-rise w-full max-w-xl overflow-hidden rounded-xl border border-border bg-surface-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border-subtle px-4">
          <Icon name="search" size={18} className="text-text-tertiary" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search screens and actions…"
            className="h-12 flex-1 bg-transparent font-body text-sm text-text-primary outline-none placeholder:text-text-tertiary"
          />
          <span className="kbd">Esc</span>
        </div>
        <ul className="fai-scroll max-h-80 overflow-auto p-2">
          {commands.map((c, i) => (
            <li key={`${c.type}-${c.label}`}>
              <button
                onMouseEnter={() => setIndex(i)}
                onClick={c.run}
                data-active={i === index}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left font-ui text-sm text-text-primary data-[active=true]:bg-surface-accent-soft"
              >
                <Icon name={c.icon} size={16} className="text-text-secondary" />
                <span className="flex-1">{c.label}</span>
                <span className="font-mono text-[11px] text-text-tertiary">{c.hint}</span>
              </button>
            </li>
          ))}
          {commands.length === 0 && (
            <li className="px-3 py-6 text-center font-ui text-sm text-text-tertiary">
              No matches. Press <span className="kbd">{MOD_LABEL}</span>
              <span className="kbd">K</span> to close.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
