// PRD: §6.3, §F-PER-4 — ST7789 command interpreter tests for the Adafruit_GFX /
// TFT_eSPI common draw path (dev-plan task P2.1): SPI command/data split via
// the DC GPIO, multi-byte command parameters (CASET/RASET/MADCTL), window
// addressing and wrap, MADCTL orientation (address -> glass transform),
// RGB/BGR order, inversion, and display sleep/off blanking.
//
// SPI framing note: the DC line is latched per CS frame (the QEMU controller
// clocks a whole frame atomically), so an opcode and its parameters always
// arrive as separate frames — DC=0 opcode frame, then a DC=1 parameter frame.
// That is exactly what TFT_eSPI-style drivers emit (DC_C; write; DC_D; write).
import { describe, it, expect } from 'vitest';
import { st7789Factory } from '../src/st7789';
import type { RenderSnapshot, PeripheralContext, Peripheral, BusTransaction } from '../src/types';

const CS = 1;
const DC = 5;
const W = 240;
const H = 240;

function makeCtx(snapshots: RenderSnapshot[], logs: string[] = []): PeripheralContext {
  return {
    emitSnapshot: (s) => snapshots.push(s),
    log: (_level, msg) => logs.push(msg),
    onTick: () => () => {},
  };
}

let ts = 0;
function spi(bytes: number[], cs = CS): BusTransaction {
  return { kind: 'spi', bus: 0, target: cs, dir: 'write', data: Uint8Array.from(bytes), ts: ts++ };
}

function gpio(pin: number, level: 0 | 1): BusTransaction {
  return { kind: 'gpio', bus: 0, target: pin, dir: 'write', data: Uint8Array.from([level]), ts: ts++ };
}

/** One SPI frame: set the DC line, then clock the bytes. */
function frame(p: Peripheral, dc: 0 | 1, bytes: number[]): void {
  p.onTransaction(gpio(DC, dc));
  p.onTransaction(spi(bytes));
}

const cmd = (p: Peripheral, bytes: number[]) => frame(p, 0, bytes);
const dat = (p: Peripheral, bytes: number[]) => frame(p, 1, bytes);

interface PixelsPayload { width: number; height: number; format: 'rgb565'; buffer: number[] }

function pixelsOf(s: RenderSnapshot): PixelsPayload {
  if (s.type !== 'pixels') throw new Error(`not a pixels snapshot: ${s.type}`);
  // 'pixels' uniquely matches the framebuffer payload variant of the union (IPC boundary).
  return s.payload as PixelsPayload;
}

/** RGB565 word -> big-endian byte pair (high byte first, per the panel). */
const be = (v: number): number[] => [(v >> 8) & 0xff, v & 0xff];

/** CASET window: opcode frame + 16-bit start/end parameter frame. */
function caset(p: Peripheral, x0: number, x1: number): void {
  cmd(p, [0x2a]);
  dat(p, [x0 >> 8, x0 & 0xff, x1 >> 8, x1 & 0xff]);
}

/** RASET window: opcode frame + 16-bit start/end parameter frame. */
function raset(p: Peripheral, y0: number, y1: number): void {
  cmd(p, [0x2b]);
  dat(p, [y0 >> 8, y0 & 0xff, y1 >> 8, y1 & 0xff]);
}

/** SLPOUT + COLMOD(16bpp) + MADCTL + DISPON — the minimum to light the glass. */
function begin(p: Peripheral, madctl = 0x00): void {
  cmd(p, [0x11]);       // SLPOUT
  cmd(p, [0x3a]);       // COLMOD
  dat(p, [0x55]);       // 16-bit/pixel
  cmd(p, [0x36]);       // MADCTL
  dat(p, [madctl]);
  cmd(p, [0x29]);       // DISPON
}

