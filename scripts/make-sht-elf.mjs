// PRD: §9 — Golden firmware builder: packages/sim-core/fixtures/sht.elf (dev-plan task P3.4).
// Deterministically assembles a tiny Xtensa LX6 program for the ESP32 that verifies
// the i2c-out read-reply reverse channel ({"kind":"i2c-out",...}): it drives the
// esp32.i2c0 controller (hw/i2c/esp32_i2c.c) to a SHT30 at 0x44 —
//
//   transfer 1: WRITE [0x88, 0x2C, 0x06]  (addr|W + "measure, high repeatability")
//   then up to 250 attempts: WRITE [0x89] + READ 6 + STOP, popping the 6 RX FIFO
//   bytes and comparing them against the expected readout for 25.0°C / 50%RH.
//
// The retry loop is load-bearing: the command write only reaches the bridge-side
// model after the synchronous TRANS_START completes (the reply cannot already be
// in the device mailbox during the same transfer), so early attempts observe the
// empty-mailbox 0xFF bytes until the model's i2c-out reply lands — then one
// attempt matches and the firmware prints "SHT OK\r\n". Exhaustion prints
// "SHT FAIL\r\n". Both markers gate the e2e.
//
// The expected bytes are computed here with the SHT30 datasheet formulas/CRC —
// the model (packages/peripherals/src/sht30.ts) is the contract source of truth
// and its unit tests pin the same vectors, so fixture and model cannot drift.
//
// Usage: node scripts/make-sht-elf.mjs [--check]
//   default: (re)write the fixture. --check: verify the committed fixture is up to date.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Program, buildElf, elfSanity } from './lib/xtensa-elf.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const FIXTURE = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'sht.elf');
const log = (msg) => console.log(`[make-sht-elf] ${msg}`);

// --- Scenario constants (the e2e netlist uses the same props) ---
const SHT_ADDR = 0x44;
const TEMP_C = 25;
const HUM_RH = 50;
const RETRY_COUNT = 250;
const RETRY_DELAY = 100000; // busy-loop iterations between attempts

// --- ESP32 memory-mapped registers ---
const IRAM_BASE = 0x40080000;
const UART0_FIFO = 0x3ff40000;
const I2C0 = 0x3ff53000; // DR_REG_I2C_EXT_BASE: esp32.i2c controller #0

// --- esp32.i2c register offsets (hw/i2c/esp32_i2c.h) ---
const I2C_CTR = 0x04; // TRANS_START(bit5) | MS_MODE(bit4)
const I2C_FIFO_DATA = 0x1c;
const I2C_CMD0 = 0x58;
const I2C_CMD1 = 0x5c;
const I2C_CMD2 = 0x60;

// I2C_CMD fields: OPCODE bits 11..13, BYTE_NUM bits 0..7 (esp32_i2c.h).
const OPCODE_WRITE = 1;
const OPCODE_READ = 2;
const OPCODE_STOP = 3;
const CMD_WRITE3 = (OPCODE_WRITE << 11) | 3; // addr byte + 2 command bytes
const CMD_WRITE1 = (OPCODE_WRITE << 11) | 1; // addr byte only (read header)
const CMD_READ6 = (OPCODE_READ << 11) | 6;
const CMD_STOP = OPCODE_STOP << 11;
const CTR_TRANS_START = (1 << 5) | (1 << 4); // TRANS_START | MS_MODE

// --- Expected readout for TEMP_C / HUM_RH (SHT30 datasheet §4.12/§4.13) ---
// Keep in sync with packages/peripherals/src/sht30.ts (model unit tests pin
// the same vectors).
function crc8(msb, lsb) {
  let crc = 0xff;
  for (const byte of [msb, lsb]) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}
function measurementBytes(tempC, humRh) {
  const rawT = Math.round(((tempC + 45) / 175) * 65535);
  const rawH = Math.round((humRh / 100) * 65535);
  const tMsb = (rawT >> 8) & 0xff, tLsb = rawT & 0xff;
  const hMsb = (rawH >> 8) & 0xff, hLsb = rawH & 0xff;
  return [tMsb, tLsb, crc8(tMsb, tLsb), hMsb, hLsb, crc8(hMsb, hLsb)];
}
const EXPECTED = measurementBytes(TEMP_C, HUM_RH);

const MSG_OK = Buffer.from('SHT OK\r\n', 'ascii');
const MSG_FAIL = Buffer.from('SHT FAIL\r\n', 'ascii');

