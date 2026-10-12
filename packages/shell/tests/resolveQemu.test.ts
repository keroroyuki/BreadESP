// PRD: §4.2, §11.2 — resolveQemu unit tests (packaging P6.1).
// All environment seams (env vars, resourcesPath, platform, start dir) are
// injected; fixtures are real temp directories so the walk-up search and the
// metadata parsing exercise the real fs.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveQemu } from '../src/qemu/resolveQemu.js';

const roots: string[] = [];

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'breadesp-resolve-qemu-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** Repo-shaped fixture: root/packages/sim-core/bin with the given metas. */
function makeRepoBin(metas: Record<string, unknown>): { root: string; binDir: string } {
  const root = fixture();
  const binDir = join(root, 'packages', 'sim-core', 'bin');
  mkdirSync(binDir, { recursive: true });
  for (const [name, meta] of Object.entries(metas)) {
    writeFileSync(join(binDir, name), JSON.stringify(meta), 'utf8');
  }
  return { root, binDir };
}

function touchBin(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'fake-qemu', 'utf8');
  return path;
}

describe('resolveQemu (P6.1)', () => {
  it('trusts an explicit renderer-supplied binary above everything', () => {
    const r = resolveQemu('esp32', '/dev/tools/qemu-system-xtensa', { env: {}, resourcesPath: undefined, startDir: fixture() });
    expect(r).toEqual({ qemuBin: '/dev/tools/qemu-system-xtensa', hasDevice: true, source: 'explicit' });
  });

  it('honors BREADESP_QEMU_DBUS_BIN as a device-capable override', () => {
    const bin = touchBin(join(fixture(), 'opt', 'qemu-system-xtensa'));
    const r = resolveQemu('esp32', undefined, { env: { BREADESP_QEMU_DBUS_BIN: bin }, startDir: fixture() });
    expect(r).toEqual({ qemuBin: bin, hasDevice: true, source: 'env:BREADESP_QEMU_DBUS_BIN' });
  });

  it('treats BREADESP_QEMU_BIN as a stock binary (no device argv)', () => {
    const bin = touchBin(join(fixture(), 'opt', 'qemu-system-xtensa'));
    const r = resolveQemu('esp32', undefined, { env: { BREADESP_QEMU_BIN: bin }, startDir: fixture() });
    expect(r).toEqual({ qemuBin: bin, hasDevice: false, source: 'env:BREADESP_QEMU_BIN' });
  });

  it('skips env paths that do not exist and records them in the failure story', () => {
    expect(() =>
      resolveQemu('esp32', undefined, {
        env: { BREADESP_QEMU_BIN: '/ghost/qemu-system-xtensa' },
        resourcesPath: undefined,
        startDir: fixture(),
      }),
    ).toThrowError(/\[BB-100][\s\S]*BREADESP_QEMU_BIN=\/ghost\/qemu-system-xtensa \(not found\)/);
  });

  it('resolves the packaged bundle and detects the device marker', () => {
    const res = fixture();
    const exe = process.platform === 'win32' ? 'qemu-system-xtensa.exe' : 'qemu-system-xtensa';
    const bin = touchBin(join(res, 'qemu', 'bin', exe));
    writeFileSync(join(res, 'qemu', 'qemu-breadesp.json'), '{}', 'utf8');
    const r = resolveQemu('esp32', undefined, { env: {}, resourcesPath: res, startDir: fixture() });
    expect(r).toEqual({ qemuBin: bin, hasDevice: true, source: 'packaged' });
  });

  it('reports a packaged stock bundle (no marker) as device-less', () => {
    const res = fixture();
    const exe = process.platform === 'win32' ? 'qemu-system-xtensa.exe' : 'qemu-system-xtensa';
    touchBin(join(res, 'qemu', 'bin', exe));
    const r = resolveQemu('esp32', undefined, { env: {}, resourcesPath: res, startDir: fixture() });
    expect(r.hasDevice).toBe(false);
  });

  it('prefers the repo device build when it targets this host', () => {
    const bin = touchBin(join(fixture(), 'staging', 'qemu-system-xtensa.exe'));
    const { root } = makeRepoBin({
      'qemu-breadesp.json': { binaryPath: bin, target: 'windows-msys2' },
    });
    const r = resolveQemu('esp32', undefined, {
      env: {}, resourcesPath: undefined, startDir: root, platform: 'win32',
    });
    expect(r).toEqual({ qemuBin: bin, hasDevice: true, source: 'repo:qemu-breadesp.json' });
  });

  it('skips a foreign-target device build and falls back to the stock manifest', () => {
    // A linux-docker build on a Windows host must NOT be spawned (ELF binary).
    const linuxBin = touchBin(join(fixture(), 'staging', 'qemu-system-xtensa'));
    const stockBin = touchBin(join(fixture(), 'stock', 'qemu-system-xtensa.exe'));
    const { root } = makeRepoBin({
      'qemu-breadesp.json': { binaryPath: linuxBin, target: 'linux-docker' },
      'qemu.json': { binaryPath: stockBin },
    });
    const r = resolveQemu('esp32', undefined, {
      env: {}, resourcesPath: undefined, startDir: root, platform: 'win32',
    });
    expect(r).toEqual({ qemuBin: stockBin, hasDevice: false, source: 'repo:qemu.json' });
  });

  it('walks up from a nested start directory to find the repo bin metadata', () => {
    const stockBin = touchBin(join(fixture(), 'stock', 'qemu-system-xtensa'));
    const { root } = makeRepoBin({ 'qemu.json': { binaryPath: stockBin } });
    const nested = join(root, 'packages', 'shell', 'dist', 'qemu');
    mkdirSync(nested, { recursive: true });
    const r = resolveQemu('esp32', undefined, {
      env: {}, resourcesPath: undefined, startDir: nested, platform: 'linux',
    });
    expect(r.qemuBin).toBe(stockBin);
  });

  it('rejects with a coded [BB-100] naming the missing system binary for unbundled chips', () => {
    const xtensaBin = touchBin(join(fixture(), 'stock', 'qemu-system-xtensa'));
    const { root } = makeRepoBin({ 'qemu.json': { binaryPath: xtensaBin } });
    expect(() =>
      resolveQemu('esp32c3', undefined, { env: {}, resourcesPath: undefined, startDir: root, platform: 'linux' }),
    ).toThrowError(/\[BB-100] no usable qemu-system-riscv32 for chip 'esp32c3'/);
  });

  it('rejects with [BB-100] and the full search story when nothing exists', () => {
    expect(() =>
      resolveQemu('esp32', undefined, { env: {}, resourcesPath: undefined, startDir: fixture() }),
    ).toThrowError(/\[BB-100][\s\S]*packages\/sim-core\/bin/);
  });
});
