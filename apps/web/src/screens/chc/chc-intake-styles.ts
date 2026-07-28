/**
 * Scoped CSS for the CHC intake screen.
 *
 * Everything here is a state or media rule — `:focus`, `:hover`, `@media print`
 * — which inline styles cannot express. The palette is CHC's, not the app
 * theme's: this screen reproduces an approved branded document that is printed
 * and emailed outside the product, so it deliberately does not inherit the
 * workspace theme the way an ordinary form does. Every selector is prefixed
 * `chc-` so none of it can leak into the app shell around it.
 */
export const CHC_NAVY = '#1D3557';
export const CHC_BLUE = '#2E75B6';
export const CHC_RED = '#C62828';
export const CHC_BORDER = '#CBD5E0';
export const CHC_PAGE_BG = '#EAEEF3';

export const CHC_INTAKE_CSS = `
.chc-root {
  background: ${CHC_PAGE_BG};
  color: #1A202C;
  font-family: Inter, system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
  min-height: 100%;
}
.chc-input:focus, .chc-select:focus {
  border-color: ${CHC_BLUE};
  box-shadow: 0 0 0 3px rgba(46,117,182,0.12);
}
.chc-choice:hover { background: #F0F4F8; }
.chc-submit { background: ${CHC_NAVY}; transition: background 0.15s; }
.chc-submit:hover:not(:disabled) { background: #1D5F9E; }
.chc-submit:active:not(:disabled) { background: #174D85; }
.chc-submit:disabled { opacity: 0.65; cursor: not-allowed; }
.chc-btn-primary { background: ${CHC_BLUE}; transition: background 0.15s; }
.chc-btn-primary:hover { background: #3B82F6; }
.chc-btn-ghost { background: rgba(255,255,255,0.12); transition: background 0.15s; }
.chc-btn-ghost:hover { background: rgba(255,255,255,0.2); }
.chc-btn-green { background: #2E7D32; transition: background 0.15s; }
.chc-btn-green:hover { background: #1B5E20; }
.chc-btn-green-soft { background: rgba(30,90,50,0.12); transition: background 0.15s; }
.chc-btn-green-soft:hover { background: rgba(30,90,50,0.2); }
.chc-spin { animation: chc-spin 1s linear infinite; }
@keyframes chc-spin { to { transform: rotate(360deg); } }

@media print {
  /* The printed page IS the deliverable here, so backgrounds and rules must
     survive the browser's default ink-saving. */
  .chc-root * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .chc-no-print { display: none !important; }
  .chc-root { background: #fff; }
  .chc-doc { box-shadow: none !important; padding: 0 !important; }
}
`;
