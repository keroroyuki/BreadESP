// PRD: §F-PROJ, §9 — ProjectManager firmware gate (dev-plan task P0.6 acceptance:
// 非目标 ELF 报错拒绝 before QEMU is spawned) and project lifecycle (P1.8
// acceptance: save -> close -> reopen restores the project exactly).
import { describe, expect, it, afterAll } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { LayoutFile, Netlist } from '@breadesp/netlist';
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

  it('accepts a RISC-V ELF for esp32c3/esp32c6 and rejects Xtensa for esp32c6 (P4.1)', async () => {
    const riscv = join(tmp, 'riscv.elf');
    await writeFile(riscv, elfHeader(243)); // EM_RISCV (0xf3)
    const pm = new ProjectManager();
    await expect(pm.validateFirmware(riscv, 'esp32c3')).resolves.toBeUndefined();
    await expect(pm.validateFirmware(riscv, 'esp32c6')).resolves.toBeUndefined();
    await expect(pm.validateFirmware(BLINK_ELF, 'esp32c6')).rejects.toThrow(
      /\[BB-101\].*does not match esp32c6 \(expected 0xf3\)/,
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

describe('ProjectManager project lifecycle (P1.8)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'breadesp-p18-'));
  afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

  const NETLIST: Netlist = {
    version: 1,
    chip: 'esp32',
    peripherals: [{ instanceId: 'led-1', kind: 'led' }],
    wires: [{ id: 'wire-1', from: { instanceId: 'mcu', pin: 'GPIO2' }, to: { instanceId: 'led-1', pin: 'A' } }],
  };
  const LAYOUT: LayoutFile = {
    version: 1,
    items: [{ instanceId: 'led-1', x: 120, y: 40, kind: 'led' }],
  };

  it('newProject writes the skeleton (meta/netlist/layout) and opens back empty', async () => {
    const dir = join(tmp, 'skeleton');
    const pm = new ProjectManager();
    await pm.newProject(dir);
    const data = await pm.openProject(dir);
    expect(data.netlist).toEqual({ version: 1, chip: 'esp32', peripherals: [], wires: [] });
    expect(data.layout).toEqual({ version: 1, items: [] });
    expect(data.firmwareElf).toBeNull();
    expect(data.meta.createdAt).toBeGreaterThan(0);
  });

  it('newProject refuses to clobber an existing project', async () => {
    const dir = join(tmp, 'clobber');
    const pm = new ProjectManager();
    await pm.newProject(dir);
    await expect(pm.newProject(dir)).rejects.toThrow(/\[BB-124\] project already exists at/);
  });

  it('save -> close -> reopen restores the project exactly (P1.8 acceptance)', async () => {
    const dir = join(tmp, 'roundtrip');
    const pm = new ProjectManager();
    await pm.newProject(dir);
    await pm.saveProject(NETLIST, LAYOUT);
    const savedNetlistOnDisk = await readFile(join(dir, 'netlist.json'), 'utf8');
    await pm.close();

    const reopened = new ProjectManager();
    const data = await reopened.openProject(dir);
    expect(data.netlist).toEqual(NETLIST);
    expect(data.layout).toEqual(LAYOUT);
    expect(data.dir).toBe(dir);
    // Reopening must not rewrite the persisted half (no format drift).
    expect(await readFile(join(dir, 'netlist.json'), 'utf8')).toBe(savedNetlistOnDisk);
    // Save bumps updatedAt but preserves createdAt.
    expect(data.meta.createdAt).toBeLessThanOrEqual(data.meta.updatedAt);
  });

  it('saveAs flow copies the full state into a fresh directory', async () => {
    const src = join(tmp, 'saveas-src');
    const dst = join(tmp, 'saveas-dst');
    const pm = new ProjectManager();
    await pm.newProject(src);
    await pm.saveProject(NETLIST, LAYOUT);
    // proj:saveAs handler semantics: fresh skeleton, then both halves.
    await pm.newProject(dst);
    await pm.saveProject(NETLIST, LAYOUT);
    const data = await pm.openProject(dst);
    expect(data.netlist).toEqual(NETLIST);
    expect(data.layout).toEqual(LAYOUT);
  });

  it('importFirmware copies a validated ELF as firmware.elf; open returns its path', async () => {
    const dir = join(tmp, 'firmware');
    const pm = new ProjectManager();
    await pm.newProject(dir);
    const dest = await pm.importFirmware(BLINK_ELF);
    expect(dest).toBe(join(dir, 'firmware.elf'));
    expect(await readFile(dest)).toEqual(readFileSync(BLINK_ELF));
    const data = await pm.openProject(dir);
    expect(data.firmwareElf).toBe(join(dir, 'firmware.elf'));
  });

  it('importFirmware rejects an ELF for the wrong chip before copying', async () => {
    const dir = join(tmp, 'firmware-wrongchip');
    const arm = join(tmp, 'wrong.elf');
    await writeFile(arm, elfHeader(40)); // EM_ARM
    const pm = new ProjectManager();
    await pm.newProject(dir);
    await expect(pm.importFirmware(arm)).rejects.toThrow(/\[BB-101\]/);
    expect(await readFile(join(dir, 'netlist.json'), 'utf8')).toContain('"peripherals": []');
    // Failed import must leave no firmware.elf behind.
    await expect(readFile(join(dir, 'firmware.elf'))).rejects.toThrow();
  });

  it('openProject on a missing directory fails with [BB-120]', async () => {
    const pm = new ProjectManager();
    await expect(pm.openProject(join(tmp, 'does-not-exist'))).rejects.toThrow(
      /\[BB-120\] project directory not found/,
    );
  });

  it('openProject on a directory without meta.json fails with [BB-120]', async () => {
    const dir = join(tmp, 'not-a-project');
    await mkdir(dir, { recursive: true });
    const pm = new ProjectManager();
    await expect(pm.openProject(dir)).rejects.toThrow(
      new RegExp(`\\[BB-120\\] not a breadesp project \\(missing meta\\.json\\): .*${'not-a-project'}`),
    );
  });

  it('openProject rejects corrupted layout.json with [BB-123] and leaves no project open', async () => {
    const dir = join(tmp, 'bad-layout');
    const creator = new ProjectManager();
    await creator.newProject(dir);
    await creator.close();
    await writeFile(join(dir, 'layout.json'), JSON.stringify({ version: 1, items: [{ instanceId: 'x' }] }));
    const pm = new ProjectManager();
    await expect(pm.openProject(dir)).rejects.toThrow(/\[BB-123\] invalid layout in/);
    // A failed open must not leave a phantom open project.
    await expect(pm.saveProject(NETLIST, LAYOUT)).rejects.toThrow(/\[BB-124\] no project open/);
  });

  it('openProject rejects a malformed meta.json with [BB-121]', async () => {
    const dir = join(tmp, 'bad-meta');
    const pm = new ProjectManager();
    await pm.newProject(dir);
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ version: 9, createdAt: 1, updatedAt: 1 }));
    await expect(pm.openProject(dir)).rejects.toThrow(/\[BB-121\] malformed meta\.json/);
  });

  it('saveProject rejects an invalid netlist and writes nothing', async () => {
    const dir = join(tmp, 'invalid-save');
    const pm = new ProjectManager();
    await pm.newProject(dir);
    const before = await readFile(join(dir, 'netlist.json'), 'utf8');
    const dangling: Netlist = {
      ...NETLIST,
      wires: [{ id: 'w-ghost', from: { instanceId: 'mcu', pin: 'GPIO2' }, to: { instanceId: 'ghost', pin: 'A' } }],
    };
    await expect(pm.saveProject(dangling, LAYOUT)).rejects.toThrow(
      /\[BB-122\] invalid netlist: .*unknown instance ghost/,
    );
    expect(await readFile(join(dir, 'netlist.json'), 'utf8')).toBe(before);
  });

  it('saveProject without an open project fails with [BB-124]', async () => {
    const pm = new ProjectManager();
    await expect(pm.saveProject(NETLIST, LAYOUT)).rejects.toThrow(
      /\[BB-124\] no project open; call newProject\/openProject first/,
    );
  });

  it('loadNetlist reads back the saved netlist after reopen', async () => {
    const dir = join(tmp, 'getnetlist');
    const pm = new ProjectManager();
    await pm.newProject(dir);
    await pm.saveProject(NETLIST, LAYOUT);
    await pm.close();
    const reopened = new ProjectManager();
    await reopened.openProject(dir);
    expect(await reopened.loadNetlist()).toEqual(NETLIST);
  });
});
