// PRD: §9 — Golden firmware builder: packages/sim-core/fixtures/knob.elf (dev-plan task P3.4).
// Deterministically assembles a tiny Xtensa LX6 program for the ESP32 that verifies
// the gpio-in reverse channel ({"kind":"gpio-in","pin":N,"level":L}): it polls the
// GPIO_IN register (shadowed by breadesp-dbus, which overlays bridge-injected input
// levels) and decodes the quadrature sequence a `knob` peripheral plays on
// A=GPIO4 / B=GPIO16 into a signed transition count:
//
//   - count reaches +8 (two clockwise detents)  -> prints "KNOB CW\r\n" once;
//   - count returns to 0 after that             -> prints "KNOB ZERO\r\n" and hangs.
//
// The decode is a 16-entry transition table indexed by prev*4+cur (cur bit0=A,
// bit1=B; entries are delta+1 biased to stay unsigned). Only exact whole-word
// matches against the four valid states classify — any glitch word decodes as
// state 0, which the delta table maps to a self-correcting ±1 wobble at worst.
//
// Usage: node scripts/make-knob-elf.mjs [--check]
//   default: (re)write the fixture. --check: verify the committed fixture is up to date.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Program, buildElf, elfSanity } from './lib/xtensa-elf.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const FIXTURE = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'knob.elf');
const log = (msg) => console.log(`[make-knob-elf] ${msg}`);

// --- ESP32 memory-mapped registers (per ESP-IDF soc headers) ---
const IRAM_BASE = 0x40080000;
const UART0_FIFO = 0x3ff40000;
// GPIO_IN_REG (0x3ff44000 + 0x3c): input pad levels of pins 0-31. The
// breadesp-dbus shadow merges bridge-injected levels into reads (P3.4).
const GPIO_IN = 0x3ff4403c;
const PIN_A_MASK = 1 << 4;   // knob A -> GPIO4
const PIN_B_MASK = 1 << 16;  // knob B -> GPIO16
const STATE_S1 = PIN_A_MASK;               // A only
const STATE_S2 = PIN_B_MASK;               // B only
const STATE_S3 = PIN_A_MASK | PIN_B_MASK;  // both
const TARGET_COUNT = 8;                    // two CW detents of 4 transitions

// Biased (delta+1) quadrature transition deltas, index prev*4+cur with
// cur bit0=A / bit1=B. CW (A leads B): 0->1->3->2->0 counts +1 per transition.
const DELTA_TABLE = Buffer.from([
  1, 2, 0, 1, // prev 00: rest, CW +1, CCW -1, invalid 0
  0, 1, 1, 2, // prev 01
  2, 1, 1, 0, // prev 10
  1, 0, 2, 1, // prev 11
]);

const MSG_CW = Buffer.from('KNOB CW\r\n', 'ascii');
const MSG_ZERO = Buffer.from('KNOB ZERO\r\n', 'ascii');

// --- Firmware program ----------------------------------------------------------------------
// Register plan: a8=UART0, a9=GPIO_IN addr, a13=cur, a14=prev, a15=count,
// a6=flags (0 = CW marker not yet printed), a5/a7/a11/a12 scratch.
const prog = new Program(IRAM_BASE);
const L = {
  uart: prog.literal('L_uart', UART0_FIFO),
  gpioin: prog.literal('L_gpioin', GPIO_IN),
  s1: prog.literal('L_s1', STATE_S1),
  s2: prog.literal('L_s2', STATE_S2),
  s3: prog.literal('L_s3', STATE_S3),
  eight: prog.literal('L_eight', TARGET_COUNT),
  table: prog.literal('L_table', (A) => A('D_table')),
  msgCw: prog.literal('L_msg_cw', (A) => A('S_msg_cw')),
  msgZero: prog.literal('L_msg_zero', (A) => A('S_msg_zero')),
};
prog.string('S_msg_cw', MSG_CW);
prog.string('S_msg_zero', MSG_ZERO);
prog.data('D_table', DELTA_TABLE);

/** `print <string>`: a10 = cursor, a11 = remaining, a12 = char, a8 = UART0 (clobbers a10-a12). */
const print = (litName, bytes, loopLabel) => {
  prog.insn('l32r', `l32r  a10, ${litName.padEnd(14)}; a10 = message`, { at_: 10, lit: litName });
  prog.insn('movi', `movi  a11, ${bytes}         ; remaining chars`, { at_: 11, imm: bytes.length });
  prog.label(loopLabel);
  prog.insn('l8ui', 'l8ui  a12, a10, 0     ; load char', { at_: 12, as_: 10, off: 0 });
  prog.insn('s8i', 's8i   a12, a8, 0       ; UART0 TX', { at_: 12, as_: 8, off: 0 });
  prog.insn('addi', 'addi  a10, a10, 1     ; advance cursor', { at_: 10, as_: 10, imm: 1 });
  prog.insn('addi', 'addi  a11, a11, -1    ; countdown', { at_: 11, as_: 11, imm: -1 });
  prog.insn('bnez', `bnez  a11, ${loopLabel}`, { as_: 11, target: loopLabel });
};

prog.label('_start');
prog.insn('l32r', 'l32r  a8, L_uart       ; a8 = UART0 FIFO', { at_: 8, lit: L.uart });
prog.insn('l32r', 'l32r  a9, L_gpioin     ; a9 = GPIO_IN', { at_: 9, lit: L.gpioin });
prog.insn('movi', 'movi  a13, 0           ; cur', { at_: 13, imm: 0 });
prog.insn('movi', 'movi  a14, 0           ; prev', { at_: 14, imm: 0 });
prog.insn('movi', 'movi  a15, 0           ; count', { at_: 15, imm: 0 });
prog.insn('movi', 'movi  a6, 0            ; flags', { at_: 6, imm: 0 });

