// PRD: §6.6, dev-plan task P1.1 — preload↔handlers IPC channel alignment.
// Acceptance: no "unregistered channel" errors in either direction —
// every channel preload invokes must have an ipcMain.handle registration,
// and every channel handlers pushes must have an ipcRenderer.on listener.
import { describe, expect, it, vi, beforeAll } from 'vitest';
import type { Mock } from 'vitest';

interface RecordedSend { channel: string; payload: unknown; }

const state = vi.hoisted(() => ({
  /** ipcMain.handle registrations from handlers.ts (channel -> handler). */
  handles: new Map<string, (e: unknown, ...args: unknown[]) => unknown>(),
  /** webContents.send pushes from handlers.ts. */
  sends: [] as RecordedSend[],
  /** ipcRenderer.invoke channel names used by preload.ts. */
  invokes: [] as string[],
  /** ipcRenderer.on listeners from preload.ts (channel -> handlers; keys survive cleanup). */
  listens: new Map<string, unknown[]>(),
  /** API object captured from contextBridge.exposeInMainWorld. */
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
    invoke: (channel: string) => { state.invokes.push(channel); return Promise.resolve(undefined); },
    on: (channel: string, handler: unknown) => {
      const list = state.listens.get(channel) ?? [];
      list.push(handler);
      state.listens.set(channel, list);
    },
    removeListener: (channel: string, handler: unknown) => {
      const list = state.listens.get(channel) ?? [];
      state.listens.set(channel, list.filter((h) => h !== handler));
    },
  },
}));

// Side-effect import: runs contextBridge.exposeInMainWorld (mocked) at module load.
import '../src/preload.js';
import { registerIpcHandlers, type HandlerDeps } from '../src/ipc/handlers.js';

/** PRD §6.6 contract — renderer -> main invoke channels (dev-plan task P1.1 scope). */
const EXPECTED_INVOKE_CHANNELS = [
  'sim:load', 'sim:start', 'sim:pause', 'sim:step', 'sim:reset', 'sim:status',
  'fw:load', 'fw:listSymbols',
  'dbg:setBreakpoint', 'dbg:removeBreakpoint', 'dbg:continue', 'dbg:step', 'dbg:vars', 'dbg:regs',
  'proj:new', 'proj:open', 'proj:save', 'proj:saveAs', 'proj:close',
  'bb:applyNetlist', 'bb:getNetlist',
  'per:driveInput',
] as const;

/** PRD §6.6 contract — main -> renderer one-way push channels. */
const EXPECTED_PUSH_CHANNELS = ['per:snapshot', 'sim:status', 'sim:uart', 'sim:error'] as const;

/** Recursively call every function leaf of the exposed preload API. */
function callEveryApiFunction(node: unknown): void {
  if (typeof node === 'function') {
    const ret = (node as (arg?: unknown) => unknown)(vi.fn());
    if (typeof ret === 'function') (ret as () => void)(); // unsubscribe cleanup
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) callEveryApiFunction(value);
  }
}

const qemu = { load: vi.fn(), start: vi.fn(), pause: vi.fn(), step: vi.fn(), reset: vi.fn(), getStatus: vi.fn(), on: vi.fn() };
const gdb = { setBreakpoint: vi.fn(), removeBreakpoint: vi.fn(), continue: vi.fn(), step: vi.fn(), vars: vi.fn(), regs: vi.fn() };
const project = { validateFirmware: vi.fn(), newProject: vi.fn(), openProject: vi.fn(), saveNetlist: vi.fn(), close: vi.fn(), loadNetlist: vi.fn() };
const peripherals = { applyNetlist: vi.fn(), driveInput: vi.fn(), on: vi.fn() };
const win = { webContents: { send: (channel: string, payload: unknown) => { state.sends.push({ channel, payload }); } } };

/** Extract the callback handlers.ts registered for a stub service event. */
function listenerFor(service: { on: Mock }, event: string): (payload: unknown) => void {
  const call = service.on.mock.calls.find((c) => c[0] === event);
  if (!call) throw new Error(`no listener registered for '${event}'`);
  return call[1] as (payload: unknown) => void;
}

beforeAll(async () => {
  callEveryApiFunction(state.api);
  // Stubs mirror only the surface registerIpcHandlers touches — safe at this test boundary.
  await registerIpcHandlers({ qemu, gdb, project, peripherals, win } as unknown as HandlerDeps);
  // Fire one probe event per emitter so every Bridge -> UI push channel is
  // observable in `sends` (subscriptions alone do not send anything).
  listenerFor(qemu, 'status')('running');
  listenerFor(qemu, 'uart')('');
  listenerFor(qemu, 'error')(new Error('probe'));
  listenerFor(peripherals, 'snapshot')({ instanceId: 'probe' });
});

describe('preload ↔ handlers IPC contract (P1.1)', () => {
  it('exposes one preload entry per registered ipcMain handler', () => {
    expect(state.api).not.toBeNull();
    expect(new Set(state.invokes)).toEqual(new Set(state.handles.keys()));
  });

  it('matches the PRD §6.6 invoke channel list exactly', () => {
    expect([...new Set(state.invokes)].sort()).toEqual([...EXPECTED_INVOKE_CHANNELS].sort());
    expect([...state.handles.keys()].sort()).toEqual([...EXPECTED_INVOKE_CHANNELS].sort());
  });

  it('listens on exactly the channels handlers push to the renderer', () => {
    expect(new Set(state.listens.keys())).toEqual(new Set(state.sends.map((s) => s.channel)));
  });

  it('matches the PRD §6.6 push channel list exactly', () => {
    expect([...state.listens.keys()].sort()).toEqual([...EXPECTED_PUSH_CHANNELS].sort());
    expect([...new Set(state.sends.map((s) => s.channel))].sort()).toEqual([...EXPECTED_PUSH_CHANNELS].sort());
  });

  it('routes sim:load through the firmware gate before the QEMU spawn', async () => {
    const handler = state.handles.get('sim:load');
    expect(handler).toBeDefined();
    await handler!(
      undefined,
      { elfPath: '/tmp/blink.elf', chip: 'esp32', qemuBin: '/opt/qemu/bin/qemu-system-xtensa', gdbPort: 1234 },
    );
    expect(project.validateFirmware).toHaveBeenCalledWith('/tmp/blink.elf', 'esp32');
    expect(qemu.load).toHaveBeenCalledWith({
      firmwareElf: '/tmp/blink.elf',
      chip: 'esp32',
      qemuBin: '/opt/qemu/bin/qemu-system-xtensa',
      gdbPort: 1234,
      dbus: undefined,
    });
  });

  it('forwards QEMU uart events on sim:uart with the payload intact', () => {
    listenerFor(qemu, 'uart')('Hello ESP32');
    expect(state.sends).toContainEqual({ channel: 'sim:uart', payload: 'Hello ESP32' });
  });

  it('forwards QEMU process errors on sim:error with a readable message', () => {
    listenerFor(qemu, 'error')(new Error('spawn ENOENT'));
    expect(state.sends).toContainEqual({ channel: 'sim:error', payload: 'spawn ENOENT' });
  });

  it('forwards peripheral snapshots on per:snapshot', () => {
    listenerFor(peripherals, 'snapshot')({ instanceId: 'led-1' });
    expect(state.sends).toContainEqual({ channel: 'per:snapshot', payload: { instanceId: 'led-1' } });
  });
});
