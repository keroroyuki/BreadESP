// PRD: §9 — Golden firmware builder: packages/sim-core/fixtures/mic.elf
// (dev-plan task P3.1). Deterministically assembles a tiny Xtensa LX6 program
// that receives samples through the ESP32 I2S0 RX DMA engine (the microphone
// acceptance scenario — 固件读到采样):
//
//   1. Builds a four-descriptor in-link DMA ring in DRAM (lldesc_t,
//      256-byte buffers, owner=DMA, d0 -> d1 -> d2 -> d3 -> d0).
//   2. Configures I2S0 RX: CLKM div 25 (160MHz PLL -> 6.4MHz sck), RX BCK
//      div 12, 16 bits/channel mono (RX_MONO) -> 16.667kHz sample rate;
//      IN_LINK start + RX_START kick the DMA engine.
//   3. Prints "MIC RDY\r\n" on UART0, then polls the DMA buffers, re-arming
//      every visited descriptor each pass (the standard ring-consumption
//      pattern): a buffer whose content turned non-zero is a received chunk.
//      After 8 received chunks it prints "MIC OK\r\n" and hangs.
//
// The breadesp-dbus I2S shadow decodes the RX clock config and feeds the
// in-link ring from the bridge-injected PCM queue (reverse channel, P3.1),
// so the samples this firmware reads originate from the mic peripheral
// model. DRAM starts zeroed, so a non-zero buffer word is unambiguous.
//
// Usage: node scripts/make-mic-elf.mjs [--check]
//   default: (re)write the fixture. --check: verify the committed fixture is up to date.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Program, buildElf, elfSanity } from './lib/xtensa-elf.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const FIXTURE = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'mic.elf');
const log = (msg) => console.log(`[make-mic-elf] ${msg}`);

// --- ESP32 memory-mapped registers / DRAM scratch used by the firmware ---
const IRAM_BASE = 0x40080000; // ESP32 IRAM; the single PT_LOAD segment is mapped here
const UART0_FIFO = 0x3ff40000; // UART0 UART_FIFO_REG: byte writes transmit
const I2S0_BASE = 0x3ff4f000; // DR_REG_I2S_BASE
const I2S_CONF = I2S0_BASE + 0x08;
const I2S_IN_LINK = I2S0_BASE + 0x34;
const I2S_CLKM_CONF = I2S0_BASE + 0xac;
const I2S_SAMPLE_RATE_CONF = I2S0_BASE + 0xb0;
// Top of DRAM (0x3ffae000..0x3fffffff): clear of the ROM stack and the IRAM image.
const BUF_BASE = 0x3fff8000; // four 256-byte DMA buffers
const DESC_BASE = 0x3fff9000; // four 12-byte lldesc_t descriptors
const DESC_COUNT = 4;
const BUF_SIZE = 256;
const HITS_TARGET = 8;

// --- Register field values (ESP32 TRM, esp-idf i2s_reg.h) ---
const CLKM_CONF_VAL = (25 | (1 << 20) | (2 << 21)) >>> 0; // div 25, CLK_EN, CLK_SEL=PLL160
const SRATE_CONF_VAL = ((12 << 0) | (16 << 12)) >>> 0; // RX bck div 12, RX 16 bits/channel
const CONF_RESET = 0x0005; // RX_RESET | RX_FIFO_RESET
const CONF_RUN = (1 << 4) | (1 << 11) | (1 << 14); // RX_START | RX_MSB_SHIFT | RX_MONO
const IN_LINK_RUN = ((DESC_BASE & 0xfffff) | (1 << 29)) >>> 0; // addr + START
const LLDESC_W0 = (BUF_SIZE | (BUF_SIZE << 12) | (1 << 31)) >>> 0; // size=length=256, owner=DMA

const MSG_RDY = Buffer.from('MIC RDY\r\n', 'ascii');
const MSG_OK = Buffer.from('MIC OK\r\n', 'ascii');

// --- Firmware program -------------------------------------------------------
const prog = new Program(IRAM_BASE);
const L = {
  uart: prog.literal('L_uart', UART0_FIFO),
  conf: prog.literal('L_conf', I2S_CONF),
  inLink: prog.literal('L_in_link', I2S_IN_LINK),
  clkm: prog.literal('L_clkm', I2S_CLKM_CONF),
  srate: prog.literal('L_srate', I2S_SAMPLE_RATE_CONF),
  clkmVal: prog.literal('L_clkm_val', CLKM_CONF_VAL),
  srateVal: prog.literal('L_srate_val', SRATE_CONF_VAL),
  confReset: prog.literal('L_conf_reset', CONF_RESET),
  confRun: prog.literal('L_conf_run', CONF_RUN),
  inLinkRun: prog.literal('L_in_link_run', IN_LINK_RUN),
  lldescW0: prog.literal('L_lldesc_w0', LLDESC_W0),
  msgRdy: prog.literal('L_msg_rdy', (A) => A('S_msg_rdy')),
  msgOk: prog.literal('L_msg_ok', (A) => A('S_msg_ok')),
};
prog.string('S_msg_rdy', MSG_RDY);
prog.string('S_msg_ok', MSG_OK);

