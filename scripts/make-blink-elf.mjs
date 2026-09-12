// PRD: §9 — Golden firmware builder: packages/sim-core/fixtures/blink.elf (dev-plan task P0.3)
// and fixtures/s3-blink.elf (dev-plan task P4.1, ESP32-S3 machine mapping).
// Deterministically assembles a tiny Xtensa LX6/LX7 program for the selected chip and
// packs it into an ELF32 LSB executable. Used as the golden fixture by QEMU integration
// tests (PRD §9 可测性).
//
// Firmware behavior (M0 acceptance groundwork, dev-plan §2.1):
//   1. enables GPIO2 as an output,
//   2. prints the chip's hello banner to UART0 (byte writes to the FIFO register),
//   3. toggles GPIO2 via OUT_W1TS/OUT_W1TC with a busy delay, forever (blink),
//   4. mirrors the LED level into the global `led_state` (P1.9 debug fixture).
//
// Debug info (dev-plan task P1.9): a hand-built minimal DWARF4 CU gives GDB
// `app_main` frame variables — locals in registers (a10/a11/a15) and the
// `led_state` global in memory — so the debug panel's vars/regs/watch views
// have real data against this firmware. No .debug_line: the fixture is
// hand-assembled, symbol breakpoints suffice.
//
// Chip memory maps (per ESP-IDF soc headers; S3 addresses additionally verified by
// booting the fixture under real `qemu-system-xtensa -machine esp32s3`): the Xtensa
// instruction encodings are identical for LX6 (esp32) and LX7 (esp32s3), so only the
// peripheral base addresses and the initial IRAM load address differ per chip.
//
// Encoder tables and the ELF writer live in scripts/lib/xtensa-elf.mjs (shared with
// make-i2c-elf.mjs, dev-plan task P1.2). No cross-toolchain is required.
//
// Usage: node scripts/make-blink-elf.mjs [--chip esp32|esp32s3] [--check]
//   default: (re)write the fixture for the selected chip (default esp32).
//   --check: verify the committed fixture is up to date.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Program, buildElf, elfSanity } from './lib/xtensa-elf.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const FIXTURE_DIR = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures');
const log = (msg) => console.log(`[make-blink-elf] ${msg}`);

// --- Per-chip memory map (ESP-IDF soc headers; P4.1 for the esp32s3 row) ---
const CHIPS = {
  esp32: {
    IRAM_BASE: 0x40080000,      // ESP32 IRAM; the single PT_LOAD segment is mapped here
    UART0_FIFO: 0x3ff40000,     // UART0 + UART_FIFO_REG (offset 0x0): byte writes transmit
    GPIO_OUT_W1TS: 0x3ff44008,  // GPIO_OUT_W1TS_REG: atomically set output bits
    GPIO_OUT_W1TC: 0x3ff4400c,  // GPIO_OUT_W1TC_REG: atomically clear output bits
    GPIO_EN_W1TS: 0x3ff44024,   // GPIO_ENABLE_W1TS_REG: atomically enable output driver
    MSG: 'Hello ESP32\r\n',
    FIXTURE: 'blink.elf',
    CU_NAME: 'blink.c',
  },
  esp32s3: {
    IRAM_BASE: 0x40370000,      // ESP32-S3 SRAM0 (IRAM); boot entry region
    UART0_FIFO: 0x60000000,     // UART0 FIFO (S3 peripheral block)
    GPIO_OUT_W1TS: 0x60004008,  // GPIO_OUT_W1TS_REG (S3 GPIO block, same offsets as ESP32)
    GPIO_OUT_W1TC: 0x6000400c,  // GPIO_OUT_W1TC_REG
    GPIO_EN_W1TS: 0x60004024,   // GPIO_ENABLE_W1TS_REG
    MSG: 'Hello ESP32-S3\r\n',
    FIXTURE: 's3-blink.elf',
    CU_NAME: 'blink-s3.c',
  },
};

const chipArgIdx = process.argv.indexOf('--chip');
const chipName = chipArgIdx !== -1 ? process.argv[chipArgIdx + 1] : 'esp32';
const CHIP = CHIPS[chipName];
if (CHIP === undefined) {
  console.error(`[make-blink-elf] unknown chip "${chipName}". Supported: ${Object.keys(CHIPS).join(', ')}.`);
  process.exit(1);
}
const FIXTURE = join(FIXTURE_DIR, CHIP.FIXTURE);

