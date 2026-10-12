// PRD: §4.2, §6.6 — handler-level coverage of the P6.1 QEMU auto-resolution:
// an omitted qemuBin resolves through the environment and auto-attaches the
// live DBus channel when the binary carries the breadesp-dbus device.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  handles: new Map<string, (e: unknown, ...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (e: unknown, ...args: unknown[]) => unknown) => {
      state.handles.set(channel, handler);
    },
  },
}));

import { registerIpcHandlers, type HandlerDeps } from '../src/ipc/handlers.js';

const fixtureDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function stubDeps(dbus?: { port: number; sendInject: ReturnType<typeof vi.fn> }): HandlerDeps {
  return {
    project: { validateFirmware: vi.fn() },
    qemu: { load: vi.fn(), on: vi.fn() },
    gdb: { on: vi.fn() },
    peripherals: { on: vi.fn() },
    catalog: {},
    dbus: dbus as unknown as HandlerDeps['dbus'],
  } as unknown as HandlerDeps;
}

beforeEach(() => {
  state.handles.clear();
  for (const key of ['BREADESP_QEMU_BIN', 'BREADESP_QEMU_DBUS_BIN']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (fixtureDirs.length > 0) rmSync(fixtureDirs.pop()!, { recursive: true, force: true });
});

/** A real file so the resolver's existence check passes. */
function fixtureBin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'breadesp-handlers-qemu-'));
  fixtureDirs.push(dir);
  const bin = join(dir, process.platform === 'win32' ? 'qemu-system-xtensa.exe' : 'qemu-system-xtensa');
  writeFileSync(bin, 'fake-qemu', 'utf8');
  return bin;
}

describe('IPC handlers QEMU auto-resolution (P6.1)', () => {
  it('fw:load resolves the device binary and attaches the DBus channel', async () => {
    const bin = fixtureBin();
    process.env.BREADESP_QEMU_DBUS_BIN = bin;
    const deps = stubDeps({ port: 47123, sendInject: vi.fn() });
    await registerIpcHandlers(deps);
    await state.handles.get('fw:load')!(undefined, { elfPath: '/tmp/x.elf', chip: 'esp32' });
    expect(deps.qemu.load).toHaveBeenCalledWith({
      firmwareElf: '/tmp/x.elf',
      chip: 'esp32',
      gdbPort: undefined,
      qemuBin: bin,
      dbus: { host: '127.0.0.1', port: 47123 },
    });
  });

  it('fw:load on a stock binary runs without the DBus device argv', async () => {
    const bin = fixtureBin();
    process.env.BREADESP_QEMU_BIN = bin; // stock convention: no device
    const deps = stubDeps({ port: 47123, sendInject: vi.fn() });
    await registerIpcHandlers(deps);
    await state.handles.get('fw:load')!(undefined, { elfPath: '/tmp/x.elf', chip: 'esp32' });
    expect(deps.qemu.load).toHaveBeenCalledWith({
      firmwareElf: '/tmp/x.elf',
      chip: 'esp32',
      gdbPort: undefined,
      qemuBin: bin,
      dbus: undefined,
    });
  });

  it('sim:load with an explicit qemuBin keeps the renderer-supplied dbus untouched', async () => {
    const deps = stubDeps({ port: 47123, sendInject: vi.fn() });
    await registerIpcHandlers(deps);
    await state.handles.get('sim:load')!(undefined, {
      elfPath: '/tmp/x.elf',
      chip: 'esp32',
      qemuBin: '/opt/qemu/bin/qemu-system-xtensa',
      dbus: { host: '10.0.0.2', port: 1 },
    });
    expect(deps.qemu.load).toHaveBeenCalledWith({
      firmwareElf: '/tmp/x.elf',
      chip: 'esp32',
      gdbPort: undefined,
      qemuBin: '/opt/qemu/bin/qemu-system-xtensa',
      dbus: { host: '10.0.0.2', port: 1 },
    });
  });
});
