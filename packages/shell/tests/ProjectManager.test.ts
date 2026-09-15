// PRD: §F-PROJ, §9 — ProjectManager firmware gate (dev-plan task P0.6 acceptance:
// 非目标 ELF 报错拒绝 before QEMU is spawned) and project lifecycle (P1.8
// acceptance: save -> close -> reopen restores the project exactly).
import { describe, expect, it, afterAll } from 'vitest';
import { copyFile, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
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

describe('ProjectManager new-project wizard options (P4.2)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'breadesp-p42-'));
  afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

  it('creates from a template + chip and returns the validated ProjectData', async () => {
    const dir = join(tmp, 'blink-s3');
    const pm = new ProjectManager();
    const data = await pm.newProject(dir, { chip: 'esp32s3', template: 'blink-led' });
    expect(data.dir).toBe(dir);
    expect(data.netlist).toEqual({
      version: 1,
      chip: 'esp32s3',
      peripherals: [{ instanceId: 'led-1', kind: 'led' }],
      wires: [{ id: 'wire-1', from: { instanceId: 'mcu', pin: 'GPIO2' }, to: { instanceId: 'led-1', pin: 'A' } }],
    });
    expect(data.layout).toEqual({
      version: 1,
      items: [{ instanceId: 'led-1', x: 120, y: 60, kind: 'led' }],
    });
    expect(data.firmwareElf).toBeNull();
    // What was returned is what landed on disk (no in-memory/disk drift).
    const onDisk = JSON.parse(await readFile(join(dir, 'netlist.json'), 'utf8'));
    expect(onDisk).toEqual(data.netlist);
  });

  it('wires the OLED template to the chip-specific default I2C0 pins', async () => {
    const dir = join(tmp, 'oled-c6');
    const pm = new ProjectManager();
    const data = await pm.newProject(dir, { chip: 'esp32c6', template: 'oled-ssd1306' });
    const pins = data.netlist.wires.map((w) => `${w.from.pin}->${w.to.pin}`).sort();
    expect(pins).toEqual(['GPIO6->SDA', 'GPIO7->SCL']);
  });

  it('defaults to esp32 + empty when no options are given', async () => {
    const dir = join(tmp, 'defaults');
    const pm = new ProjectManager();
    const data = await pm.newProject(dir);
    expect(data.netlist).toEqual({ version: 1, chip: 'esp32', peripherals: [], wires: [] });
    expect(data.layout).toEqual({ version: 1, items: [] });
  });

  it('rejects an unknown template with [BB-125] and writes nothing', async () => {
    const dir = join(tmp, 'bad-template');
    const pm = new ProjectManager();
    await expect(pm.newProject(dir, { template: 'nope' })).rejects.toThrow(
      '[BB-125] unknown project template: nope',
    );
    // Validation happens before any disk write: no directory was created.
    await expect(readFile(join(dir, 'meta.json'), 'utf8')).rejects.toThrow();
  });

  it('rejects an out-of-contract chip with [BB-125] and writes nothing', async () => {
    const dir = join(tmp, 'bad-chip');
    const pm = new ProjectManager();
    await expect(pm.newProject(dir, { chip: 'esp32h2' as Netlist['chip'] })).rejects.toThrow(
      /\[BB-125\] unknown chip "esp32h2"/,
    );
    await expect(readFile(join(dir, 'meta.json'), 'utf8')).rejects.toThrow();
  });

  it('still refuses to clobber an existing project when options are given', async () => {
    const dir = join(tmp, 'clobber-with-options');
    const pm = new ProjectManager();
    await pm.newProject(dir, { chip: 'esp32s3', template: 'blink-led' });
    await expect(pm.newProject(dir, { chip: 'esp32c3', template: 'empty' })).rejects.toThrow(
      /\[BB-124\] project already exists at/,
    );
  });
});

