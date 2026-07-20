import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// vitest doesn't run with `test.globals: true` here (matching apps/web's
// explicit-import style), so @testing-library/react's automatic
// afterEach(cleanup) never registers itself. Without this, a dialog rendered
// in one test stays mounted into the next, and duplicate "Close dialog"
// buttons break getByLabelText.
afterEach(() => {
  cleanup();
});

// jsdom doesn't run layout, so `offsetParent` is always `null` — components
// that filter for visible elements via `offsetParent !== null` (e.g.
// Dialog's focus trap) would see zero candidates in every test. Approximate
// "attached and not display:none" instead, which is enough for tests that
// don't explicitly hide an element with `display: none`.
Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
  configurable: true,
  get(this: HTMLElement) {
    return this.parentElement;
  },
});
