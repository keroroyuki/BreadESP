// PRD: §6.3, §F-PER-3 — SSD1306 command interpreter tests for the Adafruit_GFX
// common draw path (dev-plan P1.6): I2C framing, multi-byte command parameters,
// addressing modes, orientation, and full-frame display() updates.
import { describe, it, expect } from 'vitest';
import { ssd1306Factory } from '../src/ssd1306';
import type { RenderSnapshot, PeripheralContext, BusTransaction } from '../src/types';

const ADDR = 0x3c;
const W = 128;
const H = 64;

function makeCtx(snapshots: RenderSnapshot[]): PeripheralContext {
  return {
    emitSnapshot: (s) => snapshots.push(s),
    log: () => {},
    onTick: () => () => {},
  };
}

let ts = 0;
function i2cWrite(data: number[] | Uint8Array, target = ADDR): BusTransaction {
  return {
    kind: 'i2c', bus: 0, target, dir: 'write', data: Uint8Array.from(data), ts: ts++,
  };
}

/** One command-stream transaction: control byte 0x00 + SSD1306 opcodes/params. */
const cmd = (bytes: number[]): BusTransaction => i2cWrite([0x00, ...bytes]);

/** One data-stream transaction: control byte 0x40 + framebuffer bytes. */
const dat = (bytes: number[] | Uint8Array): BusTransaction => i2cWrite([0x40, ...Array.from(bytes)]);

interface PixelsPayload { width: number; height: number; format: 'mono'; buffer: number[] }

function pixelsOf(s: RenderSnapshot): PixelsPayload {
  if (s.type !== 'pixels') throw new Error(`not a pixels snapshot: ${s.type}`);
  // 'pixels' uniquely matches the framebuffer payload variant of the union (IPC boundary).
  return s.payload as PixelsPayload;
}

/** Adafruit_GFX drawPixel for rotation 0 on a 128x64 SSD1306 RAM image. */
function gfxPixel(ram: Uint8Array, x: number, y: number): void {
  ram[x + (y >> 3) * W] |= 1 << (y & 7);
}

/** Adafruit_SSD1306::begin() command sequence for the 128x64 I2C module. */
const ADAFRUIT_INIT: number[] = [
  0xae,       // display off
  0xd5, 0x80, // clock divide
  0xa8, 0x3f, // multiplex 63
  0xd3, 0x00, // display offset
  0x40,       // start line 0
  0x8d, 0x14, // charge pump
  0x20, 0x00, // horizontal addressing mode
  0xa1,       // segment remap (Adafruit default)
  0xc8,       // COM scan decrement (Adafruit default)
  0xda, 0x12, // COM pins: alternative config
  0x81, 0xcf, // contrast
  0xd9, 0xf1, // precharge
  0xdb, 0x40, // VCOMH deselect
  0xa4,       // entire display follows RAM
  0xa6,       // non-inverted
  0xaf,       // display on
];

/** Adafruit_SSD1306::display() addressing commands (page 0..0xFF is Adafruit's full-range). */
const ADAFRUIT_DISPLAY: number[] = [0x22, 0x00, 0xff, 0x21, 0x00, 0x7f];

