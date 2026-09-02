// PRD: §9 — Golden firmware builder: packages/sim-core/fixtures/speaker.elf
// (dev-plan task P2.4). Deterministically assembles a tiny Xtensa LX6 program
// that streams a sine wave through the ESP32 I2S0 TX DMA engine (the speaker
// acceptance scenario):
//
//   1. Builds one 64-byte PCM buffer in DRAM: 16 frames of a full sine period
//      (16-bit stereo, L=R, amplitude 0.6 full-scale, little-endian).
//   2. Builds a two-descriptor DMA ring (lldesc_t, both pointing at the same
//      buffer, d0 -> d1 -> d0) so playback sustains forever.
//   3. Configures I2S0: CLKM div 25 (160MHz PLL -> 6.4MHz sck), BCK div 12
//      (533.33kHz), 16 bits/channel stereo -> 16.667kHz sample rate; the sine
//      therefore sounds at 16666.7/16 = 1041.7Hz. OUT_LINK start + TX_START
//      kick the DMA engine.
//   4. Prints "SPK SINE\r\n" on UART0 and hangs (the ring keeps streaming).
//
// The breadesp-dbus I2S shadow decodes the clock config, walks the descriptor
// ring at the PCM byte rate and forwards the samples as `i2s` transactions.
//
// Usage: node scripts/make-speaker-elf.mjs [--check]
//   default: (re)write the fixture. --check: verify the committed fixture is up to date.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Program, buildElf, elfSanity } from './lib/xtensa-elf.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const FIXTURE = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'speaker.elf');
const log = (msg) => console.log(`[make-speaker-elf] ${msg}`);

// --- ESP32 memory-mapped registers / DRAM scratch used by the firmware ---
const IRAM_BASE = 0x40080000; // ESP32 IRAM; the single PT_LOAD segment is mapped here
const UART0_FIFO = 0x3ff40000; // UART0 UART_FIFO_REG: byte writes transmit
const I2S0_BASE = 0x3ff4f000; // DR_REG_I2S_BASE
const I2S_CONF = I2S0_BASE + 0x08;
const I2S_OUT_LINK = I2S0_BASE + 0x30;
const I2S_CLKM_CONF = I2S0_BASE + 0xac;
const I2S_SAMPLE_RATE_CONF = I2S0_BASE + 0xb0;
// Top of DRAM (0x3ffae000..0x3fffffff): clear of the ROM stack and the IRAM image.
const DMA_BUF = 0x3fff8000; // 64-byte PCM buffer
const DESC_BASE = 0x3fff9000; // two 12-byte lldesc_t descriptors

// --- Waveform / clock field values (ESP32 TRM, esp-idf i2s_reg.h) ---
const FRAMES = 16; // one full sine period per buffer
const AMPLITUDE = Math.round(0.6 * 32767); // 19660
const SINE = Array.from({ length: FRAMES }, (_, i) =>
  Math.round(AMPLITUDE * Math.sin((2 * Math.PI * i) / FRAMES)));
// Stereo word: same s16le sample in both halfwords (L = R).
const sineWord = (s) => (((s & 0xffff) | ((s & 0xffff) << 16)) >>> 0);

const CLKM_CONF_VAL = (25 | (1 << 20) | (2 << 21)) >>> 0; // div 25, CLK_EN, CLK_SEL=PLL160
const SRATE_CONF_VAL = ((12 << 6) | (16 << 18)) >>> 0; // bck div 12, 16 bits/channel
const CONF_RESET = 0x000a; // TX_RESET | TX_FIFO_RESET
const CONF_RUN = (1 << 5) | (1 << 11); // TX_START | TX_MSB_SHIFT
const OUT_LINK_RUN = ((DESC_BASE & 0xfffff) | (1 << 29)) >>> 0; // addr + START
const LLDESC_W0 = (64 | (64 << 12) | (1 << 31)) >>> 0; // size=length=64, owner=DMA

const MSG = Buffer.from('SPK SINE\r\n', 'ascii');

// --- Firmware program -------------------------------------------------------
const prog = new Program(IRAM_BASE);
const L = {
  uart: prog.literal('L_uart', UART0_FIFO),
  dmaBuf: prog.literal('L_dma_buf', DMA_BUF),
  desc0: prog.literal('L_desc0', DESC_BASE),
  desc1: prog.literal('L_desc1', DESC_BASE + 12),
  conf: prog.literal('L_conf', I2S_CONF),
  outLink: prog.literal('L_out_link', I2S_OUT_LINK),
  clkm: prog.literal('L_clkm', I2S_CLKM_CONF),
  srate: prog.literal('L_srate', I2S_SAMPLE_RATE_CONF),
  clkmVal: prog.literal('L_clkm_val', CLKM_CONF_VAL),
  srateVal: prog.literal('L_srate_val', SRATE_CONF_VAL),
  confReset: prog.literal('L_conf_reset', CONF_RESET),
  confRun: prog.literal('L_conf_run', CONF_RUN),
  outLinkRun: prog.literal('L_out_link_run', OUT_LINK_RUN),
  lldescW0: prog.literal('L_lldesc_w0', LLDESC_W0),
  msg: prog.literal('L_msg', (A) => A('S_msg')),
  sine: SINE.map((_, i) => prog.literal(`L_sine${i}`, sineWord(SINE[i]))),
};
prog.string('S_msg', MSG);

