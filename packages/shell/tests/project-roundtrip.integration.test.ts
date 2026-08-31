// PRD: §F-PROJ, §6.6, dev-plan task P1.8 — end-to-end project lifecycle over the
// real IPC surface: preload API -> ipcMain handler -> real ProjectManager ->
// real temp directory, with JSON round-trips on both IPC directions (PRD §6.6
// requires JSON-serializable payloads). Acceptance: save -> close -> reopen
// restores the project exactly.
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LayoutFile, Netlist } from '@breadesp/netlist';
import type { ProjectData } from '../src/project/ProjectManager.js';

interface ProjApi {
  new: (p: { dir: string }) => Promise<void>;
  open: (p: { dir: string }) => Promise<ProjectData>;
  save: (p: { netlist: Netlist; layout: LayoutFile }) => Promise<void>;
  saveAs: (p: { dir: string; netlist: Netlist; layout: LayoutFile }) => Promise<void>;
  close: () => Promise<void>;
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
      // No-argument invokes (e.g. proj:close) pass undefined through as-is.
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

const tmp = mkdtempSync(join(tmpdir(), 'breadesp-p18-e2e-'));
afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });

const NETLIST: Netlist = {
  version: 1,
  chip: 'esp32',
  peripherals: [
    { instanceId: 'led-1', kind: 'led' },
    { instanceId: 'oled1', kind: 'ssd1306', props: { address: 60 } },
  ],
  wires: [
    { id: 'wire-1', from: { instanceId: 'mcu', pin: 'GPIO2' }, to: { instanceId: 'led-1', pin: 'A' } },
    { id: 'wire-2', from: { instanceId: 'oled1', pin: 'SDA' }, to: { instanceId: 'mcu', pin: 'GPIO21' } },
  ],
};
const LAYOUT: LayoutFile = {
  version: 1,
  items: [
    { instanceId: 'led-1', x: 240, y: 130, kind: 'led' },
    { instanceId: 'oled1', x: 420, y: 60, kind: 'ssd1306' },
  ],
};

beforeAll(async () => {
  // Stubs mirror only the surface registerIpcHandlers touches — the project
  // path under test is the real ProjectManager; safe at this test boundary.
  const qemu = { load: vi.fn(), start: vi.fn(), pause: vi.fn(), step: vi.fn(), reset: vi.fn(), getStatus: vi.fn(), on: vi.fn() };
  const gdb = { setBreakpoint: vi.fn(), removeBreakpoint: vi.fn(), continue: vi.fn(), step: vi.fn(), vars: vi.fn(), regs: vi.fn() };
  const peripherals = { applyNetlist: vi.fn(), driveInput: vi.fn(), on: vi.fn() };
  await registerIpcHandlers({
    project: new ProjectManager(),
    qemu,
    gdb,
    peripherals,
  } as unknown as Parameters<typeof registerIpcHandlers>[0]);
});

describe('project lifecycle over the real IPC surface (P1.8)', () => {
  // Boundary cast: the mocked contextBridge captured the preload API object.
  const proj = (state.api as { proj: ProjApi }).proj;

  it('new -> edit -> save -> close -> reopen restores the project exactly', async () => {
    const dir = join(tmp, 'demo.breadesp');

    await proj.new({ dir });
    // "Edit" on the UI side (store state serialized through the toolbar).
    await proj.save({ netlist: NETLIST, layout: LAYOUT });
    await proj.close();

    const data = await proj.open({ dir });
    expect(data.dir).toBe(dir);
    expect(data.netlist).toEqual(NETLIST);
    expect(data.layout).toEqual(LAYOUT);
    expect(data.firmwareElf).toBeNull();
    expect(data.meta.version).toBe(1);
    expect(data.meta.updatedAt).toBeGreaterThanOrEqual(data.meta.createdAt);
  });

  it('saveAs writes the same state to a fresh directory and opens it back', async () => {
    const dir = join(tmp, 'copy.breadesp');
    await proj.saveAs({ dir, netlist: NETLIST, layout: LAYOUT });
    const data = await proj.open({ dir });
    expect(data.netlist).toEqual(NETLIST);
    expect(data.layout).toEqual(LAYOUT);
  });

  it('saveAs refuses to overwrite an existing project directory', async () => {
    const dir = join(tmp, 'taken.breadesp');
    await proj.new({ dir });
    await expect(proj.saveAs({ dir, netlist: NETLIST, layout: LAYOUT })).rejects.toThrow(
      /\[BB-124\] project already exists at/,
    );
  });

  it('opening a missing directory rejects with [BB-120] through the IPC boundary', async () => {
    await expect(proj.open({ dir: join(tmp, 'nope') })).rejects.toThrow(/\[BB-120\] project directory not found/);
  });

  it('saving an invalid netlist rejects without touching disk', async () => {
    const dir = join(tmp, 'guard.breadesp');
    await proj.new({ dir });
    const dangling: Netlist = {
      ...NETLIST,
      wires: [{ id: 'w-ghost', from: { instanceId: 'mcu', pin: 'GPIO2' }, to: { instanceId: 'ghost', pin: 'A' } }],
    };
    await expect(proj.save({ netlist: dangling, layout: LAYOUT })).rejects.toThrow(/\[BB-122\]/);
    const data = await proj.open({ dir });
    expect(data.netlist.peripherals).toEqual([]); // skeleton untouched
  });
});
