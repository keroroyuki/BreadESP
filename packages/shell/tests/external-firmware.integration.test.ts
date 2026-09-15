// PRD: §F-PROJ-3, §6.6, dev-plan task P4.3 — external PlatformIO/ESP-IDF
// project association over the real IPC surface: preload API -> ipcMain
// handler -> real ProjectManager -> real temp directories, with JSON
// round-trips on both IPC directions (PRD §6.6 requires JSON-serializable
// payloads). Acceptance: build/*.elf of a linked project is auto-discovered
// and imported as the project's firmware.elf.
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { copyFile, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { mkdtempSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ExternalScanResult } from '../src/project/ExternalProject.js';

const BLINK_ELF = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sim-core', 'fixtures', 'blink.elf');

/** The preload proj surface P4.3 adds (payload/returns are JSON over the wire). */
interface ProjApi {
  new: (p: { dir: string }) => Promise<unknown>;
  linkExternal: (p: { dir: string }) => Promise<ExternalScanResult>;
  unlinkExternal: () => Promise<void>;
  scanExternal: () => Promise<ExternalScanResult>;
  importExternal: (p?: { elfPath?: string }) => Promise<string>;
}

const state = vi.hoisted(() => ({
  handles: new Map<string, (e: unknown, ...args: unknown[]) => unknown>(),
  api: null as Record<string, unknown> | null,
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: unknown) => { state.api = api as Record<string, unknown>; },
  },
  ipcMain: {
    handle: (channel: string, handler: (e: unknown, ...args: unknown[]) => unknown) => {
      state.handles.set(channel, handler);
    },
  },
  ipcRenderer: {
    // Renderer -> main passes through JSON (IPC boundary); main -> renderer
    // returns JSON too (void returns stay undefined). Rejections propagate as
    // Error objects (Electron preserves the message on invoke rejections).
    invoke: (channel: string, payload?: unknown) => {
      const handler = state.handles.get(channel);
      if (!handler) return Promise.reject(new Error(`no handler for ${channel}`));
      // No-argument invokes pass undefined through as-is.
      const wire = payload === undefined ? undefined : JSON.parse(JSON.stringify(payload));
      return Promise.resolve(handler(undefined, wire)).then(
        (ret: unknown) => (ret === undefined ? undefined : JSON.parse(JSON.stringify(ret))),
      );
    },
  },
}));

// Side-effect import: captures the preload API (mocked contextBridge).
import '../src/preload.js';
import { registerIpcHandlers } from '../src/ipc/handlers.js';
import { ProjectManager } from '../src/project/ProjectManager.js';

const tmp = mkdtempSync(join(tmpdir(), 'breadesp-p43-e2e-'));
afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

beforeAll(async () => {
  // Stubs mirror only the surface registerIpcHandlers touches — the project
  // path under test is the real ProjectManager; safe at this test boundary.
  const qemu = { load: vi.fn(), start: vi.fn(), pause: vi.fn(), reset: vi.fn(), getStatus: vi.fn(), getGdbPort: vi.fn(), getFirmwareElf: vi.fn(), on: vi.fn() };
  const gdb = { start: vi.fn(), stop: vi.fn(), isConnected: vi.fn(), setBreakpoint: vi.fn(), removeBreakpoint: vi.fn(), clearBreakpoints: vi.fn(), listBreakpoints: vi.fn(), continue: vi.fn(), step: vi.fn(), stepOver: vi.fn(), vars: vi.fn(), regs: vi.fn(), evaluate: vi.fn(), on: vi.fn() };
  const peripherals = { applyNetlist: vi.fn(), driveInput: vi.fn(), on: vi.fn() };
  await registerIpcHandlers({
    project: new ProjectManager(),
    qemu,
    gdb,
    peripherals,
  } as unknown as Parameters<typeof registerIpcHandlers>[0]);
});