// --- Firmware program ----------------------------------------------------------------------
// Register plan: a8=UART0, a9=I2C0 base, a15=attempts, a10-a14+a7 = the six
// read bytes, a5/a6 scratch. print clobbers a10-a12 (used only outside the loop).
const prog = new Program(IRAM_BASE);
const L = {
  uart: prog.literal('L_uart', UART0_FIFO),
  i2c: prog.literal('L_i2c', I2C0),
  cmdW3: prog.literal('L_cmd_w3', CMD_WRITE3),
  cmdW1: prog.literal('L_cmd_w1', CMD_WRITE1),
  cmdR6: prog.literal('L_cmd_r6', CMD_READ6),
  cmdStop: prog.literal('L_cmd_stop', CMD_STOP),
  ctr: prog.literal('L_ctr', CTR_TRANS_START),
  delay: prog.literal('L_delay', RETRY_DELAY),
  exp: EXPECTED.map((b, i) => prog.literal(`L_exp${i}`, b)),
  msgOk: prog.literal('L_msg_ok', (A) => A('S_msg_ok')),
  msgFail: prog.literal('L_msg_fail', (A) => A('S_msg_fail')),
};
prog.string('S_msg_ok', MSG_OK);
prog.string('S_msg_fail', MSG_FAIL);

/** `print <string>`: a10 = cursor, a11 = remaining, a12 = char, a8 = UART0. */
const print = (litName, bytes, loopLabel) => {
  prog.insn('l32r', `l32r  a10, ${litName.padEnd(14)}; a10 = message`, { at_: 10, lit: litName });
  prog.insn('movi', `movi  a11, ${bytes.length}         ; remaining chars`, { at_: 11, imm: bytes.length });
  prog.label(loopLabel);
  prog.insn('l8ui', 'l8ui  a12, a10, 0     ; load char', { at_: 12, as_: 10, off: 0 });
  prog.insn('s8i', 's8i   a12, a8, 0       ; UART0 TX', { at_: 12, as_: 8, off: 0 });
  prog.insn('addi', 'addi  a10, a10, 1     ; advance cursor', { at_: 10, as_: 10, imm: 1 });
  prog.insn('addi', 'addi  a11, a11, -1    ; countdown', { at_: 11, as_: 11, imm: -1 });
  prog.insn('bnez', `bnez  a11, ${loopLabel}`, { as_: 11, target: loopLabel });
};

prog.label('_start');
prog.insn('l32r', 'l32r  a8, L_uart       ; a8 = UART0 FIFO', { at_: 8, lit: L.uart });
prog.insn('l32r', 'l32r  a9, L_i2c        ; a9 = I2C0 base', { at_: 9, lit: L.i2c });

prog.label('app_main');
// --- Transfer 1: measurement command 0x2C06 (write, STOP) ---
prog.insn('movi', `movi  a10, 0x${((SHT_ADDR << 1) | 0).toString(16)}        ; addr byte (W)`, { at_: 10, imm: (SHT_ADDR << 1) | 0 });
prog.insn('s32i', 's32i  a10, a9, 0x1c    ; I2C_FIFO_DATA', { at_: 10, as_: 9, off: I2C_FIFO_DATA });
prog.insn('movi', 'movi  a10, 0x2c        ; cmd MSB', { at_: 10, imm: 0x2c });
prog.insn('s32i', 's32i  a10, a9, 0x1c    ; I2C_FIFO_DATA', { at_: 10, as_: 9, off: I2C_FIFO_DATA });
prog.insn('movi', 'movi  a10, 0x06        ; cmd LSB (high repeatability)', { at_: 10, imm: 0x06 });
prog.insn('s32i', 's32i  a10, a9, 0x1c    ; I2C_FIFO_DATA', { at_: 10, as_: 9, off: I2C_FIFO_DATA });
prog.insn('l32r', 'l32r  a10, L_cmd_w3    ; WRITE 3', { at_: 10, lit: L.cmdW3 });
prog.insn('s32i', 's32i  a10, a9, 0x58    ; I2C_CMD[0]', { at_: 10, as_: 9, off: I2C_CMD0 });
prog.insn('l32r', 'l32r  a10, L_cmd_stop  ; STOP', { at_: 10, lit: L.cmdStop });
prog.insn('s32i', 's32i  a10, a9, 0x5c    ; I2C_CMD[1]', { at_: 10, as_: 9, off: I2C_CMD1 });
prog.insn('l32r', 'l32r  a10, L_ctr       ; TRANS_START | MS_MODE', { at_: 10, lit: L.ctr });
prog.insn('s32i', 's32i  a10, a9, 0x04    ; I2C_CTR: fires transfer 1', { at_: 10, as_: 9, off: I2C_CTR });
prog.insn('movi', `movi  a15, ${RETRY_COUNT}        ; read attempts`, { at_: 15, imm: RETRY_COUNT });

