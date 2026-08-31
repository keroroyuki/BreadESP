// PRD: §9 — Golden firmware builder: packages/sim-core/fixtures/spi.elf (dev-plan task P2.1).
// Deterministically assembles a tiny Xtensa LX6 program for the ESP32 that drives
// the SPI forward channel of the breadesp-dbus device into an ST7789 TFT:
//
//   1. GPIO2 (the DC line): toggled via OUT_W1TS / OUT_W1TC between command and
//      data phases (level transactions sampled by the st7789 model).
//   2. HSPI (SPI2, 0x3ff64000): USER=1<<27 (MOSI-only), USER2=0 — the model's
//      reset state has COMMAND_BITLEN=4, which would prepend a stray 0x00
//      command byte to every USR transaction if left alone. Each frame then
//      fills W0..Wn (little-endian byte packing: W0's LSB clocks out first),
//      sets MOSI_DLEN = bytes*8-1 and writes CMD=1<<18. The controller model
//      completes the transfer synchronously inside the MMIO write, CS0 frames
//      it (SPI_PIN reset value 0x6 masks CS1/CS2), and the breadesp-dbus
//      sniffer emits one `spi` write transaction per CS assertion.
//   3. TFT_eSPI-style init + 4 pixels (red, green, blue, white), then prints
//      "SPI OK\r\n" to UART0 so e2e tests can gate on it, then hangs.
//
// Usage: node scripts/make-spi-elf.mjs [--check]
//   default: (re)write the fixture. --check: verify the committed fixture is up to date.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Program, buildElf, elfSanity } from './lib/xtensa-elf.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const FIXTURE = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'spi.elf');
const log = (msg) => console.log(`[make-spi-elf] ${msg}`);

// --- ESP32 memory-mapped registers used by the firmware (per ESP-IDF soc headers) ---
const IRAM_BASE = 0x40080000; // ESP32 IRAM; the single PT_LOAD segment is mapped here
const UART0_FIFO = 0x3ff40000; // UART0 + UART_FIFO_REG (offset 0x0): byte writes transmit
const GPIO_OUT_W1TS = 0x3ff44008; // GPIO_OUT_W1TS_REG: atomically set output bits
const GPIO_OUT_W1TC = 0x3ff4400c; // GPIO_OUT_W1TC_REG: atomically clear output bits
const GPIO_EN_W1TS = 0x3ff44024; // GPIO_ENABLE_W1TS_REG: atomically enable output driver
const GPIO2_MASK = 1 << 2; // DC line of the ST7789 acceptance scenario
const SPI2 = 0x3ff64000; // DR_REG_SPI2_BASE: HSPI, the general-purpose controller

// --- esp32.spi register offsets (hw/ssi/esp32_spi.h) ---
const SPI_CMD = 0x00; // write with bit18 (USR) fires a user transaction
const SPI_USER = 0x1c; // MOSI bit27 = data phase from W0.., no command/addr/miso
const SPI_USER2 = 0x24; // must be 0: reset COMMAND_BITLEN=4 would prepend 0x00
const SPI_MOSI_DLEN = 0x28; // tx bit count - 1
const SPI_W0 = 0x80; // data FIFO words, W0's LSB clocks out first

const SPI_CMD_USR = 1 << 18;
const SPI_USER_MOSI_ONLY = 1 << 27;

const MSG = Buffer.from('SPI OK\r\n', 'ascii');

// ST7789 frames (TFT_eSPI-style init + a small RGB565 pixel stream on CS0).
const DC_LOW = 0;
const DC_HIGH = 1;
const FRAMES = [
  { dc: DC_LOW, bytes: [0x01], what: 'SWRESET' },
  { dc: DC_LOW, bytes: [0x11], what: 'SLPOUT' },
  { dc: DC_LOW, bytes: [0x3a], what: 'COLMOD' },
  { dc: DC_HIGH, bytes: [0x55], what: 'COLMOD 16bpp' },
  { dc: DC_LOW, bytes: [0x2a], what: 'CASET' },
  { dc: DC_HIGH, bytes: [0x00, 0x00, 0x00, 0xef], what: 'CASET 0..239' },
  { dc: DC_LOW, bytes: [0x2b], what: 'RASET' },
  { dc: DC_HIGH, bytes: [0x00, 0x00, 0x00, 0xef], what: 'RASET 0..239' },
  { dc: DC_LOW, bytes: [0x29], what: 'DISPON' },
  { dc: DC_LOW, bytes: [0x2c], what: 'RAMWR' },
  // 4 pixels: red, green, blue, white (high byte first, like TFT_eSPI pushPixels).
  { dc: DC_HIGH, bytes: [0xf8, 0x00, 0x07, 0xe0, 0x00, 0x1f, 0xff, 0xff], what: 'pixels' },
];