describe('ssd1306', () => {
  it('renders an Adafruit_GFX demo frame upright (begin + display path)', () => {
    const snaps: RenderSnapshot[] = [];
    const p = ssd1306Factory.create(makeCtx(snaps), { instanceId: 'oled1', address: ADDR });

    p.onTransaction(cmd(ADAFRUIT_INIT));

    // clearDisplay() + a handful of drawPixel calls accumulated in the GFX buffer.
    const ram = new Uint8Array(W * H / 8);
    const pixels: Array<[number, number]> = [
      [0, 0], [127, 63], [5, 9], [64, 32], [10, 40], [100, 3],
    ];
    for (const [x, y] of pixels) gfxPixel(ram, x, y);

    p.onTransaction(cmd(ADAFRUIT_DISPLAY));
    p.onTransaction(dat(ram)); // one 1024-byte framebuffer transaction

    const fb = pixelsOf(snaps.at(-1)!).buffer;
    expect(fb).toHaveLength(W * H);
    const expected = new Uint8Array(W * H);
    for (const [x, y] of pixels) expected[y * W + x] = 1;
    expect(fb).toEqual(Array.from(expected));
  });

  it('emits a pixels snapshot on a page-mode data write', () => {
    const snaps: RenderSnapshot[] = [];
    const p = ssd1306Factory.create(makeCtx(snaps), { instanceId: 'oled1', address: ADDR });
    p.onTransaction(cmd([0xaf, 0xa1, 0xc8])); // display on, identity orientation
    p.onTransaction(cmd([0xb0]));            // page 0, column 0
    p.onTransaction(dat([0xff]));            // all 8 rows of page 0, column 0
    const fb = pixelsOf(snaps.at(-1)!).buffer;
    for (let y = 0; y < 8; y++) expect(fb[y * W]).toBe(1);
    expect(fb[8 * W]).toBe(0);
  });

  it('treats 0x00/0x40 data bytes as payload, not control bytes', () => {
    const snaps: RenderSnapshot[] = [];
    const p = ssd1306Factory.create(makeCtx(snaps), { instanceId: 'oled1', address: ADDR });
    p.onTransaction(cmd([0xaf, 0xa1, 0xc8, 0x20, 0x00, 0x21, 0x00, 0x7f, 0x22, 0x00, 0x07]));
    p.onTransaction(dat([0x00, 0x40, 0xff]));
    const fb = pixelsOf(snaps.at(-1)!).buffer;
    expect(fb[0 * W + 0]).toBe(0);  // 0x00 payload: column 0 stays blank
    expect(fb[6 * W + 1]).toBe(1);  // 0x40 payload: bit 6 of column 1
    expect(fb[5 * W + 1]).toBe(0);
    expect(fb[0 * W + 2]).toBe(1); // 0xff payload: full column 2
    expect(fb[7 * W + 2]).toBe(1);
  });

  it('consumes multi-byte command parameters without misparsing them as opcodes', () => {
    const snaps: RenderSnapshot[] = [];
    const p = ssd1306Factory.create(makeCtx(snaps), { instanceId: 'oled1', address: ADDR });
    // Horizontal mode, window columns 16..31, pages 0..7, identity orientation, display on.
    p.onTransaction(cmd([0x20, 0x00, 0x21, 0x10, 0x1f, 0x22, 0x00, 0x07, 0xa1, 0xc8, 0xaf]));
    p.onTransaction(dat([0x01]));
    const fb = pixelsOf(snaps.at(-1)!).buffer;
    expect(fb[0 * W + 16]).toBe(1); // first data byte lands at the window start
    expect(fb[0 * W + 0]).toBe(0);  // ...not at column 0 (would mean args were misparsed)
  });

  it('maps RAM(0,0) through the orientation matrix', () => {
    const cases: Array<{ cmds: number[]; x: number; y: number }> = [
      { cmds: [0xa1, 0xc8], x: 0, y: 0 },    // Adafruit defaults: identity
      { cmds: [], x: 127, y: 63 },           // power-on: mirrored both axes
      { cmds: [0xa1], x: 0, y: 63 },         // segment remap only
      { cmds: [0xc8], x: 127, y: 0 },        // COM scan only
      { cmds: [0xa0, 0xc0], x: 127, y: 63 }, // explicit normals == power-on
    ];
    for (const { cmds, x, y } of cases) {
      const snaps: RenderSnapshot[] = [];
      const p = ssd1306Factory.create(makeCtx(snaps), { instanceId: 'oled1', address: ADDR });
      p.onTransaction(cmd([0xaf, ...cmds]));
      p.onTransaction(dat([0x01])); // page 0, column 0, bit 0
      const fb = pixelsOf(snaps.at(-1)!).buffer;
      expect(fb[y * W + x]).toBe(1);
    }
  });

  it('addresses columns via low/high nibbles in page mode and wraps at 128', () => {
    const snaps: RenderSnapshot[] = [];
    const p = ssd1306Factory.create(makeCtx(snaps), { instanceId: 'oled1', address: ADDR });
    p.onTransaction(cmd([0xaf, 0xa1, 0xc8, 0xb0, 0x05, 0x12])); // page 0, column (2<<4)|5 = 37
    p.onTransaction(dat([0x80]));                              // bit 7 -> row 7
    let fb = pixelsOf(snaps.at(-1)!).buffer;
    expect(fb[7 * W + 37]).toBe(1);

    // colPtr is now 38; 90 more bytes reach column 127, the 91st wraps to column 0.
    const bytes = new Array<number>(128).fill(0);
    bytes[90] = 0x01;
    p.onTransaction(dat(bytes));
    fb = pixelsOf(snaps.at(-1)!).buffer;
    expect(fb[0 * W + 0]).toBe(1); // wrapped write, still page 0
  });

  it('fills the whole frame in horizontal mode and wraps to the window start', () => {
    const snaps: RenderSnapshot[] = [];
    const p = ssd1306Factory.create(makeCtx(snaps), { instanceId: 'oled1', address: ADDR });
    p.onTransaction(cmd([0xaf, 0xa1, 0xc8, 0x20, 0x00]));
    const ram = new Uint8Array(W * H / 8 + 1); // 1024-byte frame + one wrap byte
    ram[7 * W + 127] = 0x01;                   // last byte of the frame
    ram[W * H / 8] = 0x02;                     // wraps to page 0 column 0, bit 1
    p.onTransaction(dat(ram));
    const fb = pixelsOf(snaps.at(-1)!).buffer;
    expect(fb[56 * W + 127]).toBe(1); // frame's last byte at page 7, column 127
    expect(fb[1 * W + 0]).toBe(1);    // wrap byte at page 0, column 0
    expect(fb[0 * W + 0]).toBe(0);
  });

  it('fills columns-first in vertical addressing mode', () => {
    const snaps: RenderSnapshot[] = [];
    const p = ssd1306Factory.create(makeCtx(snaps), { instanceId: 'oled1', address: ADDR });
    p.onTransaction(cmd([0xaf, 0xa1, 0xc8, 0x20, 0x01, 0x21, 0x00, 0x7f, 0x22, 0x00, 0x07]));
    const bytes = new Array<number>(16).fill(0);
    bytes[3] = 0x01; // byte 3 -> page 3, column 0 -> row 24
    bytes[9] = 0x01; // byte 9 -> page 1, column 1 -> row 8
    p.onTransaction(dat(bytes));
    const fb = pixelsOf(snaps.at(-1)!).buffer;
    expect(fb[24 * W + 0]).toBe(1);
    expect(fb[8 * W + 1]).toBe(1);
  });

  it('keeps the glass blank while the display is off, then renders after 0xAF', () => {
    const snaps: RenderSnapshot[] = [];
    const p = ssd1306Factory.create(makeCtx(snaps), { instanceId: 'oled1', address: ADDR });
    p.onTransaction(cmd([0xa1, 0xc8, 0xb0]));
    p.onTransaction(dat([0x01]));
    expect(pixelsOf(snaps.at(-1)!).buffer.every((v) => v === 0)).toBe(true);
    p.onTransaction(cmd([0xaf]));
    expect(pixelsOf(snaps.at(-1)!).buffer[0]).toBe(1);
  });

  it('inverts the whole glass with 0xA7 and restores with 0xA6', () => {
    const snaps: RenderSnapshot[] = [];
    const p = ssd1306Factory.create(makeCtx(snaps), { instanceId: 'oled1', address: ADDR });
    p.onTransaction(cmd([0xaf, 0xa1, 0xc8, 0xb0]));
    p.onTransaction(dat([0x01]));
    p.onTransaction(cmd([0xa7]));
    let fb = pixelsOf(snaps.at(-1)!).buffer;
    expect(fb[0]).toBe(0);
    expect(fb[1]).toBe(1);
    expect(fb[W * H - 1]).toBe(1);
    p.onTransaction(cmd([0xa6]));
    fb = pixelsOf(snaps.at(-1)!).buffer;
    expect(fb[0]).toBe(1);
    expect(fb[1]).toBe(0);
  });

  it('forces all pixels on with 0xA5 and follows RAM again with 0xA4', () => {
    const snaps: RenderSnapshot[] = [];
    const p = ssd1306Factory.create(makeCtx(snaps), { instanceId: 'oled1', address: ADDR });
    p.onTransaction(cmd([0xaf, 0xa1, 0xc8, 0xb0]));
    p.onTransaction(dat([0x00]));
    p.onTransaction(cmd([0xa5]));
    expect(pixelsOf(snaps.at(-1)!).buffer.every((v) => v === 1)).toBe(true);
    p.onTransaction(cmd([0xa4]));
    expect(pixelsOf(snaps.at(-1)!).buffer.every((v) => v === 0)).toBe(true);
  });

  it('shifts content up by the display start line register', () => {
    const snaps: RenderSnapshot[] = [];
    const p = ssd1306Factory.create(makeCtx(snaps), { instanceId: 'oled1', address: ADDR });
    p.onTransaction(cmd([0xaf, 0xa1, 0xc8, 0xb0]));
    p.onTransaction(dat([0x20])); // bit 5 -> RAM row 5
    p.onTransaction(cmd([0x40 | 5])); // start line 5: RAM row 5 shows at glass row 0
    const fb = pixelsOf(snaps.at(-1)!).buffer;
    expect(fb[0]).toBe(1);
    expect(fb[5]).toBe(0);
  });

  it('supports Co=1 single-byte control frames', () => {
    const snaps: RenderSnapshot[] = [];
    const p = ssd1306Factory.create(makeCtx(snaps), { instanceId: 'oled1', address: ADDR });
    p.onTransaction(cmd([0xa1, 0xc8, 0xb0]));
    p.onTransaction(i2cWrite([0x80, 0xaf])); // Co=1, D/C=0: one command byte
    p.onTransaction(i2cWrite([0xc0, 0x01])); // Co=1, D/C=1: one data byte
    expect(pixelsOf(snaps.at(-1)!).buffer[0]).toBe(1);
  });

  it('continues a data stream when a chunk arrives without a control byte', () => {
    const snaps: RenderSnapshot[] = [];
    const p = ssd1306Factory.create(makeCtx(snaps), { instanceId: 'oled1', address: ADDR });
    p.onTransaction(cmd([0xaf, 0xa1, 0xc8, 0x20, 0x00]));
    p.onTransaction(dat([0x01, 0x02]));     // columns 0 and 1
    p.onTransaction(i2cWrite([0x03, 0x04])); // QEMU-split chunk: no control byte
    const fb = pixelsOf(snaps.at(-1)!).buffer;
    expect(fb[1 * W + 2]).toBe(1); // 0x03 bit 1 -> row 1, column 2
    expect(fb[2 * W + 3]).toBe(1); // 0x04 bit 2 -> row 2, column 3
  });

  it('ignores traffic for other addresses and read transactions', () => {
    const snaps: RenderSnapshot[] = [];
    const p = ssd1306Factory.create(makeCtx(snaps), { instanceId: 'oled1', address: ADDR });
    p.onTransaction(i2cWrite([0x40, 0xff], 0x3d));
    p.onTransaction({ kind: 'i2c', bus: 0, target: ADDR, dir: 'read', data: new Uint8Array(0), length: 1, ts: 1 });
    expect(snaps).toHaveLength(0);
  });
});