// `store <value literal> -> <address literal> + offset`: a13 = value, a14 = address.
const store = (valLit, addrLit, offset, what) => {
  prog.insn('l32r', `l32r  a13, ${valLit.padEnd(14)}; ${what}`, { at_: 13, lit: valLit });
  prog.insn('l32r', `l32r  a14, ${addrLit.padEnd(14)}`, { at_: 14, lit: addrLit });
  prog.insn('s32i', `s32i  a13, a14, ${offset}`, { at_: 13, as_: 14, off: offset });
};

// `print <literal string>`: a10 = cursor, a11 = remaining, a12 = char, a8 = UART0.
const print = (msgLit, len, label) => {
  prog.insn('l32r', `l32r  a10, ${msgLit}      ; a10 = message`, { at_: 10, lit: msgLit });
  prog.insn('movi', `movi  a11, ${len}         ; remaining chars`, { at_: 11, imm: len });
  prog.label(`${label}_char`);
  prog.insn('l8ui', 'l8ui  a12, a10, 0     ; load char', { at_: 12, as_: 10, off: 0 });
  prog.insn('s8i', 's8i   a12, a8, 0       ; UART0 TX', { at_: 12, as_: 8, off: 0 });
  prog.insn('addi', 'addi  a10, a10, 1     ; advance cursor', { at_: 10, as_: 10, imm: 1 });
  prog.insn('addi', 'addi  a11, a11, -1    ; countdown', { at_: 11, as_: 11, imm: -1 });
  prog.insn('bnez', `bnez  a11, ${label}_char`, { as_: 11, target: `${label}_char` });
};

prog.label('_start');
prog.insn('l32r', 'l32r  a8, L_uart       ; a8 = UART0 FIFO', { at_: 8, lit: L.uart });

prog.label('app_main');
// In-link descriptor ring: d0 -> d1 -> d2 -> d3 -> d0 over four buffers.
for (let i = 0; i < DESC_COUNT; i++) {
  const desc = DESC_BASE + 12 * i;
  const next = DESC_BASE + 12 * ((i + 1) % DESC_COUNT);
  prog.literal(`L_desc${i}`, desc);
  prog.literal(`L_buf${i}`, BUF_BASE + BUF_SIZE * i);
  prog.literal(`L_next${i}`, next);
  store(`L_lldesc_w0`, `L_desc${i}`, 0, `d${i}: size=len=${BUF_SIZE} owner=DMA`);
  store(`L_buf${i}`, `L_desc${i}`, 4, `d${i}: buf`);
  store(`L_next${i}`, `L_desc${i}`, 8, `d${i}: next -> d${(i + 1) % DESC_COUNT}`);
}

// I2S0 RX clock + format, then start the in-link DMA and RX.
store('L_clkm_val', 'L_clkm', 0, 'CLKM: div 25, CLK_EN, PLL160');
store('L_srate_val', 'L_srate', 0, 'RX BCK div 12, RX 16 bits/channel');
store('L_conf_reset', 'L_conf', 0, 'RX reset pulse');
store('L_conf_run', 'L_conf', 0, 'RX_START | RX_MSB_SHIFT | RX_MONO');
store('L_in_link_run', 'L_in_link', 0, 'IN_LINK addr + START');

print('L_msg_rdy', MSG_RDY.length, 'rdy');