// --- Firmware program ----------------------------------------------------------------------
const prog = new Program(IRAM_BASE);
const L = {
  uart: prog.literal('L_uart', UART0_FIFO),
  enW1ts: prog.literal('L_en_w1ts', GPIO_EN_W1TS),
  outW1ts: prog.literal('L_out_w1ts', GPIO_OUT_W1TS),
  outW1tc: prog.literal('L_out_w1tc', GPIO_OUT_W1TC),
  spi: prog.literal('L_spi', SPI2),
  userReg: prog.literal('L_user', SPI_USER_MOSI_ONLY),
  zero: prog.literal('L_zero', 0),
  cmdUsr: prog.literal('L_cmd_usr', SPI_CMD_USR),
  msg: prog.literal('L_msg', (A) => A('S_msg')),
};
prog.string('S_msg', MSG);

// Deduplicating literal helper for per-frame W-register words.
const litCache = new Map();
const lit = (value) => {
  if (!litCache.has(value)) {
    const name = `L_w${litCache.size}`;
    litCache.set(value, name);
    prog.literal(name, value);
  }
  return litCache.get(value);
};

// `print <literal string>`: a10 = cursor, a11 = remaining, a12 = char, a8 = UART0.
const printBlock = (litName, target) => {
  prog.insn('l32r', `l32r  a10, ${litName.padEnd(14)}; a10 = message`, { at_: 10, lit: litName });
  prog.insn('movi', 'movi  a11, 8          ; remaining chars', { at_: 11, imm: MSG.length });
  prog.label(target);
  prog.insn('l8ui', 'l8ui  a12, a10, 0     ; load char', { at_: 12, as_: 10, off: 0 });
  prog.insn('s8i', 's8i   a12, a8, 0       ; UART0 TX', { at_: 12, as_: 8, off: 0 });
  prog.insn('addi', 'addi  a10, a10, 1     ; advance cursor', { at_: 10, as_: 10, imm: 1 });
  prog.insn('addi', 'addi  a11, a11, -1    ; countdown', { at_: 11, as_: 11, imm: -1 });
  prog.insn('bnez', `bnez  a11, ${target}`, { as_: 11, target });
};

// `dc <level>`: drive the DC GPIO (a13 = W1TS/W1TC address, a14 = mask).
const dcBlock = (level, what) => {
  const litName = level ? L.outW1ts : L.outW1tc;
  prog.insn('l32r', `l32r  a13, ${litName.padEnd(13)}; DC ${level} (${what})`, { at_: 13, lit: litName });
  prog.insn('movi', 'movi  a14, 4           ; GPIO2 mask', { at_: 14, imm: GPIO2_MASK });
  prog.insn('s32i', 's32i  a14, a13, 0      ; DC level', { at_: 14, as_: 13, off: 0 });
};

