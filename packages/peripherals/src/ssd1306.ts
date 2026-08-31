// PRD: §6.2, §F-PER-3 — SSD1306 OLED (128x64, I2C default 0x3C).
// Command interpreter covering the Adafruit_GFX common draw path (dev-plan P1.6):
//
// - I2C framing per datasheet: the first byte of every write transaction is the
//   control byte (Co / D-C# bits); there is no mid-stream control-byte scanning,
//   so data bytes 0x00/0x40 are payload, never framing.
// - Multi-byte commands consume their parameters atomically (0x21/0x22 windows,
//   contrast, charge pump, COM pins, scroll, ...), so parameter bytes are never
//   misparsed as opcodes.
// - Addressing modes: page (power-on default), horizontal (Adafruit display()),
//   and vertical. Column/page pointers advance per datasheet and survive
//   arbitrary transaction chunk boundaries.
// - Orientation is applied at render time: segment remap, COM scan direction,
//   display start line, invert, all-pixels-on, display on/off. Module wiring
//   makes (segRemap=1, scanRev=1) — the Adafruit init defaults — an identity
//   transform, so GFX coordinates land upright on the glass.
import type {
  Peripheral, PeripheralContext, PeripheralFactory, BusTransaction, RenderSnapshot,
} from './types';

const WIDTH = 128;
const HEIGHT = 64;
const PAGES = HEIGHT / 8; // 8 pages of 8 rows
const DEFAULT_ADDR = 0x3c;

/** Commands whose parameter bytes must be consumed after the opcode. */
const CMD_ARG_COUNT: Record<number, number> = {
  0x20: 1, // memory addressing mode
  0x21: 2, // column address (horizontal/vertical mode window)
  0x22: 2, // page address (horizontal/vertical mode window)
  0x26: 6, 0x27: 6, // right/left horizontal scroll (not rendered)
  0x29: 5, 0x2a: 5, // vertical + right/left horizontal scroll (not rendered)
  0x81: 1, // contrast (no effect on mono output)
  0xa2: 2, // fade / blinking (not rendered)
  0xa8: 1, // multiplex ratio
  0x8d: 1, // charge pump
  0xd3: 1, // display offset
  0xd5: 1, // clock divide
  0xd9: 1, // precharge period
  0xda: 1, // COM pins hardware config
  0xdb: 1, // VCOMH deselect level
};

type AddressingMode = 'page' | 'horizontal' | 'vertical';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

class Ssd1306 implements Peripheral {
  readonly kind = 'ssd1306';
  readonly instanceId: string;
  private ctx: PeripheralContext;
  private addr: number;

  /** Display RAM: 8 pages x 128 columns, page-major; bit n of a byte = row page*8+n. */
  private ram = new Uint8Array(WIDTH * PAGES);

  // Addressing state (persists across transactions so chunked writes survive).
  private mode: AddressingMode = 'page';
  private colPtr = 0;
  private pagePtr = 0;
  private colLow = 0;  // page-mode lower-column nibble
  private colHigh = 0; // page-mode higher-column nibble
  private winColStart = 0;
  private winColEnd = WIDTH - 1;
  private winPageStart = 0;
  private winPageEnd = PAGES - 1;

  // Render-affecting state.
  private segRemap = false;
  private scanRev = false;
  private startLine = 0;
  private invert = false;
  private allOn = false;
  private displayOn = false;

  // Command-stream parser (parameters may span transactions).
  private pendingCmd: number | null = null;
  private pendingArgs: number[] = [];

  // QEMU may split one logical I2C write into several transactions; a chunk that
  // does not start with a canonical control byte continues the previous data stream.
  private lastStream: 'cmd' | 'data' | null = null;

  constructor(instanceId: string, ctx: PeripheralContext, addr: number) {
    this.instanceId = instanceId;
    this.ctx = ctx;
    this.addr = addr;
  }

