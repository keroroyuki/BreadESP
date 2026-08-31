// PRD: §F-SER-2 — Golden firmware builder: packages/sim-core/fixtures/uart-echo.elf (dev-plan task P1.10).
// Deterministically assembles a tiny Xtensa LX6 program for the ESP32 that proves the
// UART0 RX path end to end:
//
//   1. prints "UART echo ready\r\n" on boot (TX warm-up, e2e gate),
//   2. polls UART_STATUS.RXFIFO_CNT (bits [7:0], offset 0x1C — hw/char/esp32_uart.c
//      reports exactly RXFIFO_CNT | TXFIFO_CNT<<16, and TX drains synchronously),
//   3. pops bytes from UART_FIFO (offset 0x0; reads dequeue RX) into a 127-byte line
//      buffer,
//   4. on '\n' prints "ECHO: <line>\r\n" and resets the buffer — the typed line
//      (Enter included) demonstrably reached the firmware.
//
// QEMU wires UART0 to the `-serial stdio` chardev; on Windows the pipe-stdin backend
// (char-win-stdio.c win_stdio_thread) forwards bytes 1-by-1 but DROPS '\r', so the
// console/UI always terminates lines with '\n' only.
//
// Usage: node scripts/make-uart-echo-elf.mjs [--check]
//   default: (re)write the fixture. --check: verify the committed fixture is up to date.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Program, buildElf, elfSanity } from './lib/xtensa-elf.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const FIXTURE = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'uart-echo.elf');
const log = (msg) => console.log(`[make-uart-echo-elf] ${msg}`);

// --- ESP32 memory-mapped registers used by the firmware (per ESP-IDF soc headers) ---
const IRAM_BASE = 0x40080000; // ESP32 IRAM; the single PT_LOAD segment is mapped here
const UART0_BASE = 0x3ff40000; // UART0 (blink.elf TXes through the same FIFO register)
const UART_STATUS_OFF = 0x1c; // UART_STATUS_REG: RXFIFO_CNT bits [7:0]
const LF = 0x0a; // '\n' — the only line terminator this fixture recognises
const LINE_MAX = 127; // line buffer capacity (128-byte blob, one guard byte)
const BANNER = Buffer.from('UART echo ready\r\n', 'ascii');
const ECHO_PREFIX = Buffer.from('ECHO: ', 'ascii');

// --- Firmware program ----------------------------------------------------------------------
const prog = new Program(IRAM_BASE);
const L = {
  uart: prog.literal('L_uart', UART0_BASE),
  banner: prog.literal('L_banner', (A) => A('S_banner')),
  echo: prog.literal('L_echo', (A) => A('S_echo')),
  buf: prog.literal('L_buf', (A) => A('D_line_buf')),
};
prog.string('S_banner', BANNER);
prog.string('S_echo', ECHO_PREFIX);
// 128-byte writable line buffer (32 words): the write cursor's home for stored bytes.
prog.data('D_line_buf', Buffer.alloc(128));

prog.label('_start');
prog.insn('l32r', 'l32r  a8, L_uart      ; a8 = UART0 base', { at_: 8, lit: L.uart });
prog.insn('l32r', 'l32r  a10, L_buf     ; a10 = write cursor = line buffer', { at_: 10, lit: L.buf });
prog.insn('movi', 'movi  a11, 0         ; a11 = line length = 0', { at_: 11, imm: 0 });

prog.label('app_main');
// 1. banner: "UART echo ready\r\n"
prog.insn('l32r', 'l32r  a14, L_banner  ; a14 = banner cursor', { at_: 14, lit: L.banner });
prog.insn('movi', 'movi  a15, 17        ; banner length', { at_: 15, imm: BANNER.length });
prog.label('banner_loop');
prog.insn('bnez', 'bnez  a15, banner_one', { as_: 15, target: 'banner_one' });
prog.insn('j', 'j     poll           ; banner drained', { target: 'poll' });
prog.label('banner_one');
prog.insn('l8ui', 'l8ui  a12, a14, 0    ; load banner char', { at_: 12, as_: 14, off: 0 });
prog.insn('s8i', 's8i   a12, a8, 0      ; UART0 TX', { at_: 12, as_: 8, off: 0 });
prog.insn('addi', 'addi  a14, a14, 1     ; advance cursor', { at_: 14, as_: 14, imm: 1 });
prog.insn('addi', 'addi  a15, a15, -1    ; countdown', { at_: 15, as_: 15, imm: -1 });
prog.insn('j', 'j     banner_loop', { target: 'banner_loop' });

// 2. poll UART_STATUS until the RX FIFO has bytes.
prog.label('poll');
prog.insn('l32i', 'l32i  a9, a8, 0x1c   ; a9 = UART_STATUS (RXFIFO_CNT bits[7:0])', { at_: 9, as_: 8, off: UART_STATUS_OFF });
prog.insn('bnez', 'bnez  a9, have_data  ; RX pending', { as_: 9, target: 'have_data' });
prog.insn('j', 'j     poll', { target: 'poll' });

// 3. pop one RX byte; '\n' terminates the line (addi+bnez == compare-with-zero).
prog.label('have_data');
prog.insn('l8ui', 'l8ui  a12, a8, 0     ; a12 = byte from RX FIFO', { at_: 12, as_: 8, off: 0 });
prog.insn('addi', 'addi  a13, a12, -10   ; a13 = byte - LF', { at_: 13, as_: 12, imm: -LF });
prog.insn('bnez', 'bnez  a13, store_char ; not newline -> buffer it', { as_: 13, target: 'store_char' });

