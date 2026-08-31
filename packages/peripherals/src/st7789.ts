// PRD: §6.2, §F-PER-4 — ST7789 TFT 240x240 (SPI, dev-plan task P2.1).
//
// Command interpreter + RGB565 framebuffer covering the Adafruit_GFX /
// TFT_eSPI common draw path:
//
// - Command/data split: the DC line (a plain GPIO) selects the stream type
//   per SPI transaction. The QEMU SPI controller clocks a whole CS frame
//   atomically, so the DC level sampled at frame time applies to the entire
//   frame: DC=0 -> every byte is a command opcode, DC=1 -> every byte is
//   data (command parameters or the RAMWR pixel stream).
// - Multi-byte commands consume their parameters from following DC=1 frames
//   (CASET/RASET windows, MADCTL, COLMOD, gamma/power blocks, ...). A DC=0
//   byte always re-arms the parser, so the stream can never desync into
//   misreading pixel data as opcodes.
// - GRAM addressing: the CASET/RASET window and the address counter live in
//   the *address* space (the counter always starts at the window start and
//   advances X-fast, wrapping inside the window); MADCTL is the per-pixel
//   transform from address to glass coordinates — MV swaps the axes first,
//   then MX/MY mirror the glass column/row. This matches the datasheet's
//   memory-write scan figures for full windows *and* the rotated partial
//   windows real drivers (TFT_eSPI / Adafruit_ST7789 setRotation) rely on.
// - Render-affecting state: DISPON/DISPOFF, SLPIN/SLPOUT (both blank the
//   glass), INVON/INVOFF (bitwise NOT of RGB565) and MADCTL RGB/BGR order.
//   ML/MH (panel scan order) have no GRAM effect and are not modeled.
//
// Not modeled (documented gaps): gamma curves, partial/scroll areas, idle
// mode, the RST line (SWRESET 0x01 covers the software reset path), MISO
// reads (reverse channel is a PRD §6.3 TODO shared with I2C).
import type {
  Peripheral, PeripheralContext, PeripheralFactory, BusTransaction, RenderSnapshot,
} from './types';

const WIDTH = 240;
const HEIGHT = 240;
const DEFAULT_CS = 0;

/**
 * Commands whose parameters arrive as DC=1 data. The ST7789V common init
 * blocks (TFT_eSPI / Adafruit_ST7789) use exactly these counts; an off
 * count is harmless — surplus bytes are ignored as stray data and a deficit
 * is cleared by the next DC=0 command.
 */
