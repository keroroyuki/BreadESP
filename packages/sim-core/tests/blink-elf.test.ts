// PRD: §9 — Golden firmware fixture invariants (dev-plan task P0.3 acceptance).
// packages/sim-core/fixtures/blink.elf is generated deterministically by
// scripts/make-blink-elf.mjs and executed by QEMU integration tests. These tests pin the
// contract downstream milestones rely on: a valid ELF32 LSB Xtensa executable, loadable at
// IRAM with symbols `_start`/`app_main` for GDB (M0), the UART hello payload (task 0.4),
// and the P1.9 debug surface (DWARF4 sections + the `led_state` global).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'blink.elf');
const EM_XTENSA = 94; // dev-plan task 0.6: e_machine == 0x5a
const IRAM_BASE = 0x40080000;
const ENTRY = 0x40080030; // _start
const APP_MAIN = 0x40080048;
const LED_STATE_ADDR = 0x4008002c; // global `led_state` home (P1.9)
const LED_STATE_INIT = 0xa5;
const IMAGE_SIZE = 168; // literal pool (28) + msg (13) + pad (3) + led_state (4) + code (120)
const IMAGE_FILE_OFFSET = 0x100;

const buf = readFileSync(FIXTURE_PATH);

interface SectionHeader {
  name: number;
  type: number;
  offset: number;
  size: number;
  link: number;
  entsize: number;
}

interface Symbol {
  name: string;
  value: number;
  size: number;
  info: number;
  shndx: number;
}

function readSectionHeaders(buffer: Buffer): SectionHeader[] {
  const shoff = buffer.readUInt32LE(0x20);
  const shentsize = buffer.readUInt16LE(0x2e);
  const shnum = buffer.readUInt16LE(0x30);
  const sections: SectionHeader[] = [];
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    sections.push({
      name: buffer.readUInt32LE(o),
      type: buffer.readUInt32LE(o + 4),
      offset: buffer.readUInt32LE(o + 16),
      size: buffer.readUInt32LE(o + 20),
      link: buffer.readUInt32LE(o + 24),
      entsize: buffer.readUInt32LE(o + 36),
    });
  }
  return sections;
}

function readCString(buffer: Buffer, offset: number): string {
  const end = buffer.indexOf(0, offset);
  return buffer.subarray(offset, end === -1 ? undefined : end).toString('ascii');
}

function readSymbols(buffer: Buffer): Map<string, Symbol> {
  const symtab = readSectionHeaders(buffer).find((s) => s.type === 2);
  if (!symtab) throw new Error('[BB-003] blink.elf has no .symtab section');
  const strtab = readSectionHeaders(buffer)[symtab.link];
  const symbols = new Map<string, Symbol>();
  const count = symtab.size / (symtab.entsize || 16);
  for (let i = 1; i < count; i++) {
    // i starts at 1: entry 0 is the reserved null symbol.
    const o = symtab.offset + i * symtab.entsize;
    const name = readCString(buffer, strtab.offset + buffer.readUInt32LE(o));
    symbols.set(name, {
      name,
      value: buffer.readUInt32LE(o + 4),
      size: buffer.readUInt32LE(o + 8),
      info: buffer[o + 12],
      shndx: buffer.readUInt16LE(o + 14),
    });
  }
  return symbols;
}

