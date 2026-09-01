// PRD: §F-PER-4, §6.4 — RGB565 framebuffer (16 bit/pixel) -> Canvas.
// The ST7789 model emits a `pixels` snapshot whose payload carries the
// glass-resolved framebuffer as a `number[]` of R5G6B5 words (the model already
// applied BGR ordering, so this renderer always decodes the high 5 bits as R,
// the middle 6 as G and the low 5 as B — see st7789.render()).
//
// The conversion is split into a pure `rgb565ToRgba` (no DOM, unit-testable in
// Node) and a thin `renderRgb565` that binds it to an HTMLCanvasElement the
// same way OledRenderer binds the mono path.
//
// TODO(PRD §F-PER-4): `argb8888` format is listed in §6.4 but not emitted by
// any MVP peripheral; add it here when a model starts producing it.

/** Minimum RGBA byte length for `width`x`height` pixels. */
const rgbaLen = (width: number, height: number): number => width * height * 4;

/**
 * Decode an R5G6B5 word array into an RGBA byte buffer.
 *
 * @param width  framebuffer width in pixels
 * @param height framebuffer height in pixels
 * @param src    R5G6B5 words, row-major (index = y * width + x); extra trailing
 *               words are ignored, a deficit leaves the remaining pixels black
 * @param out    destination RGBA bytes (length >= width*height*4); allocated
 *               by the caller so the canvas path can reuse an ImageData buffer
 */
export function rgb565ToRgba(
  width: number,
  height: number,
  src: ArrayLike<number>,
  out: Uint8ClampedArray | Uint8Array,
): void {
  const pixels = width * height;
  if (out.length < rgbaLen(width, height)) {
    throw new Error(`TftRenderer: output buffer too small (${out.length} < ${rgbaLen(width, height)})`);
  }
  for (let i = 0; i < pixels; i++) {
    const v = src[i] & 0xffff;
    // Expand 5/6/5 channels to 8 bits by replicating the top bits into the
    // low end (the standard "5-bit to 8-bit" expansion: r8 = (r5 << 3) | (r5 >> 2)).
    const r5 = (v >> 11) & 0x1f;
    const g6 = (v >> 5) & 0x3f;
    const b5 = v & 0x1f;
    out[i * 4 + 0] = (r5 << 3) | (r5 >> 2);
    out[i * 4 + 1] = (g6 << 2) | (g6 >> 4);
    out[i * 4 + 2] = (b5 << 3) | (b5 >> 2);
    out[i * 4 + 3] = 255;
  }
}

export const TftRenderer = {
  rgb565ToRgba,

  /** Render an RGB565 framebuffer onto a canvas, replacing its contents. */
  renderRgb565(canvas: HTMLCanvasElement, width: number, height: number, src: ArrayLike<number>): void {
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(width, height);
    rgb565ToRgba(width, height, src, img.data);
    ctx.putImageData(img, 0, 0);
  },
};
