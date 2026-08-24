import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignaturePad } from './SignaturePad.js';

/**
 * jsdom has no canvas: getContext returns null and toDataURL throws. These
 * tests stub both — the pad's contract under test is WHAT it emits and WHEN
 * it repaints, not pixel output.
 */

const EMITTED = 'data:image/png;base64,iVBORw0KEMITTED=';
const SAVED = 'data:image/png;base64,iVBORw0KSAVED=';

const fakeContext = {
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  drawImage: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  fillText: vi.fn(),
  lineWidth: 0,
  lineCap: '',
  lineJoin: '',
  strokeStyle: '',
  fillStyle: '',
  font: '',
  textBaseline: '',
};

/** Image stub whose load fires as soon as src is set — flushed via act(). */
class InstantImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  width = 200;
  height = 80;
  #src = '';
  set src(v: string) {
    this.#src = v;
    queueMicrotask(() => {
      if (v.startsWith('broken:')) this.onerror?.();
      else this.onload?.();
    });
  }
  get src() {
    return this.#src;
  }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    fakeContext as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(EMITTED);
  vi.stubGlobal('Image', InstantImage);
  if (!URL.createObjectURL) {
    Object.assign(URL, { createObjectURL: () => '', revokeObjectURL: () => {} });
  }
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
  vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fakeContext.drawImage.mockClear();
  fakeContext.clearRect.mockClear();
  fakeContext.fillRect.mockClear();
});

const flush = () => act(async () => {});

describe('SignaturePad value repaint', () => {
  it('paints a value that arrives AFTER mount — the async session prefill', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<SignaturePad value="" onChange={onChange} />);
    expect(fakeContext.drawImage).not.toHaveBeenCalled();

    rerender(<SignaturePad value={SAVED} onChange={onChange} />);
    await flush();
    expect(fakeContext.drawImage).toHaveBeenCalledTimes(1);
    // Painting an incoming value is display, not input — nothing re-emits.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('an external clear empties the canvas', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<SignaturePad value={SAVED} onChange={onChange} />);
    await flush();
    fakeContext.clearRect.mockClear();
    rerender(<SignaturePad value="" onChange={onChange} />);
    await flush();
    expect(fakeContext.clearRect).toHaveBeenCalled();
  });
});

describe('SignaturePad upload mode', () => {
  it('transcodes a picked image through the canvas and emits its PNG (AE2)', async () => {
    const onChange = vi.fn();
    render(<SignaturePad value="" onChange={onChange} allowUpload />);
    const input = screen.getByLabelText('Upload signature image');
    const file = new File(['fake-bytes'], 'sig.jpg', { type: 'image/jpeg' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    // Flattened white background, then the image, then the canvas's own PNG out.
    expect(fakeContext.fillRect).toHaveBeenCalled();
    expect(fakeContext.drawImage).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith(EMITTED);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses a non-image file with a visible error and emits nothing', async () => {
    const onChange = vi.fn();
    render(<SignaturePad value="" onChange={onChange} allowUpload />);
    const input = screen.getByLabelText('Upload signature image');
    const file = new File(['%PDF-'], 'doc.pdf', { type: 'application/pdf' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    expect(screen.getByRole('alert').textContent).toMatch(/not an image/i);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('hides the upload action unless opted in', () => {
    render(<SignaturePad value="" onChange={vi.fn()} />);
    expect(screen.queryByText('Upload image')).toBeNull();
  });
});

describe('SignaturePad clearing', () => {
  it('Clear emits the empty string', () => {
    const onChange = vi.fn();
    render(<SignaturePad value={SAVED} onChange={onChange} />);
    fireEvent.click(screen.getByText('Clear'));
    expect(onChange).toHaveBeenCalledWith('');
  });
});

describe('SignaturePad typed-signature fallback', () => {
  it('renders a typed name to PNG via onChange, and clearing it emits empty', async () => {
    const onChange = vi.fn();
    render(<SignaturePad value="" onChange={onChange} />);
    fireEvent.click(screen.getByText('Type instead'));
    const input = screen.getByLabelText('Type your signature');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'J. Bloggs' } });
    });
    expect(fakeContext.fillText).toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith(EMITTED);
    await act(async () => {
      fireEvent.change(input, { target: { value: '' } });
    });
    expect(onChange).toHaveBeenLastCalledWith('');
  });
});

describe('SignaturePad upload byte cap', () => {
  it('refuses a transcoded image over the cap and emits nothing', async () => {
    // toDataURL returns a payload well over 200KB for this test only.
    (HTMLCanvasElement.prototype.toDataURL as ReturnType<typeof vi.fn>).mockReturnValue(
      `data:image/png;base64,iVBORw0K${'A'.repeat(300 * 1024)}`,
    );
    const onChange = vi.fn();
    render(<SignaturePad value="" onChange={onChange} allowUpload />);
    const input = screen.getByLabelText('Upload signature image');
    const file = new File(['bytes'], 'huge.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    expect(screen.getByRole('alert').textContent).toMatch(/too detailed/i);
    expect(onChange).not.toHaveBeenCalled();
  });
});
