// PRD: §F-PER-4, §6.4 — TftRenderer RGB565->RGBA conversion (dev-plan P2.2).
// The pure `rgb565ToRgba` is the decoder the ST7789 snapshot path uses; the
// canvas binding is a thin putImageData wrapper, so exercising the decoder
// against known RGB565 words fully covers the visible behavior.
import { describe, it, expect } from 'vitest';
import { rgb565ToRgba, TftRenderer } from '../src/components/ScreenView/TftRenderer';
import type { RenderSnapshot } from '@breadesp/peripherals';

const RED = 0xf800; // R5=31 G6=0 B5=0
const GREEN = 0x07e0; // R5=0 G6=63 B5=0
const BLUE = 0x001f; // R5=0 G6=0 B5=31
const WHITE = 0xffff;
const BLACK = 0x0000;

/** Expand 5-bit channel to 8-bit by replicating the high bits into the low. */
const exp5 = (v: number): number => (v << 3) | (v >> 2);
const exp6 = (v: number): number => (v << 2) | (v >> 4);

function rgba(out: Uint8ClampedArray, i: number): [number, number, number, number] {
  return [out[i * 4], out[i * 4 + 1], out[i * 4 + 2], out[i * 4 + 3]];
}

describe('TftRenderer.rgb565ToRgba', () => {
  // 5/6/5 -> 8-bit uses bit replication (r8 = r5<<3 | r5>>2), the mapping a
  // real ST7789 panel shows: a pure channel (all 1s) is full-scale 255, not 248.
  it('decodes the primary colors with correct 5/6/5 -> 8-bit expansion', () => {
    const src = [RED, GREEN, BLUE, WHITE, BLACK];
    const out = new Uint8ClampedArray(5 * 4);
    rgb565ToRgba(5, 1, src, out);
    expect(rgba(out, 0)).toEqual([exp5(31), exp6(0), exp5(0), 255]);
    expect(rgba(out, 1)).toEqual([exp5(0), exp6(63), exp5(0), 255]);
    expect(rgba(out, 2)).toEqual([exp5(0), exp6(0), exp5(31), 255]);
    expect(rgba(out, 3)).toEqual([exp5(31), exp6(63), exp5(31), 255]); // white
    expect(rgba(out, 4)).toEqual([0, 0, 0, 255]); // black, alpha still opaque
  });

  it('decodes red as [255,0,0,255] and blue as [0,0,255,255] (pure channels -> full scale)', () => {
    const out = new Uint8ClampedArray(2 * 4);
    rgb565ToRgba(2, 1, [RED, BLUE], out);
    expect(rgba(out, 0)).toEqual([255, 0, 0, 255]);
    expect(rgba(out, 1)).toEqual([0, 0, 255, 255]);
  });

  it('decodes green as [0,255,0,255] (6-bit pure channel -> full scale)', () => {
    const out = new Uint8ClampedArray(4);
    rgb565ToRgba(1, 1, [GREEN], out);
    expect(rgba(out, 0)).toEqual([0, 255, 0, 255]);
  });

  it('writes row-major (y*width+x) so a 2x2 framebuffer scans rows first', () => {
    // layout: [RED GREEN; BLUE WHITE] -> scan order RED, GREEN, BLUE, WHITE
    const src = [RED, GREEN, BLUE, WHITE];
    const out = new Uint8ClampedArray(4 * 4);
    rgb565ToRgba(2, 2, src, out);
    expect(rgba(out, 0)).toEqual([255, 0, 0, 255]);
    expect(rgba(out, 1)).toEqual([0, 255, 0, 255]);
    expect(rgba(out, 2)).toEqual([0, 0, 255, 255]);
    expect(rgba(out, 3)).toEqual([255, 255, 255, 255]);
  });

  it('masks each word to 16 bits (stray high bits ignored)', () => {
    const out = new Uint8ClampedArray(2 * 4);
    rgb565ToRgba(2, 1, [RED | 0x10000, GREEN | 0xff000000], out);
    expect(rgba(out, 0)).toEqual([255, 0, 0, 255]);
    expect(rgba(out, 1)).toEqual([0, 255, 0, 255]);
  });

  it('ignores surplus trailing words (src longer than width*height)', () => {
    const out = new Uint8ClampedArray(4);
    rgb565ToRgba(1, 1, [RED, GREEN, BLUE], out); // 1 pixel, 3 words supplied
    expect(rgba(out, 0)).toEqual([255, 0, 0, 255]);
  });

  it('treats a deficit as black pixels (src shorter than width*height)', () => {
    const out = new Uint8ClampedArray(2 * 4);
    rgb565ToRgba(2, 1, [RED], out); // 2 pixels, 1 word supplied
    expect(rgba(out, 0)).toEqual([255, 0, 0, 255]);
    expect(rgba(out, 1)).toEqual([0, 0, 0, 255]); // missing word -> black
  });

  it('throws when the output buffer is too small', () => {
    expect(() => rgb565ToRgba(2, 2, [RED], new Uint8ClampedArray(7))).toThrow(/too small/);
  });

  it('renders an empty framebuffer as all-black opaque pixels', () => {
    const out = new Uint8ClampedArray(3 * 4);
    rgb565ToRgba(3, 1, [BLACK, BLACK, BLACK], out);
    for (let i = 0; i < 3; i++) expect(rgba(out, i)).toEqual([0, 0, 0, 255]);
  });
});