describe('external firmware association over the real IPC surface (P4.3)', () => {
  // Boundary cast: the mocked contextBridge captured the preload API object.
  const proj = (state.api as { proj: ProjApi }).proj;

  it('link -> scan -> import round-trips a PlatformIO build as firmware.elf', async () => {
    const dir = join(tmp, 'demo.breadesp');
    await proj.new({ dir });

    // A fake PlatformIO workspace: two envs, the newer build must win.
    const pio = join(tmp, 'pio-workspace');
    const olderElf = join(pio, '.pio', 'build', 'esp32dev', 'firmware.elf');
    const newerElf = join(pio, '.pio', 'build', 's3box', 'firmware.elf');
    await mkdir(pio, { recursive: true });
    await writeFile(join(pio, 'platformio.ini'), '[env:esp32dev]\n[env:s3box]\n');
    for (const [i, elf] of [olderElf, newerElf].entries()) {
      await mkdir(dirname(elf), { recursive: true });
      await copyFile(BLINK_ELF, elf);
      const d = new Date(1_800_000_000_000 + i * 60_000);
      await utimes(elf, d, d);
    }

    const linkScan = await proj.linkExternal({ dir: pio });
    expect(linkScan.link).toEqual({ kind: 'platformio', dir: pio });
    expect(linkScan.candidates.map((c) => c.env)).toEqual(['s3box', 'esp32dev']);
    expect(linkScan.candidates.every((c) => c.archOk === true)).toBe(true);

    // A rescan discovers a freshly rebuilt ELF without relinking.
    const rebuiltElf = join(pio, '.pio', 'build', 'esp32dev', 'firmware.elf');
    const d = new Date(1_900_000_000_000);
    await utimes(rebuiltElf, d, d);
    const rescan = await proj.scanExternal();
    expect(rescan.candidates[0].path).toBe(rebuiltElf);

    // Explicit pick: the older env build, imported through the chip gate.
    const dest = await proj.importExternal({ elfPath: olderElf });
    expect(dest).toBe(join(dir, 'firmware.elf'));
    expect(readFileSync(dest)).toEqual(readFileSync(olderElf));

    // Reopen: the association and the imported firmware both persisted.
    const reopened = (await proj.linkExternal({ dir: pio })).link; // still linked; re-assert
    expect(reopened.dir).toBe(pio);
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    expect(meta.external).toEqual({ kind: 'platformio', dir: pio });

    // Unlink flips scan to [BB-128] through the IPC boundary.
    await proj.unlinkExternal();
    await expect(proj.scanExternal()).rejects.toThrow(/\[BB-128\] no external project linked/);
  });

  it('discovers an ESP-IDF build/*.elf and imports the newest by default', async () => {
    const dir = join(tmp, 'idf.breadesp');
    await proj.new({ dir });

    const idf = join(tmp, 'idf-workspace');
    const appElf = join(idf, 'build', 'blink.elf');
    await mkdir(join(idf, 'build'), { recursive: true });
    await writeFile(join(idf, 'CMakeLists.txt'), 'include($ENV{IDF_PATH}/tools/cmake/project.cmake)\nproject(blink)\n');
    await writeFile(join(idf, 'sdkconfig'), 'CONFIG_IDF_TARGET="esp32"\n');
    await copyFile(BLINK_ELF, appElf);

    const scan = await proj.linkExternal({ dir: idf });
    expect(scan.link.kind).toBe('esp-idf');
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0]).toMatchObject({ path: appElf, env: null, archOk: true });

    const dest = await proj.importExternal(); // no pick -> newest
    expect(dest).toBe(join(dir, 'firmware.elf'));
    expect(readFileSync(dest)).toEqual(readFileSync(BLINK_ELF));
  });

  it('propagates [BB-127]/[BB-129] failures through the IPC boundary', async () => {
    const dir = join(tmp, 'errors.breadesp');
    await proj.new({ dir });

    const stranger = join(tmp, 'not-a-firmware-project');
    await mkdir(stranger, { recursive: true });
    await expect(proj.linkExternal({ dir: stranger })).rejects.toThrow(/\[BB-127\]/);

    const unbuilt = join(tmp, 'unbuilt-idf');
    await mkdir(unbuilt, { recursive: true });
    await writeFile(join(unbuilt, 'CMakeLists.txt'), 'include($ENV{IDF_PATH}/tools/cmake/project.cmake)\n');
    await proj.linkExternal({ dir: unbuilt });
    await expect(proj.importExternal()).rejects.toThrow(/\[BB-129\] no build\/\*\.elf found/);
    // A failed import leaves no firmware.elf behind.
    await expect(readFile(join(dir, 'firmware.elf'))).rejects.toThrow();
  });
});