const GPIO2_MASK = 1 << 2; // LED pin of the blink acceptance scenario (PRD §1.4)
const MSG = Buffer.from(CHIP.MSG, 'ascii');
const DELAY_ITER = 0x02ffffff; // busy-loop iterations per blink half-period
const LED_STATE_INIT = 0xa5; // recognizable initial value (165) for debug-panel e2e

// --- Firmware program ----------------------------------------------------------------------
const prog = new Program(CHIP.IRAM_BASE);
const L = {
  uart: prog.literal('L_uart', CHIP.UART0_FIFO),
  enW1ts: prog.literal('L_en_w1ts', CHIP.GPIO_EN_W1TS),
  outW1ts: prog.literal('L_out_w1ts', CHIP.GPIO_OUT_W1TS),
  outW1tc: prog.literal('L_out_w1tc', CHIP.GPIO_OUT_W1TC),
  // L_msg is the 5th literal: 4 words precede it, so the string (after all words)
  // lands at IRAM_BASE + 28. Resolved via callback for robustness.
  msg: prog.literal('L_msg', (A) => A('S_msg')),
  delay: prog.literal('L_delay', DELAY_ITER),
  led: prog.literal('L_led', (A) => A('D_led_state')), // &led_state (P1.9 global)
};
prog.string('S_msg', MSG);
// Writable home of the `led_state` global (P1.9): inside the RWX PT_LOAD, after the string.
prog.data('D_led_state', Buffer.from([LED_STATE_INIT, 0, 0, 0]));

prog.label('_start');
prog.insn('l32r', 'l32r  a8, L_uart      ; a8 = UART0 FIFO', { at_: 8, lit: L.uart });
prog.insn('movi', 'movi  a9, 4           ; GPIO2 mask', { at_: 9, imm: GPIO2_MASK });
prog.insn('l32r', 'l32r  a10, L_en_w1ts  ; GPIO_ENABLE_W1TS', { at_: 10, lit: L.enW1ts });
prog.insn('s32i', 's32i  a9, a10, 0      ; GPIO2 -> output driver on', { at_: 9, as_: 10, off: 0 });

prog.label('app_main');
prog.label('main_loop');
prog.insn('l32r', 'l32r  a10, L_msg      ; msg_cursor = message', { at_: 10, lit: L.msg });
prog.insn('movi', 'movi  a11, ' + MSG.length + '         ; remaining = ' + MSG.length + ' chars', { at_: 11, imm: MSG.length });
prog.label('next_char');
prog.insn('l8ui', 'l8ui  a12, a10, 0     ; load char', { at_: 12, as_: 10, off: 0 });
prog.insn('s8i', 's8i   a12, a8, 0       ; UART0 TX', { at_: 12, as_: 8, off: 0 });
prog.insn('addi', 'addi  a10, a10, 1     ; advance cursor', { at_: 10, as_: 10, imm: 1 });
prog.insn('addi', 'addi  a11, a11, -1    ; countdown', { at_: 11, as_: 11, imm: -1 });
prog.insn('bnez', 'bnez  a11, next_char', { as_: 11, target: 'next_char' });

prog.insn('l32r', 'l32r  a13, L_out_w1ts ; LED on', { at_: 13, lit: L.outW1ts });
prog.insn('movi', 'movi  a14, 4          ; GPIO2 mask', { at_: 14, imm: GPIO2_MASK });
prog.insn('s32i', 's32i  a14, a13, 0     ; GPIO_OUT_W1TS |= GPIO2', { at_: 14, as_: 13, off: 0 });
prog.insn('l32r', 'l32r  a12, L_led      ; &led_state', { at_: 12, lit: L.led });
prog.insn('movi', 'movi  a14, 1          ; level = on', { at_: 14, imm: 1 });
prog.insn('s32i', 's32i  a14, a12, 0     ; led_state = 1', { at_: 14, as_: 12, off: 0 });
// e2e breakpoint target (P1.9): stopping here proves the write is observable via GDB.
prog.label('led_state_written');
prog.insn('l32r', 'l32r  a15, L_delay    ; delay_ticks = busy delay', { at_: 15, lit: L.delay });
prog.label('delay_on');
prog.insn('addi', 'addi  a15, a15, -1    ; delay tick', { at_: 15, as_: 15, imm: -1 });
prog.insn('bnez', 'bnez  a15, delay_on', { as_: 15, target: 'delay_on' });

