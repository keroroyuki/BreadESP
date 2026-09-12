// PRD: §F-FW-5, §9 — ELF architecture validation (dev-plan task P0.6).
// Acceptance: a golden Xtensa ELF passes; non-target ELF (wrong e_machine / class /
// endianness, or not an ELF at all) is rejected with readable issues.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EM_RISCV, EM_XTENSA, expectedElfMachine, readElfHeader, validateElf } from '../src/elf.js';

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'blink.elf');
const blink = readFileSync(FIXTURE_PATH);

interface ElfOpts {
  elfClass?: number;
  data?: number;
  type?: number;
  machine?: number;
}

/** Minimal synthetic ELF32 header for negative cases. */
function elfHeader(opts: ElfOpts = {}): Buffer {
  const buf = Buffer.alloc(0x34, 0);
  buf[0] = 0x7f;
  buf[1] = 0x45;
  buf[2] = 0x4c;
  buf[3] = 0x46;
  buf[4] = opts.elfClass ?? 1; // ELFCLASS32
  buf[5] = opts.data ?? 1;     // ELFDATA2LSB
  buf[6] = 1;                  // EV_CURRENT
  buf.writeUInt16LE(opts.type ?? 2, 0x10);   // ET_EXEC
  buf.writeUInt16LE(opts.machine ?? EM_XTENSA, 0x12);
  return buf;
}

describe('readElfHeader', () => {
  it('parses the golden fixture as ELF32 LSB Xtensa executable', () => {
    const h = readElfHeader(blink);
    expect(h).not.toBeNull();
    expect(h).toMatchObject({ elfClass: 1, data: 1, type: 2, machine: EM_XTENSA });
  });

  it('returns null for truncated buffers and non-ELF magic', () => {
    expect(readElfHeader(Buffer.alloc(16))).toBeNull();
    const notElf = elfHeader();
    notElf[1] = 0x46; // "\x7fFLF"
    expect(readElfHeader(notElf)).toBeNull();
  });

  it('reads big-endian e_machine (ELFDATA2MSB)', () => {
    const be = elfHeader({ data: 2 });
    be.writeUInt16BE(EM_XTENSA, 0x12);
    expect(readElfHeader(be)?.machine).toBe(EM_XTENSA);
  });
});

describe('expectedElfMachine', () => {
  it('maps Xtensa and RISC-V chip families', () => {
    expect(expectedElfMachine('esp32')).toBe(EM_XTENSA);
    expect(expectedElfMachine('esp32s3')).toBe(EM_XTENSA);
    expect(expectedElfMachine('esp32c3')).toBe(EM_RISCV);
    expect(expectedElfMachine('esp32c6')).toBe(EM_RISCV);
  });
});

describe('validateElf', () => {
  it('accepts the golden blink.elf for esp32 and esp32s3', () => {
    expect(validateElf(blink, 'esp32').ok).toBe(true);
    expect(validateElf(blink, 'esp32s3').ok).toBe(true);
  });

  it('accepts a RISC-V image for esp32c3 and esp32c6 (dev-plan P4.1)', () => {
    expect(validateElf(elfHeader({ machine: EM_RISCV }), 'esp32c3').ok).toBe(true);
    expect(validateElf(elfHeader({ machine: EM_RISCV }), 'esp32c6').ok).toBe(true);
  });

  it('rejects the golden Xtensa ELF for esp32c3 and esp32c6 (RISC-V targets)', () => {
    for (const chip of ['esp32c3', 'esp32c6'] as const) {
      const { ok, issues } = validateElf(blink, chip);
      expect(ok).toBe(false);
      expect(issues.some((i) => i.message.includes(`does not match ${chip}`))).toBe(true);
    }
  });

  it('rejects a non-target e_machine with the expected machine in the message', () => {
    const { ok, issues } = validateElf(elfHeader({ machine: 40 }), 'esp32'); // EM_ARM
    expect(ok).toBe(false);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('e_machine 0x28 does not match esp32 (expected 0x5e)');
  });

  it('rejects ELF64 and big-endian images', () => {
    expect(validateElf(elfHeader({ elfClass: 2 }), 'esp32').issues.some((i) => i.message.includes('not ELF32'))).toBe(true);
    expect(validateElf(elfHeader({ data: 2 }), 'esp32').issues.some((i) => i.message.includes('little-endian'))).toBe(true);
  });

  it('rejects non-executable e_type', () => {
    const { ok, issues } = validateElf(elfHeader({ type: 4 }), 'esp32');
    expect(ok).toBe(false);
    expect(issues.some((i) => i.message.includes('not an executable image'))).toBe(true);
  });

  it('rejects buffers that are not ELF files', () => {
    const { ok, issues } = validateElf(Buffer.from('MZ garbage', 'ascii'), 'esp32');
    expect(ok).toBe(false);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe('not an ELF file (bad magic or truncated header)');
  });
});
