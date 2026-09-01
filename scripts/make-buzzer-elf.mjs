// PRD: §9 — Golden firmware builder: packages/sim-core/fixtures/buzzer.elf
// (dev-plan task P2.3). Deterministically assembles a tiny Xtensa LX6 program
// that configures the ESP32 LEDC peripheral to drive a square wave onto GPIO4
// (the buzzer acceptance scenario):
//
//   1. HSTIMER0: APB 80MHz source, 10-bit duty resolution, clk_div chosen for
//      440Hz (then 880Hz) — f = 80e6 / (div/256) / 2^10.
//   2. HSCH0: timer_sel=0, SIG_OUT_EN=1, duty 512/1023 (~50%).
//   3. GPIO matrix: GPIO4 FUNC_OUT_SEL <- LEDC_HS_SIG_OUT0_IDX (71), output
//      driver on. The breadesp-dbus LEDC/GPIO-matrix shadows decode this into
//      a `pwm` transaction per pin (freq centi-Hz + duty permille).
//   4. Prints "BUZZ 440\r\n", busy-waits, retunes the timer to 880Hz, prints
//      "BUZZ 880\r\n", then hangs (the flush BH batches each change).
//
// Usage: node scripts/make-buzzer-elf.mjs [--check]
//   default: (re)write the fixture. --check: verify the committed fixture is up to date.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Program, buildElf, elfSanity } from './lib/xtensa-elf.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const FIXTURE = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'buzzer.elf');
const log = (msg) => console.log(`[make-buzzer-elf] ${msg}`);

// --- ESP32 memory-mapped registers used by the firmware ---
const IRAM_BASE = 0x40080000; // ESP32 IRAM; the single PT_LOAD segment is mapped here
const UART0_FIFO = 0x3ff40000; // UART0 UART_FIFO_REG: byte writes transmit
const GPIO_EN_W1TS = 0x3ff44024; // GPIO_ENABLE_W1TS_REG: output driver on
const GPIO_FUNC4_OUT_SEL = 0x3ff44000 + 0x530 + 4 * 4; // matrix: GPIO4 signal select
const LEDC_BASE = 0x3ff59000; // DR_REG_LEDC_BASE
const LEDC_HSCH0_CONF0 = LEDC_BASE + 0x000;
const LEDC_HSCH0_DUTY = LEDC_BASE + 0x008;
const LEDC_HSTIMER0_CONF = LEDC_BASE + 0x140;

// --- LEDC field values (ESP32 TRM) ---
const TICK_SEL_APB = 1 << 25; // HSTIMER clock = APB_CLK 80MHz
const DUTY_RES = 10; // bits
const CH_CONF0_SIG_OUT_EN = 1 << 2; // timer_sel=0
const DUTY_50PC = 512 << 4; // duty value in the high bits, 4 fractional low bits
const LEDC_HS_SIG_OUT0_IDX = 71; // peripheral output signal of HS channel 0
const GPIO4_MASK = 1 << 4;

/** Timer conf for a target frequency at DUTY_RES bits: f = 80e6*256/(div*2^res). */
const timerConf = (freqHz) => {
  const div = Math.round((80_000_000 * 256) / (freqHz * (1 << DUTY_RES)));
  return (TICK_SEL_APB | (div << 5) | DUTY_RES) >>> 0;
};
const TCONF_440 = timerConf(440);
const TCONF_880 = timerConf(880);

const MSG_440 = Buffer.from('BUZZ 440\r\n', 'ascii');
const MSG_880 = Buffer.from('BUZZ 880\r\n', 'ascii');
const DELAY_LOOPS = 4_000_000; // busy-wait between the two tones

// --- Firmware program -------------------------------------------------------
const prog = new Program(IRAM_BASE);
const L = {
  uart: prog.literal('L_uart', UART0_FIFO),
  enW1ts: prog.literal('L_en_w1ts', GPIO_EN_W1TS),
  func4: prog.literal('L_func4', GPIO_FUNC4_OUT_SEL),
  chConf0: prog.literal('L_ch_conf0', LEDC_HSCH0_CONF0),
  chDuty: prog.literal('L_ch_duty', LEDC_HSCH0_DUTY),
  timerConf: prog.literal('L_timer_conf', LEDC_HSTIMER0_CONF),
  tconf440: prog.literal('L_tconf_440', TCONF_440),
  tconf880: prog.literal('L_tconf_880', TCONF_880),
  chConf0Val: prog.literal('L_ch_conf0_val', CH_CONF0_SIG_OUT_EN),
  dutyVal: prog.literal('L_duty_val', DUTY_50PC),
  sigOut0: prog.literal('L_sig_out0', LEDC_HS_SIG_OUT0_IDX),
  delay: prog.literal('L_delay', DELAY_LOOPS),
  msg440: prog.literal('L_msg440', (A) => A('S_msg440')),
  msg880: prog.literal('L_msg880', (A) => A('S_msg880')),
};
prog.string('S_msg440', MSG_440);
prog.string('S_msg880', MSG_880);

