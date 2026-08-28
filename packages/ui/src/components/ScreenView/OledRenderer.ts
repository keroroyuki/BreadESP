// PRD: §F-PER-3 — Mono framebuffer (1 bit/pixel) -> Canvas.
// Assumes fb is stored row-major (y * width + x) = pixel bit; matches ssd1306 model output.
export const OledRenderer = {
  renderMono(canvas: HTMLCanvasElement, width: number, height: number, fb: Uint8Array): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(width, height);
    for (let i = 0; i < width * height; i++) {
      const on = fb[i] ? 255 : 0;
      img.data[i * 4 + 0] = on;
      img.data[i * 4 + 1] = on;
      img.data[i * 4 + 2] = on;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  },
};