// Poll the DMA buffers; a non-zero buffer means a chunk arrived.
//   a2 = descriptor cursor, a3 = buffer cursor, a4 = buffers left this pass,
//   a5 = hits left until MIC OK, a6/a7 = scratch.
prog.insn('movi', `movi  a5, ${HITS_TARGET}         ; hits until done`, { at_: 5, imm: HITS_TARGET });
prog.label('poll');
prog.insn('movi', `movi  a4, ${DESC_COUNT}         ; buffers per pass`, { at_: 4, imm: DESC_COUNT });
prog.insn('l32r', 'l32r  a2, L_desc0      ; desc cursor', { at_: 2, lit: 'L_desc0' });
prog.insn('l32r', 'l32r  a3, L_buf0       ; buffer cursor', { at_: 3, lit: 'L_buf0' });
prog.label('buf_loop');
// Re-arm the descriptor unconditionally each pass: the ring keeps accepting
// samples regardless of what the previous fill contained.
prog.insn('l32r', 'l32r  a7, L_lldesc_w0  ; re-arm descriptor (owner=DMA)', { at_: 7, lit: L.lldescW0 });
prog.insn('s32i', 's32i  a7, a2, 0', { at_: 7, as_: 2, off: 0 });
prog.insn('l32i', 'l32i  a6, a3, 0       ; first word of buffer', { at_: 6, as_: 3, off: 0 });
prog.insn('bnez', 'bnez  a6, buf_hit', { as_: 6, target: 'buf_hit' });
prog.insn('l32i', 'l32i  a6, a3, 124     ; last word of buffer', { at_: 6, as_: 3, off: 124 });
prog.insn('bnez', 'bnez  a6, buf_hit', { as_: 6, target: 'buf_hit' });
prog.insn('j', 'j     buf_next', { target: 'buf_next' });
prog.label('buf_hit');
prog.insn('addi', 'addi  a5, a5, -1      ; count the received chunk', { at_: 5, as_: 5, imm: -1 });
prog.insn('bnez', 'bnez  a5, buf_next', { as_: 5, target: 'buf_next' });
prog.insn('j', 'j     mic_ok', { target: 'mic_ok' });
prog.label('buf_next');
prog.insn('addi', 'addi  a2, a2, 12      ; next descriptor', { at_: 2, as_: 2, imm: 12 });
prog.insn('addi', 'addi  a3, a3, 64      ; next buffer (256 = 4x64)', { at_: 3, as_: 3, imm: 64 });
prog.insn('addi', 'addi  a3, a3, 64', { at_: 3, as_: 3, imm: 64 });
prog.insn('addi', 'addi  a3, a3, 64', { at_: 3, as_: 3, imm: 64 });
prog.insn('addi', 'addi  a3, a3, 64', { at_: 3, as_: 3, imm: 64 });
prog.insn('addi', 'addi  a4, a4, -1', { at_: 4, as_: 4, imm: -1 });
prog.insn('bnez', 'bnez  a4, buf_loop', { as_: 4, target: 'buf_loop' });
prog.insn('j', 'j     poll               ; re-scan from d0', { target: 'poll' });

prog.label('mic_ok');
print('L_msg_ok', MSG_OK.length, 'ok');

prog.label('hang');
prog.insn('j', 'j     hang', { target: 'hang' });

prog.assemble();

const entry = prog.symbols[0].value;
const elf = buildElf(IRAM_BASE, prog.image, entry, prog.symbols);
elfSanity(elf, entry);
const sha256 = createHash('sha256').update(elf).digest('hex');

const report = () => {
  const sck = 160_000_000 / 25;
  const bck = sck / 12;
  const ws = bck / 16; // mono: ws = bck / bits
  log(`image ${prog.image.length} bytes, ELF ${elf.length} bytes, sha256 ${sha256}`);
  log(`rx: ${DESC_COUNT}x${BUF_SIZE}B ring, sample rate ${ws.toFixed(1)} Hz (16-bit mono)`);
  log(`CLKM_CONF=0x${CLKM_CONF_VAL.toString(16)} SRATE_CONF=0x${SRATE_CONF_VAL.toString(16)} CONF=0x${CONF_RUN.toString(16)} IN_LINK=0x${IN_LINK_RUN.toString(16)}`);
  for (const s of prog.symbols) log(`symbol ${s.name} = 0x${s.value.toString(16)} (size ${s.size})`);
};

const checkMode = process.argv.includes('--check');
if (checkMode) {
  let existing;
  try {
    existing = await readFile(FIXTURE);
  } catch {
    console.error(`[make-mic-elf] fixture missing: ${relative(REPO_ROOT, FIXTURE)}. Run without --check to create it.`);
    process.exit(1);
  }
  if (!existing.equals(elf)) {
    console.error(`[make-mic-elf] fixture is stale: ${relative(REPO_ROOT, FIXTURE)} differs from regenerated output.`);
    process.exit(1);
  }
  log(`fixture up to date (${elf.length} bytes, sha256 ${sha256})`);
} else {
  await mkdir(dirname(FIXTURE), { recursive: true });
  await writeFile(FIXTURE, elf);
  log(`wrote ${relative(REPO_ROOT, FIXTURE)}`);
  report();
}
