import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '@formai/ui';
import { FORM_FONTS, GOOGLE_FONT_FAMILIES } from '@formai/shared';
import { fontStack } from '../../lib/branding.js';
import { ensureFontLoaded } from '../../lib/font-loader.js';

/** How many matches the results list renders before asking for a narrower query. */
const FONT_RESULT_LIMIT = 40;

/**
 * Font selection: four quick picks over a text-filtered listbox of the whole
 * bundled Google Fonts catalog. Deliberately *not* a free-text field — the
 * value is persisted and validated against the same catalog server-side, so
 * anything typed can only ever select, never submit.
 *
 * Shared by the onboarding wizard and the branding settings screen so the two
 * cannot drift; the settings screen previously offered a hardcoded three-font
 * list that could not express what the wizard had already saved.
 */
export function FontPicker({ value, onPick }: { value: string; onPick: (family: string) => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // The quick picks render their own name as a specimen, so each needs its
  // stylesheet — this is precisely the bug the old picker had with Spectral.
  useEffect(() => {
    for (const family of FORM_FONTS) ensureFontLoaded(family);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = q ? GOOGLE_FONT_FAMILIES.filter((f) => f.toLowerCase().includes(q)) : [];
    return pool.slice(0, FONT_RESULT_LIMIT);
  }, [query]);

  const select = (family: string) => {
    onPick(family);
    setQuery('');
    setActive(0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (matches.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next =
        e.key === 'ArrowDown'
          ? (active + 1) % matches.length
          : (active - 1 + matches.length) % matches.length;
      setActive(next);
      listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const family = matches[active];
      if (family) select(family);
    } else if (e.key === 'Escape') {
      setQuery('');
      setActive(0);
    }
  };

  return (
    <div>
      <div className="mb-2 flex gap-2">
        {FORM_FONTS.map((family) => {
          const selected = value === family;
          return (
            <button
              key={family}
              onClick={() => select(family)}
              aria-pressed={selected}
              className="fai-chip-btn flex-1 rounded-md border-[1.5px] px-2 py-[11px] text-center"
              style={{
                borderColor: selected ? 'var(--border-accent)' : 'var(--border-default)',
                background: selected ? 'var(--surface-accent-soft)' : 'var(--surface-card)',
              }}
            >
              <span
                className="block text-[17px] font-semibold text-text-primary"
                style={{ fontFamily: fontStack(family) }}
              >
                Ag
              </span>
              <span className="mt-[3px] block truncate text-[11px] text-text-tertiary">
                {family}
              </span>
            </button>
          );
        })}
      </div>

      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={query.trim().length > 0}
        aria-controls="font-results"
        aria-autocomplete="list"
        aria-label="Search all Google Fonts"
        placeholder="Search all Google Fonts…"
        className="h-[34px] w-full rounded-md border border-border bg-surface-sunken px-[9px] text-[13px] text-text-primary"
      />

      {query.trim().length > 0 &&
        (matches.length === 0 ? (
          <p className="mt-2 px-[9px] text-xs text-text-tertiary">No fonts found.</p>
        ) : (
          <ul
            id="font-results"
            ref={listRef}
            role="listbox"
            aria-label="Google Fonts"
            className="fai-scroll mt-2 max-h-[190px] overflow-auto rounded-md border border-border bg-surface-card"
          >
            {matches.map((family, i) => (
              <li key={family} role="option" aria-selected={value === family}>
                <button
                  onClick={() => select(family)}
                  onMouseEnter={() => setActive(i)}
                  className="flex w-full items-center justify-between px-[11px] py-[7px] text-left text-[13px] text-text-primary"
                  style={{
                    background: i === active ? 'var(--surface-accent-soft)' : 'transparent',
                  }}
                >
                  <span className="truncate">{family}</span>
                  {value === family && (
                    <Icon name="check" size={13} className="flex-none text-accent" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        ))}

      <p className="mt-2 text-[11.5px] text-text-tertiary">
        Selected: <span style={{ fontFamily: fontStack(value) }}>{value}</span>
      </p>
    </div>
  );
}