describe('golden firmware blink.elf', () => {
  it('exists and is an ELF32 little-endian Xtensa executable', () => {
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46])); // \x7fELF
    expect(buf[4]).toBe(1); // ELFCLASS32
    expect(buf[5]).toBe(1); // ELFDATA2LSB
    expect(buf[6]).toBe(1); // EV_CURRENT
    expect(buf.readUInt16LE(0x10)).toBe(2); // e_type = ET_EXEC
    expect(buf.readUInt16LE(0x12)).toBe(EM_XTENSA); // acceptance: file is an Xtensa ELF
  });

  it('carries one RWX PT_LOAD at IRAM with entry _start', () => {
    expect(buf.readUInt32LE(0x18)).toBe(ENTRY); // e_entry
    expect(buf.readUInt32LE(0x1c)).toBe(0x34); // e_phoff
    expect(buf.readUInt16LE(0x2c)).toBe(1); // e_phnum
    expect(buf.readUInt32LE(0x34)).toBe(1); // p_type = PT_LOAD
    expect(buf.readUInt32LE(0x38)).toBe(IMAGE_FILE_OFFSET); // p_offset
    expect(buf.readUInt32LE(0x3c)).toBe(IRAM_BASE); // p_vaddr
    expect(buf.readUInt32LE(0x40)).toBe(IRAM_BASE); // p_paddr
    expect(buf.readUInt32LE(0x44)).toBe(IMAGE_SIZE); // p_filesz
    expect(buf.readUInt32LE(0x48)).toBe(IMAGE_SIZE); // p_memsz (no bss)
    expect(buf.readUInt32LE(0x4c)).toBe(7); // p_flags = R | W | X
    expect(buf.readUInt32LE(0x50)).toBe(0x1000); // p_align
  });

  it('exposes _start and app_main FUNC symbols for GDB breakpoints', () => {
    const symbols = readSymbols(buf);
    const start = symbols.get('_start');
    const appMain = symbols.get('app_main');
    expect(start).toBeDefined();
    expect(appMain).toBeDefined();
    // info 0x12 = GLOBAL | FUNC; shndx 1 = .text
    expect(start).toMatchObject({ value: ENTRY, info: 0x12, shndx: 1 });
    expect(appMain).toMatchObject({ value: APP_MAIN, info: 0x12, shndx: 1 });
    expect(start!.size).toBe(appMain!.value - start!.value);
  });

  it('exposes the P1.9 debug surface: led_state global and e2e breakpoint label', () => {
    const symbols = readSymbols(buf);
    // info 0x11 = GLOBAL | OBJECT; the debug panel reads/writes this via GDB.
    expect(symbols.get('led_state')).toMatchObject({
      value: LED_STATE_ADDR, size: 4, info: 0x11, shndx: 1,
    });
    // Label right after `led_state = 1` — the e2e stops here and asserts the write.
    expect(symbols.get('led_state_written')).toMatchObject({
      value: 0x40080078, info: 0x12, shndx: 1,
    });
    // The global's recognizable initial value rides in the RWX PT_LOAD image.
    expect(buf.readUInt32LE(IMAGE_FILE_OFFSET + (LED_STATE_ADDR - IRAM_BASE))).toBe(LED_STATE_INIT);
  });

  it('embeds the UART hello payload at the message literal', () => {
    const msg = buf.subarray(IMAGE_FILE_OFFSET + 0x1c, IMAGE_FILE_OFFSET + 0x1c + 13);
    expect(msg.toString('ascii')).toBe('Hello ESP32\r\n');
  });

  it('carries DWARF4 debug info naming the app_main locals (P1.9)', () => {
    const sections = readSectionHeaders(buf);
    // Section names come from .shstrtab (index e_shstrndx = 4).
    const shstrtab = sections[buf.readUInt16LE(0x32)];
    const names = sections.map((s) => readCString(buf, shstrtab.offset + s.name));
    expect(names).toContain('.debug_info');
    expect(names).toContain('.debug_abbrev');
    const debugInfo = sections[names.indexOf('.debug_info')];
    const info = buf.subarray(debugInfo.offset, debugInfo.offset + debugInfo.size);
    // CU header: DWARF version 4, 32-bit addresses; then the DIE tree.
    expect(info.readUInt16LE(4)).toBe(4);
    expect(info[10]).toBe(4);
    // The locals the debug panel shows for app_main, plus the global.
    for (const name of ['app_main', 'msg_cursor', 'remaining', 'delay_ticks', 'led_state']) {
      expect(info.includes(Buffer.from(`${name}\0`, 'ascii'))).toBe(true);
    }
    // DW_OP_regx (0x90) locations: a10, a11, a15 register numbers follow it.
    expect(info.includes(Buffer.from([0x90, 10], 'binary'))).toBe(true);
    expect(info.includes(Buffer.from([0x90, 11], 'binary'))).toBe(true);
    expect(info.includes(Buffer.from([0x90, 15], 'binary'))).toBe(true);
    // DW_OP_addr (0x03) location of the led_state global.
    const addrLe = Buffer.alloc(4);
    addrLe.writeUInt32LE(LED_STATE_ADDR, 0);
    expect(info.includes(Buffer.concat([Buffer.from([0x03]), addrLe]))).toBe(true);
  });
});
