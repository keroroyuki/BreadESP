// PRD: §9 — Golden firmware builder: packages/sim-core/fixtures/i2c.elf (dev-plan task P1.2).
// Deterministically assembles a tiny Xtensa LX6 program for the ESP32 that drives both
// forward channels of the breadesp-dbus device:
//
//   1. GPIO: toggles GPIO2 via OUT_W1TS / OUT_W1TC (two `gpio` transactions),
//   2. I2C:  programs the esp32.i2c0 controller (hw/i2c/esp32_i2c.c) to run one
//            write transfer to address 0x3C (SSD1306): FIFO <- [0x78, 0x00, 0xAE],
//            CMD0 = WRITE(3 bytes), CMD1 = STOP, CTR.TRANS_START fires it.
//            The model completes the transfer synchronously inside the MMIO write,
//            so no status polling is needed before proceeding.
//   3. prints "I2C OK\r\n" to UART0 so e2e tests can gate on it, then hangs.
//
// The esp32.i2c model semantics (address byte = addr<<1 | rw) follow the ESP32 TRM
// and hw/xtensa/esp32.c machine wiring (tmp105 @0x48 lives on the same bus; 0x3C is
// unclaimed, so the breadesp-dbus sniffer claims it — see breadesp_dbus.c).
//
// Usage: node scripts/make-i2c-elf.mjs [--check]
//   default: (re)write the fixture. --check: verify the committed fixture is up to date.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Program, buildElf, elfSanity } from './lib/xtensa-elf.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const FIXTURE = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'i2c.elf');
const log = (msg) => console.log(`[make-i2c-elf] ${msg}`);

// --- ESP32 memory-mapped registers used by the firmware (per ESP-IDF soc headers) ---
const IRAM_BASE = 0x40080000; // ESP32 IRAM; the single PT_LOAD segment is mapped here
const UART0_FIFO = 0x3ff40000; // UART0 + UART_FIFO_REG (offset 0x0): byte writes transmit
const GPIO_OUT_W1TS = 0x3ff44008; // GPIO_OUT_W1TS_REG: atomically set output bits
const GPIO_OUT_W1TC = 0x3ff4400c; // GPIO_OUT_W1TC_REG: atomically clear output bits
const GPIO_EN_W1TS = 0x3ff44024; // GPIO_ENABLE_W1TS_REG: atomically enable output driver
const GPIO2_MASK = 1 << 2; // LED pin of the blink acceptance scenario (PRD §1.4)
const I2C0 = 0x3ff53000; // DR_REG_I2C_EXT_BASE: esp32.i2c controller #0

// --- esp32.i2c register offsets (hw/i2c/esp32_i2c.h) ---
const I2C_CTR = 0x04; // TRANS_START(bit5) | MS_MODE(bit4)
const I2C_FIFO_DATA = 0x1c; // byte pushes into the TX FIFO
const I2C_CMD0 = 0x58; // command register 0
const I2C_CMD1 = 0x5c; // command register 1

// I2C_CMD fields: OPCODE bits 11..13, BYTE_NUM bits 0..7 (hw/i2c/esp32_i2c.h REG32/FIELD).
const OPCODE_WRITE = 1;
const OPCODE_STOP = 3;
const I2C_ADDR = 0x3c; // SSD1306 OLED (PRD §1.4 scenario), unclaimed on the QEMU bus
const I2C_PAYLOAD = [0x00, 0xae]; // register pointer + "display off" command, for flavor

const CMD_WRITE = (OPCODE_WRITE << 11) | (1 + I2C_PAYLOAD.length); // 1 addr byte + payload
const CMD_STOP = OPCODE_STOP << 11;
const CTR_TRANS_START = (1 << 5) | (1 << 4); // TRANS_START | MS_MODE (master mode)

const MSG = Buffer.from('I2C OK\r\n', 'ascii');

// --- Firmware program ----------------------------------------------------------------------
const prog = new Program(IRAM_BASE);
const L = {
  uart: prog.literal('L_uart', UART0_FIFO),
  enW1ts: prog.literal('L_en_w1ts', GPIO_EN_W1TS),
  outW1ts: prog.literal('L_out_w1ts', GPIO_OUT_W1TS),
  outW1tc: prog.literal('L_out_w1tc', GPIO_OUT_W1TC),
  i2c: prog.literal('L_i2c', I2C0),
  cmdWrite: prog.literal('L_cmd_write', CMD_WRITE),
  cmdStop: prog.literal('L_cmd_stop', CMD_STOP),
  msg: prog.literal('L_msg', (A) => A('S_msg')),
};
prog.string('S_msg', MSG);

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