// `store <value literal> -> <address literal> + offset`: a13 = value, a14 = address.
const store = (valLit, addrLit, offset, what) => {
  prog.insn('l32r', `l32r  a13, ${valLit.padEnd(14)}; ${what}`, { at_: 13, lit: valLit });
  prog.insn('l32r', `l32r  a14, ${addrLit.padEnd(14)}`, { at_: 14, lit: addrLit });
  prog.insn('s32i', `s32i  a13, a14, ${offset}`, { at_: 13, as_: 14, off: offset });
};

prog.label('_start');
prog.insn('l32r', 'l32r  a8, L_uart       ; a8 = UART0 FIFO', { at_: 8, lit: L.uart });

prog.label('app_main');
// PCM buffer: 16 stereo words, one sine period.
prog.insn('l32r', 'l32r  a14, L_dma_buf    ; a14 = DMA buffer', { at_: 14, lit: L.dmaBuf });
for (let i = 0; i < FRAMES; i++) {
  prog.insn('l32r', `l32r  a13, ${`L_sine${i}`.padEnd(14)}; frame ${i} (L=R)`, { at_: 13, lit: `L_sine${i}` });
  prog.insn('s32i', `s32i  a13, a14, ${i * 4}`, { at_: 13, as_: 14, off: i * 4 });
}
// Descriptor ring: d0 -> d1 -> d0, both over the same buffer. lldesc_t is
// { w0 (size/len/owner), buf, next } — three words each.
store('L_lldesc_w0', 'L_desc0', 0, 'd0: size=64 len=64 owner=DMA');
store('L_dma_buf', 'L_desc0', 4, 'd0: buf');
store('L_desc1', 'L_desc0', 8, 'd0: next -> d1');
store('L_lldesc_w0', 'L_desc1', 0, 'd1: size=64 len=64 owner=DMA');
store('L_dma_buf', 'L_desc1', 4, 'd1: buf');
store('L_desc0', 'L_desc1', 8, 'd1: next -> d0 (ring)');

// I2S0 clock + format, then start the DMA engine and TX.
store('L_clkm_val', 'L_clkm', 0, 'CLKM: div 25, CLK_EN, PLL160');
store('L_srate_val', 'L_srate', 0, 'BCK div 12, 16 bits/channel');
store('L_conf_reset', 'L_conf', 0, 'TX reset pulse');
store('L_conf_run', 'L_conf', 0, 'TX_START | TX_MSB_SHIFT');
store('L_out_link_run', 'L_out_link', 0, 'OUT_LINK addr + START');

// `print <literal string>`: a10 = cursor, a11 = remaining, a12 = char, a8 = UART0.
prog.insn('l32r', 'l32r  a10, L_msg        ; a10 = message', { at_: 10, lit: L.msg });
prog.insn('movi', `movi  a11, ${MSG.length}         ; remaining chars`, { at_: 11, imm: MSG.length });
prog.label('next_char');
prog.insn('l8ui', 'l8ui  a12, a10, 0     ; load char', { at_: 12, as_: 10, off: 0 });
prog.insn('s8i', 's8i   a12, a8, 0       ; UART0 TX', { at_: 12, as_: 8, off: 0 });
prog.insn('addi', 'addi  a10, a10, 1     ; advance cursor', { at_: 10, as_: 10, imm: 1 });
prog.insn('addi', 'addi  a11, a11, -1    ; countdown', { at_: 11, as_: 11, imm: -1 });
prog.insn('bnez', 'bnez  a11, next_char', { as_: 11, target: 'next_char' });

prog.label('hang');
prog.insn('j', 'j     hang               ; keep the stream running', { target: 'hang' });

prog.assemble();

const entry = prog.symbols[0].value;
const elf = buildElf(IRAM_BASE, prog.image, entry, prog.symbols);
elfSanity(elf, entry);
const sha256 = createHash('sha256').update(elf).digest('hex');

const report = () => {
  const sck = 160_000_000 / 25;
  const bck = sck / 12;
  const ws = bck / 32;
  log(`image ${prog.image.length} bytes, ELF ${elf.length} bytes, sha256 ${sha256}`);
  log(`pcm: ${FRAMES} frames/period, amplitude ${AMPLITUDE}, sample rate ${ws.toFixed(1)} Hz, sine ${(ws / FRAMES).toFixed(1)} Hz`);
  log(`CLKM_CONF=0x${CLKM_CONF_VAL.toString(16)} SRATE_CONF=0x${SRATE_CONF_VAL.toString(16)} OUT_LINK=0x${OUT_LINK_RUN.toString(16)}`);
  for (const s of prog.symbols) log(`symbol ${s.name} = 0x${s.value.toString(16)} (size ${s.size})`);
};

const checkMode = process.argv.includes('--check');
if (checkMode) {
  let existing;
  try {
    existing = await readFile(FIXTURE);
  } catch {
    console.error(`[make-speaker-elf] fixture missing: ${relative(REPO_ROOT, FIXTURE)}. Run without --check to create it.`);
    process.exit(1);
  }
  if (!existing.equals(elf)) {
    console.error(`[make-speaker-elf] fixture is stale: ${relative(REPO_ROOT, FIXTURE)} differs from regenerated output.`);
    process.exit(1);
  }
  log(`fixture up to date (${elf.length} bytes, sha256 ${sha256})`);
} else {
  await mkdir(dirname(FIXTURE), { recursive: true });
  await writeFile(FIXTURE, elf);
  log(`wrote ${relative(REPO_ROOT, FIXTURE)}`);
  report();
}