prog.insn('l32r', 'l32r  a13, L_out_w1tc ; LED off', { at_: 13, lit: L.outW1tc });
prog.insn('movi', 'movi  a14, 4          ; GPIO2 mask', { at_: 14, imm: GPIO2_MASK });
prog.insn('s32i', 's32i  a14, a13, 0     ; GPIO_OUT_W1TC |= GPIO2', { at_: 14, as_: 13, off: 0 });
prog.insn('l32r', 'l32r  a12, L_led      ; &led_state', { at_: 12, lit: L.led });
prog.insn('movi', 'movi  a14, 0          ; level = off', { at_: 14, imm: 0 });
prog.insn('s32i', 's32i  a14, a12, 0     ; led_state = 0', { at_: 14, as_: 12, off: 0 });
prog.insn('l32r', 'l32r  a15, L_delay    ; busy delay', { at_: 15, lit: L.delay });
prog.label('delay_off');
prog.insn('addi', 'addi  a15, a15, -1    ; delay tick', { at_: 15, as_: 15, imm: -1 });
prog.insn('bnez', 'bnez  a15, delay_off', { as_: 15, target: 'delay_off' });
prog.insn('j', 'j     main_loop         ; blink forever', { target: 'main_loop' });
prog.label('app_main_end'); // DWARF high_pc (the whole blink loop stays in scope)

prog.assemble();

// --- DWARF4 debug info (dev-plan task P1.9) --------------------------------------------------
// One CU -> one subprogram DIE (app_main) with register locals, plus CU-level
// globals with memory locations and the referenced base types.
const appMain = prog.addressOf('app_main');
const appMainEnd = prog.addressOf('app_main_end');
const CU_NAME = CHIP.CU_NAME;
const DWARF_VARS = [
  { name: 'msg_cursor', reg: 10, type: 'unsigned int' }, // a10: print cursor
  { name: 'remaining', reg: 11, type: 'int' },           // a11: chars left to print
  { name: 'delay_ticks', reg: 15, type: 'unsigned int' },// a15: busy-loop countdown
];
const DWARF_GLOBALS = [
  { name: 'led_state', type: 'unsigned int' }, // address resolved below
];