  onTransaction(tx: BusTransaction): void {
    if (tx.kind !== 'i2c' || tx.dir !== 'write') return;
    if (tx.target !== this.addr) return;
    const data = tx.data;

    // Canonical control bytes use only bits 7 (Co) and 6 (D/C#): 0x00/0x40/0x80/0xC0.
    if (data.length > 0 && (data[0] & 0x3f) !== 0 && this.lastStream === 'data') {
      for (let i = 0; i < data.length; i++) this.writeData(data[i]);
      this.flush();
      return;
    }

    // Each write frame: [ctrl, b0, b1, ...]. Co=0: the rest of the transaction is
    // one stream. Co=1: exactly one byte follows, then a new control byte.
    let i = 0;
    while (i < data.length) {
      const ctrl = data[i++];
      const co = (ctrl & 0x80) !== 0;
      const isData = (ctrl & 0x40) !== 0;
      this.lastStream = isData ? 'data' : 'cmd';
      if (co) {
        if (i < data.length) {
          const b = data[i++];
          if (isData) this.writeData(b);
          else this.writeCmd(b);
        }
      } else {
        while (i < data.length) {
          const b = data[i++];
          if (isData) this.writeData(b);
          else this.writeCmd(b);
        }
      }
    }
    this.flush();
  }

  // --- Command stream ----------------------------------------------------------------------

  private writeCmd(b: number): void {
    if (this.pendingCmd !== null) {
      this.pendingArgs.push(b);
      if (this.pendingArgs.length >= (CMD_ARG_COUNT[this.pendingCmd] ?? 0)) {
        const cmd = this.pendingCmd;
        const args = this.pendingArgs;
        this.pendingCmd = null;
        this.pendingArgs = [];
        this.execMultiByteCmd(cmd, args);
      }
      return;
    }
    if (b <= 0x0f) { // set lower column start address (page mode)
      this.colLow = b;
      this.syncPageCol();
    } else if (b >= 0x10 && b <= 0x1f) { // set higher column start address (page mode)
      this.colHigh = b & 0x0f;
      this.syncPageCol();
    } else if (b >= 0x20 && b <= 0x2f) {
      // TODO(PRD §F-PER-3): 0x2e/0x2f scroll stop/start — hardware auto-scroll is
      // not modeled; the static RAM view is rendered instead.
      if (b !== 0x2e && b !== 0x2f) {
        this.pendingCmd = b;
        this.pendingArgs = [];
      }
    } else if (b >= 0x40 && b <= 0x7f) { // set display start line
      this.startLine = b & 0x3f;
    } else if (b === 0xa0) {
      this.segRemap = false;
    } else if (b === 0xa1) {
      this.segRemap = true;
    } else if (b === 0xa4) { // entire display follows RAM
      this.allOn = false;
    } else if (b === 0xa5) { // entire display ON regardless of RAM
      this.allOn = true;
    } else if (b === 0xa6) {
      this.invert = false;
    } else if (b === 0xa7) {
      this.invert = true;
    } else if (b === 0xae) {
      this.displayOn = false;
    } else if (b === 0xaf) {
      this.displayOn = true;
    } else if (b === 0xc0) {
      this.scanRev = false;
    } else if (b === 0xc8) {
      this.scanRev = true;
    } else if (b >= 0xb0 && b <= 0xb7) { // set page start (page mode only)
      if (this.mode === 'page') this.pagePtr = b & 0x07;
    } else if (b === 0xe3) { // NOP
      // nothing
    } else if (CMD_ARG_COUNT[b] !== undefined) {
      this.pendingCmd = b;
      this.pendingArgs = [];
    }
    // Unknown opcodes are ignored for robustness.
  }