const CMD_PARAM_COUNT: Record<number, number> = {
  0x26: 1,  // GAMSET (gamma set)
  0x2a: 4,  // CASET (column address window)
  0x2b: 4,  // RASET (row address window)
  0x30: 4,  // PTLAR (partial area, not rendered)
  0x33: 6,  // SCRLAR (scroll area, not rendered)
  0x35: 1,  // TEON (tearing effect line on)
  0x36: 1,  // MADCTL (memory data access control)
  0x37: 1,  // VSCSAD (vertical scroll start, not rendered)
  0x3a: 1,  // COLMOD (interface pixel format)
  0xb1: 2,  // FRCTRL1 (frame rate, partial/idle)
  0xb2: 5,  // FRCTRL2 / PORCTRL (porch control)
  0xb3: 2,  // FRCTRL3 (frame rate, partial/idle)
  0xb4: 1,  // INVCTRL (inversion control)
  0xb6: 2,  // DISCTRL (display function control)
  0xb7: 1,  // ETCTRL (gate control)
  0xbb: 1,  // PWCTRL1 (VCOMS)
  0xc0: 1,  // LCMCTRL
  0xc1: 1,  // VDVVRHEN
  0xc2: 1,  // VRHS
  0xc3: 1,  // VDVS
  0xc4: 1,  // VCOMDC? (vcom default; power block)
  0xc5: 1,  // VCOMDC / FRCTRL2 variant in common inits
  0xc6: 1,  // FRCTRL2 (frame rate in normal mode)
  0xd0: 2,  // PWCTRL1 (power control 1)
  0xe0: 14, // PVGAMCTRL (positive gamma)
  0xe1: 14, // NVGAMCTRL (negative gamma)
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

class St7789 implements Peripheral {
  readonly kind = 'st7789';
  readonly instanceId: string;
  private ctx: PeripheralContext;
  private cs: number;
  /** GPIO number the DC line is wired to (props.dc); undefined = untracked. */
  private dcPin: number | undefined;

  /** GRAM: 240x240 RGB565, row-major, absolute panel coordinates. */
  private gram = new Uint16Array(WIDTH * HEIGHT);

  // Addressing state (per datasheet, persists across transactions).
  private winXStart = 0;
  private winXEnd = WIDTH - 1;
  private winYStart = 0;
  private winYEnd = HEIGHT - 1;
  /** Address counter (absolute GRAM coordinates). */
  private ptrX = 0;
  private ptrY = 0;

  // MADCTL bits.
  private my = false;  // bit7: row order (bottom-up)
  private mx = false;  // bit6: column order (right-to-left)
  private mv = false;  // bit5: row/column exchange (fast axis = Y)
  private bgr = false; // bit3: color component order

  // Render-affecting state.
  private displayOn = false; // DISPOFF is the power-on default
  private sleep = true;      // SLPIN is the power-on default
  private inverted = false;

  // Command-stream parser.
  private pendingCmd: number | null = null;
  private pendingArgs: number[] = [];
  /** Set by RAMWR: DC=1 bytes are the pixel stream until the next command. */
  private inRamwr = false;
  /** Half-consumed pixel byte (RGB565 frames can split across transactions). */
  private pixelHigh: number | null = null;

  /** DC line level sampled from the routed GPIO transactions. */
  private dc: 0 | 1 = 0;
  private warnedNoDc = false;

  constructor(instanceId: string, ctx: PeripheralContext, cs: number, dcPin: number | undefined) {
    this.instanceId = instanceId;
    this.ctx = ctx;
    this.cs = cs;
    this.dcPin = dcPin;
    this.resetWindow();
  }

  onTransaction(tx: BusTransaction): void {
    if (tx.dir !== 'write') return;

    if (tx.kind === 'gpio') {
      // DC/RST/BL are plain MCU outputs wired to this instance; only the
      // configured DC pin selects the command/data stream.
      if (this.dcPin !== undefined && tx.target === this.dcPin && tx.data.length > 0) {
        this.dc = tx.data[0] ? 1 : 0;
      }
      return;
    }
    if (tx.kind !== 'spi') return;
    if (tx.target !== undefined && tx.target !== this.cs) return;
    if (this.dcPin === undefined && !this.warnedNoDc) {
      this.warnedNoDc = true;
      this.ctx.log('warn', 'st7789: props.dc is not set; SPI frames cannot be split into '
        + 'command/data (set the DC GPIO number on the instance)');
    }

    if (this.dc === 0) {
      for (const b of tx.data) this.writeCmd(b);
    } else {
      for (const b of tx.data) this.writeData(b);
    }
    this.flush();
  }

  // --- Command stream (DC=0) -------------------------------------------------

  private writeCmd(b: number): void {
    // A command byte always re-arms the parser: parameters never follow in
    // the same DC=0 frame, and stale pending state cannot eat pixel data.
    this.pendingCmd = null;
    this.pendingArgs = [];
    this.pixelHigh = null;
    // "The RAMWR stream continues until any other command is received."
    this.inRamwr = false;

    switch (b) {
      case 0x01: // SWRESET: register/GRAM state back to power-on
        this.resetState();
        return;
      case 0x10: // SLPIN
        this.sleep = true;
        return;
      case 0x11: // SLPOUT
        this.sleep = false;
        return;
      case 0x20: // INVOFF
        this.inverted = false;
        return;
      case 0x21: // INVON
        this.inverted = true;
        return;
      case 0x28: // DISPOFF
        this.displayOn = false;
        return;
      case 0x29: // DISPON
        this.displayOn = true;
        return;
      case 0x2c: // RAMWR: the data stream follows
      case 0x3c: // RAMWRC (continued write): keep the address counter
        if (b === 0x2c) this.resetWindow();
        this.inRamwr = true;
        return;
      default:
        if (CMD_PARAM_COUNT[b] !== undefined) {
          this.pendingCmd = b;
          this.pendingArgs = [];
        }
        // Parameterless commands (NOP, NORON, PTLON, IDMOFF/ON, ...) and
        // unknown opcodes are ignored for robustness.
        return;
    }
  }

  private execMultiByteCmd(cmd: number, args: number[]): void {
    switch (cmd) {
      case 0x2a: { // CASET
        const xs = clamp((args[0] << 8) | args[1], 0, WIDTH - 1);
        const xe = clamp((args[2] << 8) | args[3], 0, WIDTH - 1);
        this.winXStart = Math.min(xs, xe);
        this.winXEnd = Math.max(xs, xe);
        this.resetWindow();
        return;
      }
      case 0x2b: { // RASET
        const ys = clamp((args[0] << 8) | args[1], 0, HEIGHT - 1);
        const ye = clamp((args[2] << 8) | args[3], 0, HEIGHT - 1);
        this.winYStart = Math.min(ys, ye);
        this.winYEnd = Math.max(ys, ye);
        this.resetWindow();
        return;
      }
      case 0x36: { // MADCTL
        const m = args[0];
        this.my = (m & 0x80) !== 0;
        this.mx = (m & 0x40) !== 0;
        this.mv = (m & 0x20) !== 0;
        this.bgr = (m & 0x08) !== 0;
        return;
      }
      case 0x3a: // COLMOD: only the 16-bit/pixel format drives the parser;
        // other values are accepted but still decoded as RGB565 (warn once).
        if (args[0] !== 0x55) {
          this.ctx.log('warn', `st7789: COLMOD 0x${args[0].toString(16)} ignored, `
            + 'rendering assumes 16-bit RGB565');
        }
        return;
      default:
        return; // gamma/power/porch blocks have no render effect
    }
  }

  // --- Data stream (DC=1) ----------------------------------------------------

  private writeData(b: number): void {
    if (this.pendingCmd !== null) {
      this.pendingArgs.push(b);
      if (this.pendingArgs.length >= CMD_PARAM_COUNT[this.pendingCmd]) {
        const cmd = this.pendingCmd;
        const args = this.pendingArgs;
        this.pendingCmd = null;
        this.pendingArgs = [];
        this.execMultiByteCmd(cmd, args);
      }
      return;
    }
    if (!this.inRamwr) return; // stray data (no live command): ignored

    if (this.pixelHigh === null) {
      this.pixelHigh = b; // high byte first (D15..D8)
      return;
    }
    this.writePixel((this.pixelHigh << 8) | b);
    this.pixelHigh = null;
  }

  /** Write one RGB565 word at the address counter, then advance X-fast. */
  private writePixel(value: number): void {
    // MADCTL maps the address counter (window space, counts up, X fast)
    // onto glass coordinates: MV swaps the axes, then MX/MY mirror.
    let gx = this.ptrX;
    let gy = this.ptrY;
    if (this.mv) {
      const t = gx;
      gx = gy;
      gy = t;
    }
    if (this.mx) gx = WIDTH - 1 - gx;
    if (this.my) gy = HEIGHT - 1 - gy;
    this.gram[gy * WIDTH + gx] = value & 0xffff;

    this.ptrX++;
    if (this.ptrX > this.winXEnd) {
      this.ptrX = this.winXStart;
      this.ptrY++;
      if (this.ptrY > this.winYEnd) this.ptrY = this.winYStart;
    }
  }

  /** Point the address counter at the window start. */
  private resetWindow(): void {
    this.ptrX = this.winXStart;
    this.ptrY = this.winYStart;
  }

  private resetState(): void {
    this.gram.fill(0);
    this.winXStart = 0;
    this.winXEnd = WIDTH - 1;
    this.winYStart = 0;
    this.winYEnd = HEIGHT - 1;
    this.my = false;
    this.mx = false;
    this.mv = false;
    this.bgr = false;
    this.displayOn = false;
    this.sleep = true;
    this.inverted = false;
    this.pendingCmd = null;
    this.pendingArgs = [];
    this.inRamwr = false;
    this.pixelHigh = null;
    this.resetWindow();
  }

  // --- Render ------------------------------------------------------------------

  private flush(): void {
    const snap: RenderSnapshot = {
      instanceId: this.instanceId,
      type: 'pixels',
      payload: { width: WIDTH, height: HEIGHT, format: 'rgb565', buffer: this.render() },
    };
    this.ctx.emitSnapshot(snap);
  }

  /** GRAM -> glass: blank when off/asleep, else BGR swap + inversion. */
  private render(): number[] {
    const out = new Array<number>(WIDTH * HEIGHT);
    if (!this.displayOn || this.sleep) {
      out.fill(0);
      return out;
    }
    for (let i = 0; i < out.length; i++) {
      let v = this.gram[i];
      if (this.inverted) v = ~v & 0xffff;
      if (this.bgr) {
        // B5G6R5 -> R5G6B5
        v = ((v & 0xf800) >> 11) | (v & 0x07e0) | ((v & 0x001f) << 11);
      }
      out[i] = v;
    }
    return out;
  }

  dispose(): void { /* no native resources */ }
}

export const st7789Factory: PeripheralFactory = {
  kind: 'st7789',
  version: '0.1.0',
  displayName: 'ST7789 TFT 240x240',
  pins: [
    { id: 'SCK', role: 'spi-sck' },
    { id: 'MOSI', role: 'spi-mosi' },
    { id: 'MISO', role: 'spi-miso', optional: true },
    { id: 'CS', role: 'spi-cs' },
    { id: 'DC', role: 'gpio-in' },
    { id: 'RST', role: 'gpio-in', optional: true },
    { id: 'BL', role: 'gpio-in', optional: true },
    { id: 'VCC', role: 'power', optional: true },
    { id: 'GND', role: 'gnd', optional: true },
  ],
  defaults: { cs: DEFAULT_CS },
  create(ctx, props): Peripheral {
    const instanceId = String(props?.instanceId ?? crypto.randomUUID());
    const cs = Number(props?.cs ?? DEFAULT_CS);
    const dcRaw = props?.dc;
    const dcPin = dcRaw === undefined ? undefined : Number(dcRaw);
    return new St7789(instanceId, ctx, cs, dcPin);
  },
};