prog.label('retry');
// --- Transfer 2: read header + READ 6 + STOP ---
prog.insn('movi', `movi  a10, 0x${((SHT_ADDR << 1) | 1).toString(16)}        ; addr byte (R)`, { at_: 10, imm: (SHT_ADDR << 1) | 1 });
prog.insn('s32i', 's32i  a10, a9, 0x1c    ; I2C_FIFO_DATA', { at_: 10, as_: 9, off: I2C_FIFO_DATA });
prog.insn('l32r', 'l32r  a10, L_cmd_w1    ; WRITE 1 (read header)', { at_: 10, lit: L.cmdW1 });
prog.insn('s32i', 's32i  a10, a9, 0x58    ; I2C_CMD[0]', { at_: 10, as_: 9, off: I2C_CMD0 });
prog.insn('l32r', 'l32r  a10, L_cmd_r6    ; READ 6', { at_: 10, lit: L.cmdR6 });
prog.insn('s32i', 's32i  a10, a9, 0x5c    ; I2C_CMD[1]', { at_: 10, as_: 9, off: I2C_CMD1 });
prog.insn('l32r', 'l32r  a10, L_cmd_stop  ; STOP', { at_: 10, lit: L.cmdStop });
prog.insn('s32i', 's32i  a10, a9, 0x60    ; I2C_CMD[2]', { at_: 10, as_: 9, off: I2C_CMD2 });
prog.insn('l32r', 'l32r  a10, L_ctr       ; TRANS_START | MS_MODE', { at_: 10, lit: L.ctr });
prog.insn('s32i', 's32i  a10, a9, 0x04    ; I2C_CTR: fires transfer 2', { at_: 10, as_: 9, off: I2C_CTR });
// Pop the six RX FIFO bytes into a10..a14, a7 (READ pushes exactly 6 per attempt).
prog.insn('l32i', 'l32i  a10, a9, 0x1c    ; b0 (T msb)', { at_: 10, as_: 9, off: I2C_FIFO_DATA });
prog.insn('l32i', 'l32i  a11, a9, 0x1c    ; b1 (T lsb)', { at_: 11, as_: 9, off: I2C_FIFO_DATA });
prog.insn('l32i', 'l32i  a12, a9, 0x1c    ; b2 (T crc)', { at_: 12, as_: 9, off: I2C_FIFO_DATA });
prog.insn('l32i', 'l32i  a13, a9, 0x1c    ; b3 (H msb)', { at_: 13, as_: 9, off: I2C_FIFO_DATA });
prog.insn('l32i', 'l32i  a14, a9, 0x1c    ; b4 (H lsb)', { at_: 14, as_: 9, off: I2C_FIFO_DATA });
prog.insn('l32i', 'l32i  a7,  a9, 0x1c    ; b5 (H crc)', { at_: 7, as_: 9, off: I2C_FIFO_DATA });
// Compare against the expected readout; any mismatch retries after a delay.
const byteRegs = [10, 11, 12, 13, 14, 7];
byteRegs.forEach((reg, i) => {
  prog.insn('l32r', `l32r  a5, L_exp${i}        ; expected b${i} = 0x${EXPECTED[i].toString(16).padStart(2, '0')}`, { at_: 5, lit: L.exp[i] });
  prog.insn('sub', `sub   a6, a${reg}, a5`, { at_: 6, as_: reg, t_: 5 });
  prog.insn('bnez', `bnez  a6, mismatch`, { as_: 6, target: 'mismatch' });
});
print('L_msg_ok', MSG_OK, 'ok_loop');
prog.insn('j', 'j     hang', { target: 'hang' });

prog.label('mismatch');
prog.insn('l32r', 'l32r  a5, L_delay      ; inter-attempt delay', { at_: 5, lit: L.delay });
prog.label('delay');
prog.insn('addi', 'addi  a5, a5, -1', { at_: 5, as_: 5, imm: -1 });
prog.insn('bnez', 'bnez  a5, delay', { as_: 5, target: 'delay' });
prog.insn('addi', 'addi  a15, a15, -1     ; attempts left', { at_: 15, as_: 15, imm: -1 });
prog.insn('bnez', 'bnez  a15, retry', { as_: 15, target: 'retry' });
print('L_msg_fail', MSG_FAIL, 'fail_loop');
prog.label('hang');
prog.insn('j', 'j     hang', { target: 'hang' });

prog.assemble();

const entry = prog.symbols[0].value;
const elf = buildElf(IRAM_BASE, prog.image, entry, prog.symbols);
elfSanity(elf, entry);
const sha256 = createHash('sha256').update(elf).digest('hex');

const report = () => {
  log(`expected readout: [${EXPECTED.map((b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ')}]`);
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
    console.error(`[make-sht-elf] fixture missing: ${relative(REPO_ROOT, FIXTURE)}. Run without --check to create it.`);
    process.exit(1);
  }
  if (!existing.equals(elf)) {
    console.error(`[make-sht-elf] fixture is stale: ${relative(REPO_ROOT, FIXTURE)} differs from regenerated output.`);
    process.exit(1);
  }
  log(`fixture up to date (${elf.length} bytes, sha256 ${sha256})`);
} else {
  await mkdir(dirname(FIXTURE), { recursive: true });
  await writeFile(FIXTURE, elf);
  log(`wrote ${relative(REPO_ROOT, FIXTURE)}`);
  report();
}
