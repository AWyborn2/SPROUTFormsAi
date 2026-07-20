import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { CommandPalette } from './CommandPalette.js';
import { ShortcutsOverlay } from './ShortcutsOverlay.js';
import { isModChord, isTypingTarget } from './platform.js';

interface KeyboardCtx {
  openPalette: () => void;
  closePalette: () => void;
  openShortcuts: () => void;
  closeShortcuts: () => void;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
}

const Ctx = createContext<KeyboardCtx | null>(null);

/**
 * Global keyboard layer. Owns the command palette (Cmd/Ctrl+K) and the
 * shortcuts overlay ("?"), and closes overlays on Escape. Screen-specific
 * shortcuts (e.g. the Form Builder's duplicate/reorder) register their own
 * handlers; this is the always-on baseline.
 */
export function KeyboardProvider({ children }: { children: React.ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isModChord(e) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape') {
        if (paletteOpen) {
          e.preventDefault();
          setPaletteOpen(false);
          return;
        }
        if (shortcutsOpen) {
          e.preventDefault();
          setShortcutsOpen(false);
          return;
        }
      }
      if (e.key === '?' && !isTypingTarget(e.target) && !paletteOpen) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [paletteOpen, shortcutsOpen]);

  const value = useMemo(
    () => ({
      openPalette,
      closePalette,
      openShortcuts,
      closeShortcuts,
      paletteOpen,
      shortcutsOpen,
    }),
    [openPalette, closePalette, openShortcuts, closeShortcuts, paletteOpen, shortcutsOpen],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {paletteOpen && <CommandPalette onClose={closePalette} />}
      {shortcutsOpen && <ShortcutsOverlay onClose={closeShortcuts} />}
    </Ctx.Provider>
  );
}

export function useKeyboard(): KeyboardCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useKeyboard must be used within KeyboardProvider');
  return ctx;
}
