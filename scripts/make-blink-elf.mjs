// PRD: §9 — Golden firmware builder: packages/sim-core/fixtures/blink.elf (dev-plan task P0.3).
// Deterministically assembles a tiny Xtensa LX6 program for the ESP32 and packs it into an
// ELF32 LSB executable. Used as the golden fixture by QEMU integration tests (PRD §9 可测性).
//
// Firmware behavior (M0 acceptance groundwork, dev-plan §2.1):
//   1. enables GPIO2 as an output,
//   2. prints "Hello ESP32\r\n" to UART0 (byte writes to the FIFO register),
//   3. toggles GPIO2 via OUT_W1TS/OUT_W1TC with a busy delay, forever (blink).
//
// Encoder tables and the ELF writer live in scripts/lib/xtensa-elf.mjs (shared with
// make-i2c-elf.mjs, dev-plan task P1.2). No cross-toolchain is required.
//
// Usage: node scripts/make-blink-elf.mjs [--check]
//   default: (re)write the fixture. --check: verify the committed fixture is up to date.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Program, buildElf, elfSanity } from './lib/xtensa-elf.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const FIXTURE = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'blink.elf');
const log = (msg) => console.log(`[make-blink-elf] ${msg}`);

// --- ESP32 memory-mapped registers used by the firmware (per ESP-IDF soc headers) ---
const IRAM_BASE = 0x40080000; // ESP32 IRAM; the single PT_LOAD segment is mapped here
const UART0_FIFO = 0x3ff40000; // UART0 + UART_FIFO_REG (offset 0x0): byte writes transmit
const GPIO_OUT_W1TS = 0x3ff44008; // GPIO_OUT_W1TS_REG: atomically set output bits
const GPIO_OUT_W1TC = 0x3ff4400c; // GPIO_OUT_W1TC_REG: atomically clear output bits
const GPIO_EN_W1TS = 0x3ff44024; // GPIO_ENABLE_W1TS_REG: atomically enable output driver
const GPIO2_MASK = 1 << 2; // LED pin of the blink acceptance scenario (PRD §1.4)
const MSG = Buffer.from('Hello ESP32\r\n', 'ascii'); // printed once per blink cycle
const DELAY_ITER = 0x02ffffff; // busy-loop iterations per blink half-period

// --- Firmware program ----------------------------------------------------------------------
const prog = new Program(IRAM_BASE);
const L = {
  uart: prog.literal('L_uart', UART0_FIFO),
  enW1ts: prog.literal('L_en_w1ts', GPIO_EN_W1TS),
  outW1ts: prog.literal('L_out_w1ts', GPIO_OUT_W1TS),
  outW1tc: prog.literal('L_out_w1tc', GPIO_OUT_W1TC),
  // L_msg is the 5th literal: 4 words precede it, so the string (after all 6
  // words) lands at IRAM_BASE + 24. Resolved via callback for robustness.
  msg: prog.literal('L_msg', (A) => A('S_msg')),
  delay: prog.literal('L_delay', DELAY_ITER),
};
prog.string('S_msg', MSG);

prog.label('_start');
prog.insn('l32r', 'l32r  a8, L_uart      ; a8 = UART0 FIFO', { at_: 8, lit: L.uart });
prog.insn('movi', 'movi  a9, 4           ; GPIO2 mask', { at_: 9, imm: GPIO2_MASK });
prog.insn('l32r', 'l32r  a10, L_en_w1ts  ; GPIO_ENABLE_W1TS', { at_: 10, lit: L.enW1ts });
prog.insn('s32i', 's32i  a9, a10, 0      ; GPIO2 -> output driver on', { at_: 9, as_: 10, off: 0 });

prog.label('app_main');
prog.label('main_loop');
prog.insn('l32r', 'l32r  a10, L_msg      ; a10 = message', { at_: 10, lit: L.msg });
prog.insn('movi', 'movi  a11, 13         ; remaining chars', { at_: 11, imm: MSG.length });
prog.label('next_char');
prog.insn('l8ui', 'l8ui  a12, a10, 0     ; load char', { at_: 12, as_: 10, off: 0 });
prog.insn('s8i', 's8i   a12, a8, 0       ; UART0 TX', { at_: 12, as_: 8, off: 0 });
prog.insn('addi', 'addi  a10, a10, 1     ; advance cursor', { at_: 10, as_: 10, imm: 1 });
prog.insn('addi', 'addi  a11, a11, -1    ; countdown', { at_: 11, as_: 11, imm: -1 });
prog.insn('bnez', 'bnez  a11, next_char', { as_: 11, target: 'next_char' });

prog.insn('l32r', 'l32r  a13, L_out_w1ts ; LED on', { at_: 13, lit: L.outW1ts });
prog.insn('movi', 'movi  a14, 4          ; GPIO2 mask', { at_: 14, imm: GPIO2_MASK });
prog.insn('s32i', 's32i  a14, a13, 0     ; GPIO_OUT_W1TS |= GPIO2', { at_: 14, as_: 13, off: 0 });
prog.insn('l32r', 'l32r  a15, L_delay    ; busy delay', { at_: 15, lit: L.delay });
prog.label('delay_on');
prog.insn('addi', 'addi  a15, a15, -1    ; delay tick', { at_: 15, as_: 15, imm: -1 });
prog.insn('bnez', 'bnez  a15, delay_on', { as_: 15, target: 'delay_on' });

prog.insn('l32r', 'l32r  a13, L_out_w1tc ; LED off', { at_: 13, lit: L.outW1tc });
prog.insn('movi', 'movi  a14, 4          ; GPIO2 mask', { at_: 14, imm: GPIO2_MASK });
prog.insn('s32i', 's32i  a14, a13, 0     ; GPIO_OUT_W1TC |= GPIO2', { at_: 14, as_: 13, off: 0 });
prog.insn('l32r', 'l32r  a15, L_delay    ; busy delay', { at_: 15, lit: L.delay });
prog.label('delay_off');
prog.insn('addi', 'addi  a15, a15, -1    ; delay tick', { at_: 15, as_: 15, imm: -1 });
prog.insn('bnez', 'bnez  a15, delay_off', { as_: 15, target: 'delay_off' });
prog.insn('j', 'j     main_loop         ; blink forever', { target: 'main_loop' });

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
    console.error(`[make-blink-elf] fixture missing: ${relative(REPO_ROOT, FIXTURE)}. Run without --check to create it.`);
    process.exit(1);
  }
  if (!existing.equals(elf)) {
    console.error(`[make-blink-elf] fixture is stale: ${relative(REPO_ROOT, FIXTURE)} differs from regenerated output.`);
    process.exit(1);
  }
  log(`fixture up to date (${elf.length} bytes, sha256 ${sha256})`);
} else {
  await mkdir(dirname(FIXTURE), { recursive: true });
  await writeFile(FIXTURE, elf);
  log(`wrote ${relative(REPO_ROOT, FIXTURE)}`);
  report();
}
