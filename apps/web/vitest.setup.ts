// pdfjs-dist references DOMMatrix at module load; Node has no DOM. Stub the
// bare minimum so suites that import screen modules (which transitively pull
// pdfjs-dist) can load in the node test environment.
if (typeof globalThis.DOMMatrix === 'undefined') {
  class DOMMatrixStub {}
  // @ts-expect-error -- minimal stand-in, not the full DOM interface
  globalThis.DOMMatrix = DOMMatrixStub;
}
