// PRD: §F-PROJ, §9 — ProjectManager firmware gate (dev-plan task P0.6 acceptance:
// 非目标 ELF 报错拒绝 before QEMU is spawned).
import { describe, expect, it, afterAll } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ProjectManager } from '../src/project/ProjectManager.js';

const BLINK_ELF = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sim-core', 'fixtures', 'blink.elf');

/** Minimal synthetic ELF32 header for negative cases. */
function elfHeader(machine: number): Buffer {
  const buf = Buffer.alloc(0x34, 0);
  buf[0] = 0x7f;
  buf[1] = 0x45;
  buf[2] = 0x4c;
  buf[3] = 0x46;
  buf[4] = 1; // ELFCLASS32
  buf[5] = 1; // ELFDATA2LSB
  buf[6] = 1; // EV_CURRENT
  buf.writeUInt16LE(2, 0x10);      // ET_EXEC
  buf.writeUInt16LE(machine, 0x12);
  return buf;
}

describe('ProjectManager.validateFirmware (P0.6)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'breadesp-p06-'));
  afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

  it('accepts the golden Xtensa blink.elf', async () => {
    const pm = new ProjectManager();
    await expect(pm.validateFirmware(BLINK_ELF, 'esp32')).resolves.toBeUndefined();
  });

  it('rejects an ARM ELF for esp32 with [BB-101] and context', async () => {
    const arm = join(tmp, 'arm.elf');
    await writeFile(arm, elfHeader(40)); // EM_ARM
    const pm = new ProjectManager();
    await expect(pm.validateFirmware(arm, 'esp32')).rejects.toThrow(
      /\[BB-101\] firmware ELF .*arm\.elf rejected: e_machine 0x28 does not match esp32 \(expected 0x5e\)/,
    );
  });

  it('rejects the Xtensa fixture for a RISC-V target chip', async () => {
    const pm = new ProjectManager();
    await expect(pm.validateFirmware(BLINK_ELF, 'esp32c3')).rejects.toThrow(
      /\[BB-101\].*does not match esp32c3 \(expected 0xf3\)/,
    );
  });

  it('rejects a non-ELF file', async () => {
    const notElf = join(tmp, 'fake.elf');
    await writeFile(notElf, 'not an elf at all');
    const pm = new ProjectManager();
    await expect(pm.validateFirmware(notElf, 'esp32')).rejects.toThrow(
      /\[BB-101\] firmware ELF .*fake\.elf rejected: not an ELF file/,
    );
  });

  it('rejects a missing file with a readable error', async () => {
    const pm = new ProjectManager();
    await expect(pm.validateFirmware(join(tmp, 'missing.elf'), 'esp32')).rejects.toThrow(
      /\[BB-101\] cannot read firmware ELF .*missing\.elf/,
    );
  });

  it('golden fixture is a valid Xtensa ELF (sanity for the reference above)', () => {
    const buf = readFileSync(BLINK_ELF);
    expect(buf.readUInt16LE(0x12)).toBe(94); // e_machine == EM_XTENSA (0x5e)
  });
});
