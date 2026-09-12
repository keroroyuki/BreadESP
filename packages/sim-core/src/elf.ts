// PRD: §F-FW-5, §9 — ELF header parsing + architecture validation (dev-plan task P0.6).
// Guards the QEMU spawn path: a firmware image whose e_machine does not match the
// target chip is rejected before it can crash or confuse the emulator.
import type { ChipKind } from '@breadesp/netlist';

/** e_machine values for the supported chip families. */
export const EM_XTENSA = 94; // 0x5e — ESP32 / ESP32-S3 (EM_XTENSA per Linux/FreeBSD elf.h)
export const EM_RISCV = 243; // 0xf3 — ESP32-C3 / ESP32-C6

export interface ElfHeader {
  /** 1 = ELFCLASS32, 2 = ELFCLASS64. */
  elfClass: number;
  /** 1 = ELFDATA2LSB, 2 = ELFDATA2MSB. */
  data: number;
  /** e_type (2 = ET_EXEC, 3 = ET_DYN). */
  type: number;
  /** e_machine (e.g. EM_XTENSA). */
  machine: number;
}

export interface ElfValidationIssue {
  message: string;
}

const ELF32_HEADER_SIZE = 0x34; // 52 bytes: minimal ELF32 header
const ET_EXEC = 2;
const ET_DYN = 3;

/**
 * Parse the fixed identification part of an ELF header.
 * Returns null when the buffer is too short, lacks the \x7fELF magic, or carries an
 * unknown class/encoding byte.
 */
export function readElfHeader(buf: Uint8Array): ElfHeader | null {
  if (buf.length < ELF32_HEADER_SIZE) return null;
  if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) return null;
  const elfClass = buf[4];
  if (elfClass !== 1 && elfClass !== 2) return null;
  const data = buf[5];
  if (data !== 1 && data !== 2) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const little = data === 1;
  const type = view.getUint16(0x10, little);
  const machine = view.getUint16(0x12, little);
  return { elfClass, data, type, machine };
}

/** e_machine expected for a chip family. */
export function expectedElfMachine(chip: ChipKind): number {
  switch (chip) {
    case 'esp32':
    case 'esp32s3':
      return EM_XTENSA;
    case 'esp32c3':
    case 'esp32c6':
      return EM_RISCV;
  }
}

/**
 * Validate that a buffer is an ELF32 little-endian executable for the target chip
 * (dev-plan task 0.6 acceptance: e_machine must match, e.g. 0x5a for Xtensa).
 */
export function validateElf(buf: Uint8Array, chip: ChipKind): { ok: boolean; issues: ElfValidationIssue[] } {
  const issues: ElfValidationIssue[] = [];
  const header = readElfHeader(buf);
  if (!header) {
    issues.push({ message: 'not an ELF file (bad magic or truncated header)' });
    return { ok: false, issues };
  }
  // QEMU-ESP32 loads ELF32 little-endian images only.
  if (header.elfClass !== 1) issues.push({ message: `ELF class ${header.elfClass} is not ELF32` });
  if (header.data !== 1) issues.push({ message: 'ELF data encoding is not little-endian' });
  if (header.type !== ET_EXEC && header.type !== ET_DYN) {
    issues.push({ message: `e_type ${header.type} is not an executable image` });
  }
  const expected = expectedElfMachine(chip);
  if (header.machine !== expected) {
    issues.push({
      message: `e_machine 0x${header.machine.toString(16)} does not match ${chip} (expected 0x${expected.toString(16)})`,
    });
  }
  return { ok: issues.length === 0, issues };
}