prog.label('_start');
prog.insn('l32r', 'l32r  a8, L_uart       ; a8 = UART0 FIFO', { at_: 8, lit: L.uart });
prog.insn('movi', 'movi  a9, 4            ; GPIO2 mask', { at_: 9, imm: GPIO2_MASK });
prog.insn('l32r', 'l32r  a10, L_en_w1ts   ; GPIO_ENABLE_W1TS', { at_: 10, lit: L.enW1ts });
prog.insn('s32i', 's32i  a9, a10, 0       ; GPIO2 -> output driver on', { at_: 9, as_: 10, off: 0 });

prog.label('app_main');
printBlock('L_msg', 'next_char');

// --- GPIO transaction 1: LED on (pin 2, level 1) ---
prog.insn('l32r', 'l32r  a13, L_out_w1ts  ; LED on', { at_: 13, lit: L.outW1ts });
prog.insn('movi', 'movi  a14, 4           ; GPIO2 mask', { at_: 14, imm: GPIO2_MASK });
prog.insn('s32i', 's32i  a14, a13, 0      ; GPIO_OUT_W1TS |= GPIO2', { at_: 14, as_: 13, off: 0 });

// --- I2C write transaction to 0x3C ---
prog.insn('l32r', 'l32r  a9, L_i2c        ; a9 = I2C0 base', { at_: 9, lit: L.i2c });
prog.insn('movi', `movi  a10, 0x${(((I2C_ADDR << 1) | 0) & 0xff).toString(16).padStart(2, '0')}        ; addr byte (0x3C<<1|W)`, { at_: 10, imm: (I2C_ADDR << 1) | 0 });
prog.insn('s32i', 's32i  a10, a9, 0x1c    ; I2C_FIFO_DATA', { at_: 10, as_: 9, off: I2C_FIFO_DATA });
I2C_PAYLOAD.forEach((byte, i) => {
  prog.insn('movi', `movi  a10, 0x${byte.toString(16).padStart(2, '0')}        ; data byte ${i}`, { at_: 10, imm: byte });
  prog.insn('s32i', 's32i  a10, a9, 0x1c    ; I2C_FIFO_DATA', { at_: 10, as_: 9, off: I2C_FIFO_DATA });
});
prog.insn('l32r', 'l32r  a10, L_cmd_write ; WRITE cmd, 3 bytes', { at_: 10, lit: L.cmdWrite });
prog.insn('s32i', 's32i  a10, a9, 0x58    ; I2C_CMD[0]', { at_: 10, as_: 9, off: I2C_CMD0 });
prog.insn('l32r', 'l32r  a10, L_cmd_stop  ; STOP cmd', { at_: 10, lit: L.cmdStop });
prog.insn('s32i', 's32i  a10, a9, 0x5c    ; I2C_CMD[1]', { at_: 10, as_: 9, off: I2C_CMD1 });
prog.insn('movi', 'movi  a10, 0x30        ; TRANS_START | MS_MODE', { at_: 10, imm: CTR_TRANS_START });
prog.insn('s32i', 's32i  a10, a9, 0x04    ; I2C_CTR: fires the transfer', { at_: 10, as_: 9, off: I2C_CTR });

// --- GPIO transaction 2: LED off (pin 2, level 0) ---
prog.insn('l32r', 'l32r  a13, L_out_w1tc  ; LED off', { at_: 13, lit: L.outW1tc });
prog.insn('movi', 'movi  a14, 4           ; GPIO2 mask', { at_: 14, imm: GPIO2_MASK });
prog.insn('s32i', 's32i  a14, a13, 0      ; GPIO_OUT_W1TC |= GPIO2', { at_: 14, as_: 13, off: 0 });

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
    console.error(`[make-i2c-elf] fixture missing: ${relative(REPO_ROOT, FIXTURE)}. Run without --check to create it.`);
    process.exit(1);
  }
  if (!existing.equals(elf)) {
    console.error(`[make-i2c-elf] fixture is stale: ${relative(REPO_ROOT, FIXTURE)} differs from regenerated output.`);
    process.exit(1);
  }
  log(`fixture up to date (${elf.length} bytes, sha256 ${sha256})`);
} else {
  await mkdir(dirname(FIXTURE), { recursive: true });
  await writeFile(FIXTURE, elf);
  log(`wrote ${relative(REPO_ROOT, FIXTURE)}`);
  report();
}
