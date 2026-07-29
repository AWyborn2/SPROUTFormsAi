// pdfjs-dist references DOMMatrix at module load; Node has no DOM. Stub the
// bare minimum so suites that import screen modules (which transitively pull
// pdfjs-dist) can load in the node test environment.
if (typeof globalThis.DOMMatrix === 'undefined') {
  class DOMMatrixStub {}
  // @ts-expect-error -- minimal stand-in, not the full DOM interface
  globalThis.DOMMatrix = DOMMatrixStub;
}

// Component suites (jsdom, opted in per file) need @testing-library's cleanup
// registered by hand: vitest does not run with `test.globals: true` here, so
// the library's automatic afterEach never installs itself and a screen
// rendered in one test stays mounted into the next.
if (typeof document !== 'undefined') {
  const { afterEach } = await import('vitest');
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => {
    cleanup();
  });
}