  private execMultiByteCmd(cmd: number, args: number[]): void {
    switch (cmd) {
      case 0x20: { // memory addressing mode
        // 0=horizontal, 1=vertical, 2=page (datasheet); invalid values fall back to page.
        const next: AddressingMode = args[0] === 0 ? 'horizontal' : args[0] === 1 ? 'vertical' : 'page';
        this.mode = next;
        // Entering h/v mode restarts from the current window start.
        this.colPtr = next === 'page' ? 0 : this.winColStart;
        this.pagePtr = next === 'page' ? 0 : this.winPageStart;
        return;
      }
      case 0x21: { // column address window (horizontal/vertical mode only)
        this.winColStart = clamp(args[0], 0, WIDTH - 1);
        this.winColEnd = clamp(args[1], 0, WIDTH - 1);
        if (this.mode !== 'page') this.colPtr = this.winColStart;
        return;
      }
      case 0x22: { // page address window (horizontal/vertical mode only)
        this.winPageStart = clamp(args[0], 0, PAGES - 1);
        this.winPageEnd = clamp(args[1], 0, PAGES - 1);
        if (this.mode !== 'page') this.pagePtr = this.winPageStart;
        return;
      }
      default:
        return; // contrast / mux / charge pump / COM pins / ... no mono-render effect
    }
  }

  private syncPageCol(): void {
    if (this.mode === 'page') this.colPtr = (this.colHigh << 4) | this.colLow;
  }

  // --- Data stream --------------------------------------------------------------------------

  private writeData(b: number): void {
    this.ram[this.pagePtr * WIDTH + this.colPtr] = b;
    switch (this.mode) {
      case 'page':
        // Column wraps within 128; the page pointer is unchanged.
        this.colPtr = (this.colPtr + 1) % WIDTH;
        return;
      case 'horizontal':
        if (this.colPtr >= this.winColEnd) {
          this.colPtr = this.winColStart;
          this.pagePtr = this.pagePtr >= this.winPageEnd ? this.winPageStart : this.pagePtr + 1;
        } else {
          this.colPtr++;
        }
        return;
      case 'vertical':
        if (this.pagePtr >= this.winPageEnd) {
          this.pagePtr = this.winPageStart;
          this.colPtr = this.colPtr >= this.winColEnd ? this.winColStart : this.colPtr + 1;
        } else {
          this.pagePtr++;
        }
        return;
    }
  }

  // --- Render --------------------------------------------------------------------------------

  private flush(): void {
    const snap: RenderSnapshot = {
      instanceId: this.instanceId,
      type: 'pixels',
      payload: { width: WIDTH, height: HEIGHT, format: 'mono', buffer: this.render() },
    };
    this.ctx.emitSnapshot(snap);
  }

  /** RAM -> glass: start line shift, COM scan direction, segment remap, then invert/all-on. */
  private render(): number[] {
    const fb = new Uint8Array(WIDTH * HEIGHT);
    if (!this.displayOn) return Array.from(fb);
    if (this.allOn) {
      fb.fill(1);
    } else {
      for (let page = 0; page < PAGES; page++) {
        for (let col = 0; col < WIDTH; col++) {
          const byte = this.ram[page * WIDTH + col];
          if (byte === 0) continue;
          for (let bit = 0; bit < 8; bit++) {
            if (((byte >> bit) & 1) === 0) continue;
            const row = page * 8 + bit;
            // Start line: RAM row r shows at glass row (r - startLine) mod 64.
            let y = (row - this.startLine + HEIGHT) % HEIGHT;
            if (!this.scanRev) y = HEIGHT - 1 - y;
            const x = this.segRemap ? col : WIDTH - 1 - col;
            fb[y * WIDTH + x] = 1;
          }
        }
      }
    }
    if (this.invert) for (let i = 0; i < fb.length; i++) fb[i] ^= 1;
    return Array.from(fb);
  }

  dispose(): void { /* no native resources */ }
}

export const ssd1306Factory: PeripheralFactory = {
  kind: 'ssd1306',
  version: '0.2.0',
  displayName: 'SSD1306 OLED 128x64',
  pins: [
    { id: 'SDA', role: 'i2c-sda' },
    { id: 'SCL', role: 'i2c-scl' },
    { id: 'VCC', role: 'power', optional: true },
    { id: 'GND', role: 'gnd', optional: true },
  ],
  defaults: { address: DEFAULT_ADDR },
  create(ctx, props): Peripheral {
    const instanceId = String(props?.instanceId ?? crypto.randomUUID());
    const addr = Number(props?.address ?? DEFAULT_ADDR);
    return new Ssd1306(instanceId, ctx, addr);
  },
};