function buildDwarf({ lowPc, highPc, vars, globals }) {
  // Abbrev table (see attribute/form constants inline below).
  const abbrev = Buffer.from([
    0x01, 0x11, 0x01, 0x03, 0x08, 0x13, 0x0b, 0x11, 0x01, 0x12, 0x01, 0x00, 0x00,
    0x02, 0x2e, 0x01, 0x03, 0x08, 0x11, 0x01, 0x12, 0x01, 0x00, 0x00,
    0x03, 0x34, 0x00, 0x03, 0x08, 0x49, 0x13, 0x02, 0x18, 0x00, 0x00,
    0x04, 0x24, 0x00, 0x03, 0x08, 0x3e, 0x0b, 0x0b, 0x0b, 0x00, 0x00,
    0x00,
  ]);
  const uleb = (n) => {
    const out = [];
    let v = n;
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v > 0) b |= 0x80;
      out.push(b);
    } while (v > 0);
    return out;
  };
  const chunks = [];
  let off = 11; // CU header: unit_length(4) + version(2) + abbrev_offset(4) + address_size(1)
  const push = (...bytes) => { chunks.push(Buffer.from(bytes)); off += bytes.length; };
  const pushStr = (s) => { chunks.push(Buffer.from(`${s}\0`, 'ascii')); off += s.length + 1; };
  const pushU32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); chunks.push(b); off += 4; };
  const refPatches = []; // { buf, typeName }
  const pushTypeRef = (typeName) => {
    const b = Buffer.alloc(4);
    chunks.push(b); off += 4;
    refPatches.push({ buf: b, typeName });
  };
  const pushExpr = (opBytes) => { push(...uleb(opBytes.length), ...opBytes); };

  // DIE 1: compile_unit.
  push(0x01); pushStr(CU_NAME); push(0x01 /* DW_LANG_C89 */); pushU32(lowPc); pushU32(highPc);
  // DIE 2: subprogram app_main.
  push(0x02); pushStr('app_main'); pushU32(appMain); pushU32(appMainEnd);
  // DIE 3..n: locals (subprogram children), located in registers via DW_OP_regx.
  // Xtensa DWARF register numbers 0-15 map to a0-a15 (verified against
  // xtensa-esp32-elf-gdb in the P1.9 e2e).
  for (const v of vars) {
    push(0x03); pushStr(v.name); pushTypeRef(v.type); pushExpr([0x90, ...uleb(v.reg)]);
  }
  push(0x00); // end of subprogram children
  // Globals (CU children): memory locations via DW_OP_addr.
  for (const g of globals) {
    push(0x03); pushStr(g.name); pushTypeRef(g.type);
    pushExpr([0x03, g.addr & 0xff, (g.addr >> 8) & 0xff, (g.addr >> 16) & 0xff, (g.addr >> 24) & 0xff]);
  }
  // Base types (CU children).
  const typeOffset = {};
  for (const t of ['int', 'unsigned int']) {
    typeOffset[t] = off;
    push(0x04); pushStr(t);
    push(t === 'int' ? 0x05 /* DW_ATE_signed */ : 0x07 /* DW_ATE_unsigned */);
    push(4); // byte size
  }
  push(0x00); // end of CU children

  // Patch the ref4 type references now that base-type offsets are known.
  for (const p of refPatches) p.buf.writeUInt32LE(typeOffset[p.typeName], 0);

  const dies = Buffer.concat(chunks);
  const info = Buffer.alloc(11 + dies.length);
  info.writeUInt32LE(dies.length + 7, 0); // unit_length: everything after this field
  info.writeUInt16LE(4, 4); // version = DWARF4
  info.writeUInt32LE(0, 6); // debug_abbrev offset
  info[10] = 4; // address size
  dies.copy(info, 11);
  return { abbrev, info };
}

DWARF_GLOBALS[0].addr = prog.addressOf('D_led_state');
const { abbrev, info } = buildDwarf({
  lowPc: CHIP.IRAM_BASE,
  highPc: CHIP.IRAM_BASE + prog.image.length,
  vars: DWARF_VARS,
  globals: DWARF_GLOBALS,
});

const entry = prog.symbols[0].value;
const symbols = [
  ...prog.symbols,
  { name: 'led_state_written', value: prog.addressOf('led_state_written'), size: 0 },
  { name: 'led_state', value: prog.addressOf('D_led_state'), size: 4, type: 'object' },
];
const elf = buildElf(CHIP.IRAM_BASE, prog.image, entry, symbols, [
  { name: '.debug_info', data: info },
  { name: '.debug_abbrev', data: abbrev },
]);
elfSanity(elf, entry);
dwarfSanity(info, DWARF_VARS, DWARF_GLOBALS);
const sha256 = createHash('sha256').update(elf).digest('hex');

/** Structural self-check of the emitted .debug_info (keeps regressions loud). */
function dwarfSanity(debugInfo, vars, globals) {
  const checks = [
    ['DWARF version 4', debugInfo.readUInt16LE(4) === 4],
    ['address size 4', debugInfo[10] === 4],
    ['CU name present', debugInfo.includes(Buffer.from(`${CU_NAME}\0`, 'ascii'))],
    ...vars.map((v) => [`local ${v.name} present`, debugInfo.includes(Buffer.from(`${v.name}\0`, 'ascii'))]),
    ...globals.map((g) => [`global ${g.name} present`, debugInfo.includes(Buffer.from(`${g.name}\0`, 'ascii'))]),
    ['app_main present', debugInfo.includes(Buffer.from('app_main\0', 'ascii'))],
  ];
  for (const [what, ok] of checks) {
    if (!ok) throw new Error(`[BB-002] DWARF self-check failed: ${what}`);
  }
}

const report = () => {
  log(`chip ${chipName}: image ${prog.image.length} bytes, ELF ${elf.length} bytes, sha256 ${sha256}`);
  for (const s of symbols) log(`symbol ${s.name} = 0x${s.value.toString(16)} (size ${s.size})`);
  log(`DWARF: ${DWARF_VARS.length} locals, ${DWARF_GLOBALS.length} global, .debug_info ${info.length} bytes`);
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