// `spiSend <bytes>`: W0..Wn <- little-endian words (a9 = SPI2 base, a10 = value).
const spiSend = (bytes, what) => {
  for (let w = 0; w * 4 < bytes.length; w++) {
    const b = bytes.slice(w * 4, w * 4 + 4);
    while (b.length < 4) b.push(0);
    const word = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    prog.insn('l32r', `l32r  a10, ${lit(word).padEnd(14)}; W${w} (${what})`, { at_: 10, lit: lit(word) });
    prog.insn('s32i', `s32i  a10, a9, ${hex(0x80 + w * 4).padEnd(4)}; SPI_W${w}`, { at_: 10, as_: 9, off: 0x80 + w * 4 });
  }
  prog.insn('movi', `movi  a10, ${hex(bytes.length * 8 - 1).padEnd(4)}   ; MOSI_DLEN ${bytes.length}B`, { at_: 10, imm: bytes.length * 8 - 1 });
  prog.insn('s32i', 's32i  a10, a9, 0x28    ; SPI_MOSI_DLEN', { at_: 10, as_: 9, off: SPI_MOSI_DLEN });
  prog.insn('l32r', 'l32r  a10, L_cmd_usr   ; USR bit', { at_: 10, lit: L.cmdUsr });
  prog.insn('s32i', 's32i  a10, a9, 0x00    ; SPI_CMD fires', { at_: 10, as_: 9, off: SPI_CMD });
};

const hex = (n) => `0x${n.toString(16)}`;

prog.label('_start');
prog.insn('l32r', 'l32r  a8, L_uart       ; a8 = UART0 FIFO', { at_: 8, lit: L.uart });
prog.insn('movi', 'movi  a9, 4            ; GPIO2 mask', { at_: 9, imm: GPIO2_MASK });
prog.insn('l32r', 'l32r  a10, L_en_w1ts   ; GPIO_ENABLE_W1TS', { at_: 10, lit: L.enW1ts });
prog.insn('s32i', 's32i  a9, a10, 0       ; GPIO2 -> output driver on', { at_: 9, as_: 10, off: 0 });
prog.insn('l32r', 'l32r  a9, L_spi        ; a9 = SPI2 (HSPI) base', { at_: 9, lit: L.spi });
prog.insn('l32r', 'l32r  a10, L_user      ; USER: MOSI phase only', { at_: 10, lit: L.userReg });
prog.insn('s32i', 's32i  a10, a9, 0x1c    ; SPI_USER', { at_: 10, as_: 9, off: SPI_USER });
prog.insn('l32r', 'l32r  a10, L_zero      ; clear COMMAND_BITLEN', { at_: 10, lit: L.zero });
prog.insn('s32i', 's32i  a10, a9, 0x24    ; SPI_USER2 = 0', { at_: 10, as_: 9, off: SPI_USER2 });

prog.label('app_main');
printBlock('L_msg', 'next_char');

for (const { dc, bytes, what } of FRAMES) {
  dcBlock(dc, what);
  spiSend(bytes, what);
}

// The flush BH needs a main-loop iteration after the last MMIO write; hang here
// (no delay loop: virtual time does not matter for the acceptance).
prog.label('hang');
prog.insn('j', 'j     hang               ; wait for the flush BH', { target: 'hang' });

prog.assemble();

const entry = prog.symbols[0].value;
const elf = buildElf(IRAM_BASE, prog.image, entry, prog.symbols);
elfSanity(elf, entry);
const sha256 = createHash('sha256').update(elf).digest('hex');

const report = () => {
  log(`image ${prog.image.length} bytes, ELF ${elf.length} bytes, sha256 ${sha256}`);
  for (const s of prog.symbols) log(`symbol ${s.name} = 0x${s.value.toString(16)} (size ${s.size})`);
  log('disassembly:');
  for (const line of prog.listing) console.log(line);
};

const checkMode = process.argv.includes('--check');
if (checkMode) {
  let existing;
  try {
    existing = await readFile(FIXTURE);
  } catch {
    console.error(`[make-spi-elf] fixture missing: ${relative(REPO_ROOT, FIXTURE)}. Run without --check to create it.`);
    process.exit(1);
  }
  if (!existing.equals(elf)) {
    console.error(`[make-spi-elf] fixture is stale: ${relative(REPO_ROOT, FIXTURE)} differs from regenerated output.`);
    process.exit(1);
  }
  log(`fixture up to date (${elf.length} bytes, sha256 ${sha256})`);
} else {
  await mkdir(dirname(FIXTURE), { recursive: true });
  await writeFile(FIXTURE, elf);
  log(`wrote ${relative(REPO_ROOT, FIXTURE)}`);
  report();
}