// 4a. newline: print "ECHO: " + buffered line + "\r\n", reset cursor/length.
prog.insn('l32r', 'l32r  a14, L_echo    ; a14 = "ECHO: " cursor', { at_: 14, lit: L.echo });
prog.insn('movi', 'movi  a15, 6         ; prefix length', { at_: 15, imm: ECHO_PREFIX.length });
prog.label('echo_loop');
prog.insn('bnez', 'bnez  a15, echo_one', { as_: 15, target: 'echo_one' });
prog.insn('j', 'j     flush_buf', { target: 'flush_buf' });
prog.label('echo_one');
prog.insn('l8ui', 'l8ui  a12, a14, 0    ; load prefix char', { at_: 12, as_: 14, off: 0 });
prog.insn('s8i', 's8i   a12, a8, 0      ; UART0 TX', { at_: 12, as_: 8, off: 0 });
prog.insn('addi', 'addi  a14, a14, 1', { at_: 14, as_: 14, imm: 1 });
prog.insn('addi', 'addi  a15, a15, -1', { at_: 15, as_: 15, imm: -1 });
prog.insn('j', 'j     echo_loop', { target: 'echo_loop' });

prog.label('flush_buf');
prog.insn('l32r', 'l32r  a14, L_buf     ; a14 = read cursor', { at_: 14, lit: L.buf });
prog.label('flush_loop');
prog.insn('bnez', 'bnez  a11, flush_one ; more buffered bytes', { as_: 11, target: 'flush_one' });
prog.insn('j', 'j     flush_crlf', { target: 'flush_crlf' });
prog.label('flush_one');
prog.insn('l8ui', 'l8ui  a12, a14, 0    ; load buffered char', { at_: 12, as_: 14, off: 0 });
prog.insn('s8i', 's8i   a12, a8, 0      ; UART0 TX', { at_: 12, as_: 8, off: 0 });
prog.insn('addi', 'addi  a14, a14, 1', { at_: 14, as_: 14, imm: 1 });
prog.insn('addi', 'addi  a11, a11, -1', { at_: 11, as_: 11, imm: -1 });
prog.insn('j', 'j     flush_loop', { target: 'flush_loop' });

prog.label('flush_crlf');
prog.insn('movi', 'movi  a12, 13        ; CR', { at_: 12, imm: 13 });
prog.insn('s8i', 's8i   a12, a8, 0', { at_: 12, as_: 8, off: 0 });
prog.insn('movi', 'movi  a12, 10        ; LF', { at_: 12, imm: 10 });
prog.insn('s8i', 's8i   a12, a8, 0', { at_: 12, as_: 8, off: 0 });
prog.insn('l32r', 'l32r  a10, L_buf     ; reset write cursor', { at_: 10, lit: L.buf });
prog.insn('movi', 'movi  a11, 0         ; reset line length', { at_: 11, imm: 0 });
prog.insn('j', 'j     poll', { target: 'poll' });

// 3b. ordinary byte: append to the line buffer (drop when full — Enter still flushes).
prog.label('store_char');
prog.insn('addi', 'addi  a13, a11, -127 ; a13 = len - LINE_MAX', { at_: 13, as_: 11, imm: -LINE_MAX });
prog.insn('bnez', 'bnez  a13, store_it  ; buffer not full', { as_: 13, target: 'store_it' });
prog.insn('j', 'j     poll             ; full -> drop byte', { target: 'poll' });
prog.label('store_it');
prog.insn('s8i', 's8i   a12, a10, 0    ; line_buf[len] = byte', { at_: 12, as_: 10, off: 0 });
prog.insn('addi', 'addi  a10, a10, 1    ; write cursor++', { at_: 10, as_: 10, imm: 1 });
prog.insn('addi', 'addi  a11, a11, 1    ; line length++', { at_: 11, as_: 11, imm: 1 });
prog.insn('j', 'j     poll', { target: 'poll' });

prog.assemble();

const entry = prog.symbols[0].value;
const symbols = [
  ...prog.symbols,
  { name: 'line_buf', value: prog.addressOf('D_line_buf'), size: 128, type: 'object' },
];
const elf = buildElf(IRAM_BASE, prog.image, entry, symbols);
elfSanity(elf, entry);
const sha256 = createHash('sha256').update(elf).digest('hex');

const report = () => {
  log(`image ${prog.image.length} bytes, ELF ${elf.length} bytes, sha256 ${sha256}`);
  for (const s of symbols) log(`symbol ${s.name} = 0x${s.value.toString(16)} (size ${s.size})`);
  log('disassembly:');
  for (const line of prog.listing) console.log(line);
};

const checkMode = process.argv.includes('--check');
if (checkMode) {
  let existing;
  try {
    existing = await readFile(FIXTURE);
  } catch {
    console.error(`[make-uart-echo-elf] fixture missing: ${relative(REPO_ROOT, FIXTURE)}. Run without --check to create it.`);
    process.exit(1);
  }
  if (!existing.equals(elf)) {
    console.error(`[make-uart-echo-elf] fixture is stale: ${relative(REPO_ROOT, FIXTURE)} differs from regenerated output.`);
    process.exit(1);
  }
  log(`fixture up to date (${elf.length} bytes, sha256 ${sha256})`);
} else {
  await mkdir(dirname(FIXTURE), { recursive: true });
  await writeFile(FIXTURE, elf);
  log(`wrote ${relative(REPO_ROOT, FIXTURE)}`);
  report();
}
