// PRD: §6.2, §F-PER-3 — SSD1306 OLED (128x64, I2C default 0x3C).
// Minimal command interpreter: enough to render framebuffer frames from typical gfx libs.
// Full SSD1306 command set is a TODO; MVP covers the common draw path (PRD §8).
import type {
  Peripheral, PeripheralContext, PeripheralFactory, BusTransaction, RenderSnapshot,
} from './types';

const WIDTH = 128;
const HEIGHT = 64;
const DEFAULT_ADDR = 0x3c;

// SSD1306 control bytes / coiling follows the standard I2C framing used by Adafruit_GFX.
enum Co { CTRL_CMD = 0x00, CTRL_DATA = 0x40 }

class Ssd1306 implements Peripheral {
  readonly kind = 'ssd1306';
  readonly instanceId: string;
  private ctx: PeripheralContext;
  private addr: number;
  private fb = new Uint8Array(WIDTH * HEIGHT); // 0/1 per pixel, column-major page order
  private segRemap = false;
  private scanRev = false;
  private colStart = 0;
  private pageStart = 0;
  private buf: number[] = [];
  private mode: 'cmd' | 'data' = 'cmd';

  constructor(instanceId: string, ctx: PeripheralContext, addr: number) {
    this.instanceId = instanceId;
    this.ctx = ctx;
    this.addr = addr;
  }

  onTransaction(tx: BusTransaction): void {
    if (tx.kind !== 'i2c' || tx.dir !== 'write') return;
    if (tx.target !== this.addr) return;
    // Each I2C write frame: [ctrl, b0, b1, ...]; ctrl selects cmd/data stream.
    let i = 0;
    while (i < tx.data.length) {
      const ctrl = tx.data[i++];
      this.mode = ctrl === Co.CTRL_DATA ? 'data' : 'cmd';
      const end = this.findNextCtrl(tx.data, i);
      const chunk = tx.data.slice(i, end);
      if (this.mode === 'cmd') this.applyCmd(chunk);
      else this.applyData(chunk);
      i = end;
    }
    this.flush();
  }

  private findNextCtrl(data: Uint8Array, from: number): number {
    for (let j = from; j < data.length; j++) {
      if (data[j] === Co.CTRL_CMD || data[j] === Co.CTRL_DATA) return j;
    }
    return data.length;
  }

  private applyCmd(chunk: Uint8Array): void {
    for (const b of chunk) {
      if ((b & 0xf0) === 0x20) continue;            // set addressing mode (ignored, page mode assumed)
      else if ((b & 0xc0) === 0x00) this.buf.push(b & 0x3f); // low col
      else if ((b & 0xf0) === 0x10) this.buf.push(b & 0x0f); // high col
      else if (b === 0xa0) this.segRemap = false;
      else if (b === 0xa1) this.segRemap = true;
      else if (b === 0xc0) this.scanRev = false;
      else if (b === 0xc8) this.scanRev = true;
      else if ((b & 0xf0) === 0x20 && b !== 0x20) continue;
      else if (b >= 0xb0 && b <= 0xb7) this.pageStart = b & 0x07;  // page start
      else if ((b & 0xf0) === 0x00 && (b & 0x0f) <= 0x0f) this.colStart = b & 0x0f;
      else if (b === 0xaf || b === 0xae) { /* display on/off */ }
    }
  }

  private applyData(chunk: Uint8Array): void {
    for (const byte of chunk) {
      const page = this.pageStart;
      for (let bit = 0; bit < 8; bit++) {
        const x = this.segRemap ? (WIDTH - 1 - this.colStart) : this.colStart;
        const y = this.scanRev ? (page * 8 + (7 - bit)) : (page * 8 + bit);
        if (x < WIDTH && y < HEIGHT) this.fb[y * WIDTH + x] = (byte >> bit) & 1;
      }
      this.colStart = (this.colStart + 1) % WIDTH;
    }
  }

  private flush(): void {
    const snap: RenderSnapshot = {
      instanceId: this.instanceId,
      type: 'pixels',
      payload: { width: WIDTH, height: HEIGHT, format: 'mono', buffer: Array.from(this.fb) },
    };
    this.ctx.emitSnapshot(snap);
  }

  dispose(): void { /* no native resources */ }
}

export const ssd1306Factory: PeripheralFactory = {
  kind: 'ssd1306',
  version: '0.1.0',
  displayName: 'SSD1306 OLED 128x64',
  pins: [
    { id: 'SDA', role: 'i2c-sda' },
    { id: 'SCL', role: 'i2c-scl' },
    { id: 'VCC', role: 'power', optional: true },
    { id: 'GND', role: 'gnd', optional: true },
  ],
  create(ctx, props): Peripheral {
    const instanceId = String(props?.instanceId ?? crypto.randomUUID());
    const addr = Number(props?.address ?? DEFAULT_ADDR);
    return new Ssd1306(instanceId, ctx, addr);
  },
};