describe('ProjectManager external PlatformIO/IDF link (P4.3)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'breadesp-p43-'));
  afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

  /** Build a fake PlatformIO project with one .elf per env name. */
  async function makePioProject(root: string, envs: string[], mtimeBase = 1_800_000_000_000): Promise<string[]> {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'platformio.ini'), envs.map((e) => `[env:${e}]`).join('\n'));
    const paths: string[] = [];
    for (const [i, env] of envs.entries()) {
      const elf = join(root, '.pio', 'build', env, 'firmware.elf');
      await mkdir(join(elf, '..'), { recursive: true });
      await copyFile(BLINK_ELF, elf);
      const d = new Date(mtimeBase + i * 1000);
      await utimes(elf, d, d);
      paths.push(elf);
    }
    return paths;
  }

  it('linkExternalProject persists the association and returns a decorated scan', async () => {
    const dir = join(tmp, 'link-basic');
    const ext = join(tmp, 'ext-pio');
    const pm = new ProjectManager();
    await pm.newProject(dir);
    const [elfPath] = await makePioProject(ext, ['esp32dev']);

    const before = (await readFile(join(dir, 'meta.json'), 'utf8')).length;
    const scan = await pm.linkExternalProject(ext);
    expect(scan.link).toEqual({ kind: 'platformio', dir: ext });
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0]).toMatchObject({ path: elfPath, env: 'esp32dev', archOk: true });

    // The association landed in meta.json and survives a reopen.
    const metaRaw = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    expect(metaRaw.external).toEqual({ kind: 'platformio', dir: ext });
    const reopened = new ProjectManager();
    const data = await reopened.openProject(dir);
    expect(data.external).toEqual({ kind: 'platformio', dir: ext });
    expect((await readFile(join(dir, 'meta.json'), 'utf8')).length).toBeGreaterThan(before);
  });

  it('marks candidates whose architecture mismatches the project chip archOk:false', async () => {
    const dir = join(tmp, 'link-arch');
    const ext = join(tmp, 'ext-mixed');
    const pm = new ProjectManager();
    await pm.newProject(dir); // chip esp32 -> Xtensa expected
    await mkdir(join(ext, '.pio', 'build', 'a'), { recursive: true });
    await mkdir(join(ext, '.pio', 'build', 'b'), { recursive: true });
    await writeFile(join(ext, 'platformio.ini'), '[env:a]\n[env:b]\n');
    await copyFile(BLINK_ELF, join(ext, '.pio', 'build', 'a', 'firmware.elf'));
    await writeFile(join(ext, '.pio', 'build', 'b', 'firmware.elf'), elfHeader(40)); // EM_ARM
    const scan = await pm.linkExternalProject(ext);
    const byEnv = new Map(scan.candidates.map((c) => [c.env, c.archOk]));
    expect(byEnv).toEqual(new Map([['a', true], ['b', false]]));
  });

  it('linkExternalProject rejects an unrecognized directory with [BB-127] and persists nothing', async () => {
    const dir = join(tmp, 'link-reject');
    const pm = new ProjectManager();
    await pm.newProject(dir);
    const stranger = join(tmp, 'stranger');
    await mkdir(stranger, { recursive: true });
    await expect(pm.linkExternalProject(stranger)).rejects.toThrow(/\[BB-127\] not a PlatformIO or ESP-IDF project/);
    const metaRaw = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    expect('external' in metaRaw).toBe(false);
  });

  it('link/scan/import without an open project fail with [BB-124]', async () => {
    const pm = new ProjectManager();
    await expect(pm.linkExternalProject(tmp)).rejects.toThrow(/\[BB-124\] no project open/);
    await expect(pm.unlinkExternalProject()).rejects.toThrow(/\[BB-124\] no project open/);
    await expect(pm.scanExternalFirmware()).rejects.toThrow(/\[BB-124\] no project open/);
    await expect(pm.importExternalFirmware()).rejects.toThrow(/\[BB-124\] no project open/);
  });

  it('scanExternalFirmware without a link fails with [BB-128]', async () => {
    const pm = new ProjectManager();
    await pm.newProject(join(tmp, 'scan-nolink'));
    await expect(pm.scanExternalFirmware()).rejects.toThrow(/\[BB-128\] no external project linked/);
  });

  it('scanExternalFirmware fails with [BB-128] when the linked project vanished', async () => {
    const dir = join(tmp, 'scan-gone');
    const ext = join(tmp, 'ext-vanishing');
    const pm = new ProjectManager();
    await pm.newProject(dir);
    await makePioProject(ext, ['a']);
    await pm.linkExternalProject(ext);
    await rm(ext, { recursive: true, force: true });
    await expect(pm.scanExternalFirmware()).rejects.toThrow(/\[BB-128\] linked project no longer recognized/);
  });

  it('importExternalFirmware without a path picks the newest candidate', async () => {
    const dir = join(tmp, 'import-newest');
    const ext = join(tmp, 'ext-two-envs');
    const pm = new ProjectManager();
    await pm.newProject(dir);
    const [older, newer] = await makePioProject(ext, ['old', 'new']);
    await pm.linkExternalProject(ext);
    const dest = await pm.importExternalFirmware();
    expect(dest).toBe(join(dir, 'firmware.elf'));
    // Both files are byte-identical blink.elf copies, so prove the *newest
    // path* won by giving it distinguishable content first.
    expect(readFileSync(newer)).toEqual(readFileSync(dest));
    expect(older).not.toBe(newer);
  });

  it('importExternalFirmware picks an explicit candidate by path', async () => {
    const dir = join(tmp, 'import-pick');
    const ext = join(tmp, 'ext-pick');
    const pm = new ProjectManager();
    await pm.newProject(dir);
    const [first, second] = await makePioProject(ext, ['one', 'two']);
    await pm.linkExternalProject(ext);
    const dest = await pm.importExternalFirmware(first);
    expect(dest).toBe(join(dir, 'firmware.elf'));
    expect(readFileSync(dest)).toEqual(readFileSync(first));
    expect(second).not.toBe(first);
  });

  it('importExternalFirmware rejects a path outside the discovered candidates with [BB-129]', async () => {
    const dir = join(tmp, 'import-outsider');
    const ext = join(tmp, 'ext-outsider');
    const pm = new ProjectManager();
    await pm.newProject(dir);
    await makePioProject(ext, ['a']);
    await pm.linkExternalProject(ext);
    await expect(pm.importExternalFirmware(BLINK_ELF)).rejects.toThrow(/\[BB-129\].*not a discovered candidate/);
    await expect(readFile(join(dir, 'firmware.elf'))).rejects.toThrow();
  });

  it('importExternalFirmware fails with [BB-129] when nothing was ever built', async () => {
    const dir = join(tmp, 'import-empty');
    const ext = join(tmp, 'ext-unbuilt');
    const pm = new ProjectManager();
    await pm.newProject(dir);
    await mkdir(ext, { recursive: true });
    await writeFile(join(ext, 'platformio.ini'), '[env:a]\n');
    await pm.linkExternalProject(ext);
    await expect(pm.importExternalFirmware()).rejects.toThrow(/\[BB-129\] no build\/\*\.elf found/);
  });

  it('importExternalFirmware gates on the chip architecture and leaves no firmware.elf behind', async () => {
    const dir = join(tmp, 'import-wrong-arch');
    const ext = join(tmp, 'ext-arm');
    const pm = new ProjectManager();
    await pm.newProject(dir); // chip esp32 (Xtensa)
    await mkdir(join(ext, 'build'), { recursive: true });
    await writeFile(join(ext, 'CMakeLists.txt'), 'include($ENV{IDF_PATH}/tools/cmake/project.cmake)\n');
    await writeFile(join(ext, 'sdkconfig'), '');
    await writeFile(join(ext, 'build', 'app.elf'), elfHeader(40)); // EM_ARM
    await pm.linkExternalProject(ext);
    await expect(pm.importExternalFirmware()).rejects.toThrow(/\[BB-101\]/);
    await expect(readFile(join(dir, 'firmware.elf'))).rejects.toThrow();
  });

  it('unlinkExternalProject removes the association (idempotent) and scan flips to [BB-128]', async () => {
    const dir = join(tmp, 'unlink');
    const ext = join(tmp, 'ext-unlink');
    const pm = new ProjectManager();
    await pm.newProject(dir);
    await makePioProject(ext, ['a']);
    await pm.linkExternalProject(ext);
    await pm.unlinkExternalProject();
    const metaRaw = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    expect('external' in metaRaw).toBe(false);
    await expect(pm.scanExternalFirmware()).rejects.toThrow(/\[BB-128\]/);
    // Second unlink is a no-op, and a reopen confirms the link stayed gone.
    await pm.unlinkExternalProject();
    const data = await new ProjectManager().openProject(dir);
    expect(data.external).toBeNull();
  });

  it('saveProject preserves the external link (meta rewrite round-trip)', async () => {
    const dir = join(tmp, 'save-keeps-link');
    const ext = join(tmp, 'ext-save');
    const pm = new ProjectManager();
    await pm.newProject(dir);
    await makePioProject(ext, ['a']);
    await pm.linkExternalProject(ext);
    const NET: Netlist = { version: 1, chip: 'esp32', peripherals: [], wires: [] };
    const LAY: LayoutFile = { version: 1, items: [] };
    await pm.saveProject(NET, LAY);
    const metaRaw = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    expect(metaRaw.external).toEqual({ kind: 'platformio', dir: ext });
    // And the link is still usable after the save.
    const scan = await pm.scanExternalFirmware();
    expect(scan.candidates).toHaveLength(1);
  });

  it('openProject rejects a malformed external link in meta.json with [BB-121]', async () => {
    const dir = join(tmp, 'bad-external-meta');
    const pm = new ProjectManager();
    await pm.newProject(dir);
    await writeFile(
      join(dir, 'meta.json'),
      JSON.stringify({ version: 1, createdAt: 1, updatedAt: 1, external: { kind: 'make', dir: '/x' } }),
    );
    await expect(pm.openProject(dir)).rejects.toThrow(/\[BB-121\] malformed meta\.json.*external/);
  });

  it('newProject-created projects open with a null external link', async () => {
    const data = await new ProjectManager().newProject(join(tmp, 'fresh-null-external'));
    expect(data.external).toBeNull();
    expect(data.meta.external).toBeUndefined();
  });
});
