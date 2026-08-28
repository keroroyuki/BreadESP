// PRD: §9 — Golden firmware fixture invariants (dev-plan task P0.3 acceptance).
// packages/sim-core/fixtures/blink.elf is generated deterministically by
// scripts/make-blink-elf.mjs and executed by QEMU integration tests. These tests pin the
// contract downstream milestones rely on: a valid ELF32 LSB Xtensa executable, loadable at
// IRAM with symbols `_start`/`app_main` for GDB (M0), and the UART hello payload (task 0.4).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'blink.elf');
const EM_XTENSA = 94; // dev-plan task 0.6: e_machine == 0x5a
const IRAM_BASE = 0x40080000;
const ENTRY = 0x40080028; // _start
const IMAGE_SIZE = 136; // literal pool (24) + "Hello ESP32\r\n" (13) + pad (3) + code (96)
const IMAGE_FILE_OFFSET = 0x100;

const buf = readFileSync(FIXTURE_PATH);

interface SectionHeader {
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
    expect(appMain).toMatchObject({ value: 0x40080040, info: 0x12, shndx: 1 });
    expect(start!.size).toBe(appMain!.value - start!.value);
  });

  it('embeds the UART hello payload at the message literal', () => {
    const msg = buf.subarray(IMAGE_FILE_OFFSET + 0x18, IMAGE_FILE_OFFSET + 0x18 + 13);
    expect(msg.toString('ascii')).toBe('Hello ESP32\r\n');
  });
});