describe('st7789', () => {
  it('renders a full-window RGB565 stream after the TFT_eSPI-style init', () => {
    const snaps: RenderSnapshot[] = [];
    const p = st7789Factory.create(makeCtx(snaps), { instanceId: 'tft1', cs: CS, dc: DC });

    begin(p);
    caset(p, 0, W - 1);
    raset(p, 0, H - 1);
    cmd(p, [0x2c]); // RAMWR
    dat(p, [...be(0xf800), ...be(0x07e0), ...be(0x001f)]); // red, green, blue

    const last = pixelsOf(snaps.at(-1)!);
    expect(last.width).toBe(W);
    expect(last.height).toBe(H);
    expect(last.format).toBe('rgb565');
    expect(last.buffer).toHaveLength(W * H);
    expect(last.buffer[0 * W + 0]).toBe(0xf800); // first stream pixel -> (0,0)
    expect(last.buffer[0 * W + 1]).toBe(0x07e0);
    expect(last.buffer[0 * W + 2]).toBe(0x001f);
    expect(last.buffer[0 * W + 3]).toBe(0x0000); // untouched GRAM stays black
  });

  it('applies the DC level of the frame to every byte in it', () => {
    const snaps: RenderSnapshot[] = [];
    const p = st7789Factory.create(makeCtx(snaps), { instanceId: 'tft1', cs: CS, dc: DC });

    begin(p);
    caset(p, 0, 9);
    raset(p, 0, 9);
    cmd(p, [0x2c]);
    // A DC=1 frame whose bytes coincide with opcodes must stay payload.
    dat(p, [...be(0x2a2a), ...be(0x2c2c)]); // 0x2a/0x2c are CASET/RAMWR opcodes

    const fb = pixelsOf(snaps.at(-1)!).buffer;
    expect(fb[0 * W + 0]).toBe(0x2a2a);
    expect(fb[0 * W + 1]).toBe(0x2c2c);
  });

  it('continues a pixel split across two DC=1 frames (half-word boundary)', () => {
    const snaps: RenderSnapshot[] = [];
    const p = st7789Factory.create(makeCtx(snaps), { instanceId: 'tft1', cs: CS, dc: DC });

    begin(p);
    caset(p, 0, 0);
    raset(p, 0, 0);
    cmd(p, [0x2c]);
    dat(p, [0xf8]); // high byte only
    dat(p, [0x00]); // low byte of the same pixel

    expect(pixelsOf(snaps.at(-1)!).buffer[0]).toBe(0xf800);
  });

  it('writes into the CASET/RASET window and wraps to its start', () => {
    const snaps: RenderSnapshot[] = [];
    const p = st7789Factory.create(makeCtx(snaps), { instanceId: 'tft1', cs: CS, dc: DC });

    begin(p);
    caset(p, 10, 12); // 3 columns
    raset(p, 20, 22); // 3 rows -> 9-pixel window
    cmd(p, [0x2c]);
    // 9 pixels fill the window; the 10th wraps back onto (10, 20).
    dat(p, [...be(1), ...be(2), ...be(3), ...be(4), ...be(5), ...be(6), ...be(7), ...be(8), ...be(9), ...be(10)]);

    const fb = pixelsOf(snaps.at(-1)!).buffer;
    expect(fb[20 * W + 10]).toBe(10); // wrapped write overwrote pixel 1
    expect(fb[20 * W + 11]).toBe(2);
    expect(fb[20 * W + 12]).toBe(3);
    expect(fb[21 * W + 10]).toBe(4);
    expect(fb[22 * W + 12]).toBe(9);
    expect(fb[0 * W + 0]).toBe(0); // nothing outside the window
  });

  it('maps the address counter onto the glass per MADCTL rotation', () => {
    // First pixel of a full-window stream, per the datasheet scan figures /
    // TFT_eSPI setRotation conventions (counter always starts at (0,0)).
    const cases: Array<{ madctl: number; x: number; y: number }> = [
      { madctl: 0x00, x: 0, y: 0 },     // rotation 0: top-left
      { madctl: 0x60, x: 239, y: 0 },   // rotation 1 (MX|MV): top-right
      { madctl: 0xc0, x: 239, y: 239 }, // rotation 2 (MX|MY): bottom-right
      { madctl: 0xa0, x: 0, y: 239 },   // rotation 3 (MY|MV): bottom-left
    ];
    for (const { madctl, x, y } of cases) {
      const snaps: RenderSnapshot[] = [];
      const p = st7789Factory.create(makeCtx(snaps), { instanceId: 'tft1', cs: CS, dc: DC });
      begin(p, madctl);
      caset(p, 0, W - 1);
      raset(p, 0, H - 1);
      cmd(p, [0x2c]);
      dat(p, be(0x1234));
      expect(pixelsOf(snaps.at(-1)!).buffer[y * W + x]).toBe(0x1234);
    }
  });

  it('lands rotated partial windows where TFT_eSPI drawPixel() expects them', () => {
    // Rotation 1 (MADCTL 0x60): address (rx, ry) shows at glass (239-ry, rx).
    const snaps: RenderSnapshot[] = [];
    const p = st7789Factory.create(makeCtx(snaps), { instanceId: 'tft1', cs: CS, dc: DC });
    begin(p, 0x60);
    caset(p, 0, 2); // rx 0..2
    raset(p, 5, 5); // ry 5 -> glass column 234
    cmd(p, [0x2c]);
    dat(p, [...be(0x1111), ...be(0x2222), ...be(0x3333)]);

    const fb = pixelsOf(snaps.at(-1)!).buffer;
    expect(fb[0 * W + 234]).toBe(0x1111);
    expect(fb[1 * W + 234]).toBe(0x2222);
    expect(fb[2 * W + 234]).toBe(0x3333);
  });

  it('swaps R and B when MADCTL selects BGR order', () => {
    const snaps: RenderSnapshot[] = [];
    const p = st7789Factory.create(makeCtx(snaps), { instanceId: 'tft1', cs: CS, dc: DC });

    begin(p, 0x08); // BGR
    caset(p, 0, 0);
    raset(p, 0, 0);
    cmd(p, [0x2c]);
    dat(p, be(0xf800)); // R5=31 -> glass shows blue

    expect(pixelsOf(snaps.at(-1)!).buffer[0]).toBe(0x001f);
  });

  it('blanks the glass while asleep or display-off, and shows it after', () => {
    const snaps: RenderSnapshot[] = [];
    const p = st7789Factory.create(makeCtx(snaps), { instanceId: 'tft1', cs: CS, dc: DC });

    caset(p, 0, 0);
    raset(p, 0, 0);
    cmd(p, [0x2c]);
    dat(p, be(0xabcd)); // GRAM holds a pixel but the panel is asleep
    expect(pixelsOf(snaps.at(-1)!).buffer.every((v) => v === 0)).toBe(true);

    cmd(p, [0x11]); // SLPOUT alone is not enough (DISPOFF is the default)
    expect(pixelsOf(snaps.at(-1)!).buffer.every((v) => v === 0)).toBe(true);

    cmd(p, [0x29]); // DISPON
    expect(pixelsOf(snaps.at(-1)!).buffer[0]).toBe(0xabcd);

    cmd(p, [0x10]); // SLPIN blanks again
    expect(pixelsOf(snaps.at(-1)!).buffer.every((v) => v === 0)).toBe(true);
  });

  it('inverts colors with INVON and restores them with INVOFF', () => {
    const snaps: RenderSnapshot[] = [];
    const p = st7789Factory.create(makeCtx(snaps), { instanceId: 'tft1', cs: CS, dc: DC });

    begin(p);
    caset(p, 0, 1);
    raset(p, 0, 0);
    cmd(p, [0x2c]);
    dat(p, [...be(0x0000), ...be(0xffff)]);

    cmd(p, [0x21]); // INVON
    let fb = pixelsOf(snaps.at(-1)!).buffer;
    expect(fb[0]).toBe(0xffff);
    expect(fb[1]).toBe(0x0000);

    cmd(p, [0x20]); // INVOFF
    fb = pixelsOf(snaps.at(-1)!).buffer;
    expect(fb[0]).toBe(0x0000);
    expect(fb[1]).toBe(0xffff);
  });

  it('ends the RAMWR stream when any other command arrives', () => {
    const snaps: RenderSnapshot[] = [];
    const p = st7789Factory.create(makeCtx(snaps), { instanceId: 'tft1', cs: CS, dc: DC });

    begin(p);
    caset(p, 0, 3);
    raset(p, 0, 0);
    cmd(p, [0x2c]);
    dat(p, [...be(0x1111), ...be(0x2222)]); // two pixels, stream open

    caset(p, 0, 3);                        // CASET interrupts the stream
    dat(p, [...be(0x9999), ...be(0x8888)]); // ...so these stay parameters/stray, not pixels

    const fb = pixelsOf(snaps.at(-1)!).buffer;
    expect(fb[0]).toBe(0x1111);
    expect(fb[1]).toBe(0x2222);
    expect(fb[2]).toBe(0x0000);
    expect(fb[3]).toBe(0x0000);
    expect(fb.includes(0x9999)).toBe(false);
  });

  it('resets to power-on defaults on SWRESET', () => {
    const snaps: RenderSnapshot[] = [];
    const p = st7789Factory.create(makeCtx(snaps), { instanceId: 'tft1', cs: CS, dc: DC });

    begin(p);
    cmd(p, [0x21]); // INVON
    caset(p, 0, 0);
    raset(p, 0, 0);
    cmd(p, [0x2c]);
    dat(p, be(0xffff));

    cmd(p, [0x01]); // SWRESET: display off, sleep, window reset, GRAM cleared
    expect(pixelsOf(snaps.at(-1)!).buffer.every((v) => v === 0)).toBe(true);
    cmd(p, [0x29]); // DISPON again: GRAM stayed cleared
    expect(pixelsOf(snaps.at(-1)!).buffer.every((v) => v === 0)).toBe(true);
  });

  it('ignores SPI frames on other CS lines and read transactions', () => {
    const snaps: RenderSnapshot[] = [];
    const p = st7789Factory.create(makeCtx(snaps), { instanceId: 'tft1', cs: CS, dc: DC });

    p.onTransaction(gpio(DC, 0));
    p.onTransaction(spi([0x11], 2)); // different CS line
    p.onTransaction(gpio(DC, 0));
    p.onTransaction({
      kind: 'spi', bus: 0, target: CS, dir: 'read', data: new Uint8Array(0), length: 4, ts: ts++,
    });
    p.onTransaction({ kind: 'gpio', bus: 0, target: 7, dir: 'write', data: Uint8Array.from([1]), ts: ts++ });
    expect(snaps).toHaveLength(0);
  });

  it('warns once when the DC GPIO is not configured on the instance', () => {
    const snaps: RenderSnapshot[] = [];
    const logs: string[] = [];
    const p = st7789Factory.create(makeCtx(snaps, logs), { instanceId: 'tft1', cs: CS });

    p.onTransaction(spi([0x11]));
    p.onTransaction(spi([0x2a]));
    expect(logs.filter((l) => l.includes('props.dc')).length).toBe(1);
  });
});
