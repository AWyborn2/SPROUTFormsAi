const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform + navigator.userAgent);

export const MOD_LABEL = isMac ? '⌘' : 'Ctrl';
export const ALT_LABEL = isMac ? '⌥' : 'Alt';
export const SHIFT_LABEL = isMac ? '⇧' : 'Shift';

/** True when a keyboard event should be treated as the platform "mod" chord. */
export function isModChord(e: KeyboardEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

/** True when focus is in a text-entry surface (so shortcuts should stand down). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}