// `print <literal string>`: a10 = cursor, a11 = remaining, a12 = char, a8 = UART0.
const printBlock = (litName, length, target) => {
  prog.insn('l32r', `l32r  a10, ${litName.padEnd(14)}; a10 = message`, { at_: 10, lit: litName });
  prog.insn('movi', `movi  a11, ${length}         ; remaining chars`, { at_: 11, imm: length });
  prog.label(target);
  prog.insn('l8ui', 'l8ui  a12, a10, 0     ; load char', { at_: 12, as_: 10, off: 0 });
  prog.insn('s8i', 's8i   a12, a8, 0       ; UART0 TX', { at_: 12, as_: 8, off: 0 });
  prog.insn('addi', 'addi  a10, a10, 1     ; advance cursor', { at_: 10, as_: 10, imm: 1 });
  prog.insn('addi', 'addi  a11, a11, -1    ; countdown', { at_: 11, as_: 11, imm: -1 });
  prog.insn('bnez', `bnez  a11, ${target}`, { as_: 11, target });
};

// `store <value literal> -> <address literal>`: a13 = value, a14 = address.
const store = (valLit, addrLit, what) => {
  prog.insn('l32r', `l32r  a13, ${valLit.padEnd(14)}; ${what}`, { at_: 13, lit: valLit });
  prog.insn('l32r', `l32r  a14, ${addrLit.padEnd(14)}`, { at_: 14, lit: addrLit });
  prog.insn('s32i', 's32i  a13, a14, 0', { at_: 13, as_: 14, off: 0 });
};

prog.label('_start');
prog.insn('l32r', 'l32r  a8, L_uart       ; a8 = UART0 FIFO', { at_: 8, lit: L.uart });

prog.label('app_main');
// LEDC timer0 + channel0: 440Hz, ~50% duty.
store('L_tconf_440', 'L_timer_conf', 'HSTIMER0: 440Hz, res=10, APB');
store('L_ch_conf0_val', 'L_ch_conf0', 'HSCH0: timer0, SIG_OUT_EN');
store('L_duty_val', 'L_ch_duty', 'HSCH0 duty 512/1023');
// GPIO4: output driver on, matrix <- LEDC_HS_SIG_OUT0 (emits the first pwm tx).
store('L_sig_out0', 'L_func4', 'GPIO4 matrix <- LEDC HS sig0');
prog.insn('l32r', 'l32r  a13, L_en_w1ts   ; GPIO_ENABLE_W1TS', { at_: 13, lit: L.enW1ts });
prog.insn('movi', 'movi  a14, 16          ; GPIO4 mask', { at_: 14, imm: GPIO4_MASK });
prog.insn('s32i', 's32i  a14, a13, 0', { at_: 14, as_: 13, off: 0 });
printBlock('L_msg440', MSG_440.length, 'next_char_440');

// Busy-wait, then retune to 880Hz (timer conf rewrite emits the second pwm tx).
prog.insn('l32r', 'l32r  a15, L_delay     ; busy-wait count', { at_: 15, lit: L.delay });
prog.label('delay_loop');
prog.insn('addi', 'addi  a15, a15, -1', { at_: 15, as_: 15, imm: -1 });
prog.insn('bnez', 'bnez  a15, delay_loop', { as_: 15, target: 'delay_loop' });
store('L_tconf_880', 'L_timer_conf', 'HSTIMER0: 880Hz');
printBlock('L_msg880', MSG_880.length, 'next_char_880');

prog.label('hang');
prog.insn('j', 'j     hang               ; keep the tone running', { target: 'hang' });

prog.assemble();

const entry = prog.symbols[0].value;
const elf = buildElf(IRAM_BASE, prog.image, entry, prog.symbols);
elfSanity(elf, entry);
const sha256 = createHash('sha256').update(elf).digest('hex');

const report = () => {
  log(`image ${prog.image.length} bytes, ELF ${elf.length} bytes, sha256 ${sha256}`);
  log(`timer conf 440Hz = 0x${TCONF_440.toString(16)}, 880Hz = 0x${TCONF_880.toString(16)}`);
  for (const s of prog.symbols) log(`symbol ${s.name} = 0x${s.value.toString(16)} (size ${s.size})`);
};

const checkMode = process.argv.includes('--check');
if (checkMode) {
  let existing;
  try {
    existing = await readFile(FIXTURE);
  } catch {
    console.error(`[make-buzzer-elf] fixture missing: ${relative(REPO_ROOT, FIXTURE)}. Run without --check to create it.`);
    process.exit(1);
  }
  if (!existing.equals(elf)) {
    console.error(`[make-buzzer-elf] fixture is stale: ${relative(REPO_ROOT, FIXTURE)} differs from regenerated output.`);
    process.exit(1);
  }
  log(`fixture up to date (${elf.length} bytes, sha256 ${sha256})`);
} else {
  await mkdir(dirname(FIXTURE), { recursive: true });
  await writeFile(FIXTURE, elf);
  log(`wrote ${relative(REPO_ROOT, FIXTURE)}`);
  report();
}