prog.label('app_main');
prog.label('poll');
prog.insn('l32i', 'l32i  a12, a9, 0       ; word = GPIO_IN', { at_: 12, as_: 9, off: 0 });
// Classify the whole word into cur (only the two knob pins are ever driven).
prog.insn('l32r', 'l32r  a11, L_s3        ; both pins high?', { at_: 11, lit: L.s3 });
prog.insn('sub', 'sub   a7, a12, a11', { at_: 7, as_: 12, t_: 11 });
prog.insn('bnez', 'bnez  a7, not3', { as_: 7, target: 'not3' });
prog.insn('movi', 'movi  a13, 3           ; cur = S3', { at_: 13, imm: 3 });
prog.insn('j', 'j     classified', { target: 'classified' });
prog.label('not3');
prog.insn('l32r', 'l32r  a11, L_s2        ; B only?', { at_: 11, lit: L.s2 });
prog.insn('sub', 'sub   a7, a12, a11', { at_: 7, as_: 12, t_: 11 });
prog.insn('bnez', 'bnez  a7, not2', { as_: 7, target: 'not2' });
prog.insn('movi', 'movi  a13, 2           ; cur = S2', { at_: 13, imm: 2 });
prog.insn('j', 'j     classified', { target: 'classified' });
prog.label('not2');
prog.insn('l32r', 'l32r  a11, L_s1        ; A only?', { at_: 11, lit: L.s1 });
prog.insn('sub', 'sub   a7, a12, a11', { at_: 7, as_: 12, t_: 11 });
prog.insn('bnez', 'bnez  a7, not1', { as_: 7, target: 'not1' });
prog.insn('movi', 'movi  a13, 1           ; cur = S1', { at_: 13, imm: 1 });
prog.insn('j', 'j     classified', { target: 'classified' });
prog.label('not1');
prog.insn('movi', 'movi  a13, 0           ; cur = S0', { at_: 13, imm: 0 });
prog.label('classified');
prog.insn('sub', 'sub   a7, a13, a14      ; cur == prev?', { at_: 7, as_: 13, t_: 14 });
prog.insn('bnez', 'bnez  a7, changed', { as_: 7, target: 'changed' });
prog.insn('j', 'j     poll', { target: 'poll' });

prog.label('changed');
prog.insn('add', 'add   a12, a14, a14     ; idx = prev*4 + cur', { at_: 12, as_: 14, t_: 14 });
prog.insn('add', 'add   a12, a12, a12', { at_: 12, as_: 12, t_: 12 });
prog.insn('add', 'add   a12, a12, a13', { at_: 12, as_: 12, t_: 13 });
prog.insn('l32r', 'l32r  a11, L_table     ; delta table base', { at_: 11, lit: L.table });
prog.insn('add', 'add   a11, a11, a12', { at_: 11, as_: 11, t_: 12 });
prog.insn('l8ui', 'l8ui  a12, a11, 0      ; biased delta (0/1/2)', { at_: 12, as_: 11, off: 0 });
prog.insn('addi', 'addi  a12, a12, -1     ; unbias', { at_: 12, as_: 12, imm: -1 });
prog.insn('add', 'add   a15, a15, a12     ; count += delta', { at_: 15, as_: 15, t_: 12 });
prog.insn('movi', 'movi  a14, 0           ; prev = cur', { at_: 14, imm: 0 });
prog.insn('add', 'add   a14, a14, a13', { at_: 14, as_: 14, t_: 13 });
// Markers: CW printed once at +8; ZERO (and halt) when the count returns to 0.
prog.insn('bnez', 'bnez  a6, try_zero     ; CW marker done?', { as_: 6, target: 'try_zero' });
prog.insn('l32r', 'l32r  a11, L_eight', { at_: 11, lit: L.eight });
prog.insn('sub', 'sub   a7, a15, a11      ; count == +8?', { at_: 7, as_: 15, t_: 11 });
prog.insn('bnez', 'bnez  a7, poll', { as_: 7, target: 'poll' });
prog.insn('movi', 'movi  a6, 1            ; CW marker printed', { at_: 6, imm: 1 });
print('L_msg_cw', MSG_CW, 'cw_loop');
prog.insn('j', 'j     poll', { target: 'poll' });
prog.label('try_zero');
prog.insn('bnez', 'bnez  a15, poll        ; count != 0: keep polling', { as_: 15, target: 'poll' });
print('L_msg_zero', MSG_ZERO, 'zero_loop');
prog.label('hang');
prog.insn('j', 'j     hang', { target: 'hang' });

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
    console.error(`[make-knob-elf] fixture missing: ${relative(REPO_ROOT, FIXTURE)}. Run without --check to create it.`);
    process.exit(1);
  }
  if (!existing.equals(elf)) {
    console.error(`[make-knob-elf] fixture is stale: ${relative(REPO_ROOT, FIXTURE)} differs from regenerated output.`);
    process.exit(1);
  }
  log(`fixture up to date (${elf.length} bytes, sha256 ${sha256})`);
} else {
  await mkdir(dirname(FIXTURE), { recursive: true });
  await writeFile(FIXTURE, elf);
  log(`wrote ${relative(REPO_ROOT, FIXTURE)}`);
  report();
}