describe('TftRenderer.renderRgb565 (canvas binding)', () => {
  // A minimal canvas stub: getContext returns an object recording createImageData
  // and putImageData so we can assert the binding plumbs the decoded bytes.
  // Returns a holder object (not a getter) so the test can read `put` *after*
  // renderRgb565 mutates it.
  interface FakePut { width: number; height: number; data: Uint8ClampedArray; dx: number; dy: number }
  function fakeCanvas(width: number, height: number): { canvas: HTMLCanvasElement; holder: { put: FakePut | null } } {
    const holder = { put: null as FakePut | null };
    const ctx = {
      createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (img: { width: number; height: number; data: Uint8ClampedArray }, dx: number, dy: number) => {
        holder.put = { width: img.width, height: img.height, data: img.data, dx, dy };
      },
    };
    const canvas = { width, height, getContext: () => ctx } as unknown as HTMLCanvasElement;
    return { canvas, holder };
  }

  it('decodes into an ImageData and puts it at (0,0)', () => {
    const { canvas, holder } = fakeCanvas(2, 1);
    TftRenderer.renderRgb565(canvas, 2, 1, [RED, BLUE]);
    const put = holder.put;
    expect(put).not.toBeNull();
    expect(put!.width).toBe(2);
    expect(put!.height).toBe(1);
    expect(put!.dx).toBe(0);
    expect(put!.dy).toBe(0);
    // First pixel red, second blue — same decode as the pure path (pure -> 255).
    expect(Array.from(put!.data)).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });

  it('resizes the canvas backing store to match the snapshot dimensions', () => {
    const { canvas } = fakeCanvas(1, 1);
    TftRenderer.renderRgb565(canvas, 3, 2, [BLACK, BLACK, BLACK, BLACK, BLACK, BLACK]);
    expect(canvas.width).toBe(3);
    expect(canvas.height).toBe(2);
  });

  it('returns without throwing when 2d context is unavailable', () => {
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => TftRenderer.renderRgb565(canvas, 1, 1, [RED])).not.toThrow();
  });
});

describe('TftRenderer + ST7789 snapshot shape', () => {
  // Guards the integration seam: the ST7789 model emits a `pixels` snapshot
  // whose payload is { width, height, format:'rgb565', buffer: number[] }.
  // The renderer must accept that shape verbatim.
  it('decodes a RenderSnapshot-shaped payload', () => {
    const snap: RenderSnapshot = {
      instanceId: 'st7789-1',
      type: 'pixels',
      payload: { width: 2, height: 1, format: 'rgb565', buffer: [RED, BLUE] },
    };
    const p = snap.payload as { width: number; height: number; format: 'rgb565'; buffer: number[] };
    const out = new Uint8ClampedArray(p.width * p.height * 4);
    rgb565ToRgba(p.width, p.height, p.buffer, out);
    expect(rgba(out, 0)).toEqual([255, 0, 0, 255]);
    expect(rgba(out, 1)).toEqual([0, 0, 255, 255]);
  });
});
