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

/** PRD §6.6 contract — renderer -> main invoke channels (P1.1 + P1.9 dbg surface). */
const EXPECTED_INVOKE_CHANNELS = [
  'sim:load', 'sim:start', 'sim:pause', 'sim:step', 'sim:reset', 'sim:status', 'sim:sendUart',
  'sim:setSpeed', 'sim:getSpeed',
  'fw:load', 'fw:listSymbols',
  'dbg:connect', 'dbg:disconnect', 'dbg:status',
  'dbg:setBreakpoint', 'dbg:removeBreakpoint', 'dbg:clearBreakpoints', 'dbg:listBreakpoints',
  'dbg:continue', 'dbg:step', 'dbg:stepOver', 'dbg:vars', 'dbg:regs', 'dbg:evaluate',
  'proj:new', 'proj:open', 'proj:save', 'proj:saveAs', 'proj:close',
  'proj:linkExternal', 'proj:unlinkExternal', 'proj:scanExternal', 'proj:importExternal',
  'bb:applyNetlist', 'bb:getNetlist',
  'per:driveInput', 'per:captureChunk', 'per:rotateKnob',
] as const;

/** PRD §6.6 contract — main -> renderer one-way push channels. */
const EXPECTED_PUSH_CHANNELS = [
  'per:snapshot', 'sim:status', 'sim:uart', 'sim:error', 'sim:speed',
  'dbg:stopped', 'dbg:running', 'dbg:exit',
] as const;

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

const qemu = {
  load: vi.fn(),
  start: vi.fn(),
  pause: vi.fn(),
  reset: vi.fn(),
  getStatus: vi.fn(),
  setSpeed: vi.fn(),
  getSpeed: vi.fn().mockReturnValue(1),
  getGdbPort: vi.fn().mockReturnValue(null),
  getFirmwareElf: vi.fn().mockReturnValue(null),
  on: vi.fn(),
};
const gdb = {
  start: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined),
  isConnected: vi.fn().mockReturnValue(false),
  setBreakpoint: vi.fn(),
  removeBreakpoint: vi.fn(),
  clearBreakpoints: vi.fn(),
  listBreakpoints: vi.fn().mockResolvedValue([]),
  continue: vi.fn(),
  step: vi.fn(),
  stepOver: vi.fn(),
  vars: vi.fn(),
  regs: vi.fn(),
  evaluate: vi.fn(),
  on: vi.fn(),
};
const project = {
  validateFirmware: vi.fn(),
  newProject: vi.fn(),
  openProject: vi.fn(),
  saveProject: vi.fn(),
  importFirmware: vi.fn(),
  close: vi.fn(),
  loadNetlist: vi.fn(),
  linkExternalProject: vi.fn(),
  unlinkExternalProject: vi.fn(),
  scanExternalFirmware: vi.fn(),
  importExternalFirmware: vi.fn(),
};
const peripherals = { applyNetlist: vi.fn(), driveInput: vi.fn(), feedCapture: vi.fn(), driveRotate: vi.fn(), on: vi.fn() };
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
  listenerFor(qemu, 'speed')(0.5);
  listenerFor(qemu, 'uart')('');
  listenerFor(qemu, 'error')(new Error('probe'));
  listenerFor(peripherals, 'snapshot')({ instanceId: 'probe' });
  listenerFor(gdb, 'stopped')({ reason: 'breakpoint-hit' });
  listenerFor(gdb, 'running')(undefined);
  listenerFor(gdb, 'exit')(0);
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

  it('forwards QEMU speed changes on sim:speed with the payload intact (P2.6)', () => {
    listenerFor(qemu, 'speed')(0.25);
    expect(state.sends).toContainEqual({ channel: 'sim:speed', payload: 0.25 });
  });

  it('routes sim:setSpeed to QemuRunner and sim:getSpeed returns its factor (P2.6)', async () => {
    const setHandler = state.handles.get('sim:setSpeed');
    await setHandler!(undefined, { factor: 0.5 });
    expect(qemu.setSpeed).toHaveBeenCalledWith(0.5);
    qemu.getSpeed.mockReturnValueOnce(0.5);
    const getHandler = state.handles.get('sim:getSpeed');
    await expect(getHandler!(undefined)).resolves.toBe(0.5);
  });

  it('routes per:driveInput to PeripheralManager.driveInput (P3.4)', async () => {
    const handler = state.handles.get('per:driveInput');
    expect(handler).toBeDefined();
    peripherals.driveInput.mockClear();
    await handler!(undefined, { instanceId: 'btn1', pin: '1', level: 1 });
    expect(peripherals.driveInput).toHaveBeenCalledWith('btn1', '1', 1);
  });

  it('rejects malformed per:driveInput payloads with [BB-203] (P3.4)', async () => {
    const handler = state.handles.get('per:driveInput');
    expect(handler).toBeDefined();
    peripherals.driveInput.mockClear();
    const valid = { instanceId: 'btn1', pin: '1', level: 1 };
    const bad: unknown[] = [
      { ...valid, instanceId: '' },
      { ...valid, instanceId: 7 },
      { ...valid, pin: '' },
      { ...valid, pin: 1 },
      { ...valid, level: 2 },
      { ...valid, level: 'high' },
      null,
    ];
    for (const payload of bad) {
      await expect(handler!(undefined, payload)).rejects.toThrow('[BB-203]');
    }
    expect(peripherals.driveInput).not.toHaveBeenCalled();
  });

  it('routes per:rotateKnob to PeripheralManager.driveRotate with truncation (P3.4)', async () => {
    const handler = state.handles.get('per:rotateKnob');
    expect(handler).toBeDefined();
    await handler!(undefined, { instanceId: 'knob1', delta: -2.7 });
    expect(peripherals.driveRotate).toHaveBeenCalledWith('knob1', -2);
  });

  it('rejects malformed per:rotateKnob payloads with [BB-204] (P3.4)', async () => {
    const handler = state.handles.get('per:rotateKnob');
    expect(handler).toBeDefined();
    peripherals.driveRotate.mockClear();
    const valid = { instanceId: 'knob1', delta: 2 };
    const bad: unknown[] = [
      { ...valid, instanceId: '' },
      { ...valid, instanceId: 7 },
      { ...valid, delta: Number.NaN },
      { ...valid, delta: Number.POSITIVE_INFINITY },
      { ...valid, delta: 1000 }, // beyond the 256-detent anti-flood cap
      { ...valid, delta: 'spin' },
      null,
    ];
    for (const payload of bad) {
      await expect(handler!(undefined, payload)).rejects.toThrow('[BB-204]');
    }
    expect(peripherals.driveRotate).not.toHaveBeenCalled();
  });

  it('routes per:captureChunk to PeripheralManager.feedCapture (P3.2)', async () => {
    const handler = state.handles.get('per:captureChunk');
    expect(handler).toBeDefined();
    await handler!(undefined, { instanceId: 'mic1', rate: 48000, samples: [0, 0.5, -0.5] });
    expect(peripherals.feedCapture).toHaveBeenCalledWith('mic1', { rate: 48000, samples: [0, 0.5, -0.5] });
  });

  it('rejects malformed per:captureChunk payloads with [BB-202] (P3.2)', async () => {
    const handler = state.handles.get('per:captureChunk');
    expect(handler).toBeDefined();
    peripherals.feedCapture.mockClear();
    const valid = { instanceId: 'mic1', rate: 48000, samples: [0] };
    const bad: unknown[] = [
      { ...valid, instanceId: '' },
      { ...valid, instanceId: 7 },
      { ...valid, rate: NaN },
      { ...valid, rate: 500 }, // below the 1kHz floor
      { ...valid, rate: 200000 }, // above the 192kHz ceiling
      { ...valid, samples: [] },
      { ...valid, samples: [0, Number.NaN] },
      { ...valid, samples: 'pcm' },
      null,
    ];
    for (const payload of bad) {
      await expect(handler!(undefined, payload)).rejects.toThrow('[BB-202]');
    }
    expect(peripherals.feedCapture).not.toHaveBeenCalled();
  });

  it('routes proj:save through ProjectManager with both persistence halves', async () => {
    const netlist = { version: 1, chip: 'esp32', peripherals: [], wires: [] };
    const layout = { version: 1, items: [] };
    const handler = state.handles.get('proj:save');
    expect(handler).toBeDefined();
    await handler!(undefined, { netlist, layout });
    expect(project.saveProject).toHaveBeenCalledWith(netlist, layout);
  });

  it('routes proj:open to ProjectManager and returns its validated ProjectData', async () => {
    const data = { dir: '/tmp/p', meta: { version: 1, createdAt: 1, updatedAt: 2 }, netlist: {}, layout: {}, firmwareElf: null };
    project.openProject.mockReturnValueOnce(data);
    const handler = state.handles.get('proj:open');
    expect(handler).toBeDefined();
    await expect(handler!(undefined, { dir: '/tmp/p' })).resolves.toBe(data);
    expect(project.openProject).toHaveBeenCalledWith('/tmp/p');
  });

  it('routes proj:saveAs as fresh skeleton + full save', async () => {
    const netlist = { version: 1, chip: 'esp32', peripherals: [], wires: [] };
    const layout = { version: 1, items: [] };
    const handler = state.handles.get('proj:saveAs');
    expect(handler).toBeDefined();
    await handler!(undefined, { dir: '/tmp/p2', netlist, layout });
    expect(project.newProject).toHaveBeenCalledWith('/tmp/p2');
    expect(project.saveProject).toHaveBeenCalledWith(netlist, layout);
  });

  it('routes proj:new with the wizard chip/template picks and returns ProjectData (P4.2)', async () => {
    const data = { dir: '/tmp/w', meta: { version: 1, createdAt: 1, updatedAt: 2 }, netlist: {}, layout: {}, firmwareElf: null };
    project.newProject.mockReturnValueOnce(data);
    const handler = state.handles.get('proj:new');
    expect(handler).toBeDefined();
    await expect(handler!(undefined, { dir: '/tmp/w', chip: 'esp32s3', template: 'blink-led' })).resolves.toBe(data);
    expect(project.newProject).toHaveBeenCalledWith('/tmp/w', { chip: 'esp32s3', template: 'blink-led' });
  });

  it('routes proj:new without options (legacy callers keep working)', async () => {
    project.newProject.mockClear();
    const handler = state.handles.get('proj:new');
    await handler!(undefined, { dir: '/tmp/plain' });
    expect(project.newProject).toHaveBeenCalledWith('/tmp/plain', { chip: undefined, template: undefined });
  });

  it('rejects malformed proj:new payloads with [BB-126] (P4.2)', async () => {
    const handler = state.handles.get('proj:new');
    expect(handler).toBeDefined();
    project.newProject.mockClear();
    const bad: unknown[] = [
      { dir: '' },
      { dir: 42 },
      { dir: '/tmp/x', chip: 'esp32h2' }, // out-of-contract chip string
      { dir: '/tmp/x', chip: 7 },
      { dir: '/tmp/x', template: '' },
      { dir: '/tmp/x', template: 5 },
      null,
    ];
    for (const payload of bad) {
      await expect(handler!(undefined, payload)).rejects.toThrow('[BB-126]');
    }
    expect(project.newProject).not.toHaveBeenCalled();
  });

  it('routes proj:linkExternal to ProjectManager and returns its scan (P4.3)', async () => {
    const scan = { link: { kind: 'platformio', dir: '/tmp/pio' }, candidates: [] };
    project.linkExternalProject.mockReturnValueOnce(scan);
    const handler = state.handles.get('proj:linkExternal');
    expect(handler).toBeDefined();
    await expect(handler!(undefined, { dir: '/tmp/pio' })).resolves.toBe(scan);
    expect(project.linkExternalProject).toHaveBeenCalledWith('/tmp/pio');
  });

  it('rejects malformed proj:linkExternal payloads with [BB-130] (P4.3)', async () => {
    const handler = state.handles.get('proj:linkExternal');
    expect(handler).toBeDefined();
    project.linkExternalProject.mockClear();
    const bad: unknown[] = [{ dir: '' }, { dir: 42 }, {}, null];
    for (const payload of bad) {
      await expect(handler!(undefined, payload)).rejects.toThrow('[BB-130]');
    }
    expect(project.linkExternalProject).not.toHaveBeenCalled();
  });

  it('routes proj:unlinkExternal and proj:scanExternal without payloads (P4.3)', async () => {
    const scan = { link: { kind: 'esp-idf', dir: '/tmp/idf' }, candidates: [{ path: '/tmp/idf/build/app.elf' }] };
    project.scanExternalFirmware.mockReturnValueOnce(scan);
    await expect(state.handles.get('proj:unlinkExternal')!(undefined)).resolves.toBeUndefined();
    expect(project.unlinkExternalProject).toHaveBeenCalledTimes(1);
    await expect(state.handles.get('proj:scanExternal')!(undefined)).resolves.toBe(scan);
    expect(project.scanExternalFirmware).toHaveBeenCalledTimes(1);
  });

  it('routes proj:importExternal with and without an elfPath (P4.3)', async () => {
    const handler = state.handles.get('proj:importExternal');
    expect(handler).toBeDefined();
    project.importExternalFirmware.mockResolvedValue('/tmp/p/firmware.elf');
    await expect(handler!(undefined, { elfPath: '/tmp/pio/build/a/firmware.elf' })).resolves.toBe('/tmp/p/firmware.elf');
    expect(project.importExternalFirmware).toHaveBeenCalledWith('/tmp/pio/build/a/firmware.elf');
    // No payload at all (bare invoke) picks the newest candidate.
    await expect(handler!(undefined)).resolves.toBe('/tmp/p/firmware.elf');
    expect(project.importExternalFirmware).toHaveBeenCalledWith(undefined);
    // An explicit empty options object is also accepted.
    await expect(handler!(undefined, {})).resolves.toBe('/tmp/p/firmware.elf');
    expect(project.importExternalFirmware).toHaveBeenCalledWith(undefined);
  });

  it('rejects malformed proj:importExternal payloads with [BB-130] (P4.3)', async () => {
    const handler = state.handles.get('proj:importExternal');
    expect(handler).toBeDefined();
    project.importExternalFirmware.mockClear();
    const bad: unknown[] = [{ elfPath: '' }, { elfPath: 42 }, [], 'x'];
    for (const payload of bad) {
      await expect(handler!(undefined, payload)).rejects.toThrow('[BB-130]');
    }
    expect(project.importExternalFirmware).not.toHaveBeenCalled();
  });

  it('forwards GDB stops on dbg:stopped with the payload intact', () => {
    const info = { reason: 'breakpoint-hit', frame: { addr: '0x40080024', func: 'app_main' } };
    listenerFor(gdb, 'stopped')(info);
    expect(state.sends).toContainEqual({ channel: 'dbg:stopped', payload: info });
  });

  it('rejects dbg:connect with no firmware loaded (P1.9)', async () => {
    const handler = state.handles.get('dbg:connect');
    await expect(handler!(undefined)).rejects.toThrow(/\[BB-115\] no firmware loaded/);
    expect(gdb.start).not.toHaveBeenCalled();
  });

  it('routes dbg:connect through QemuRunner stub port + firmware ELF (P1.9)', async () => {
    const prevBin = process.env.BREADESP_GDB_BIN;
    process.env.BREADESP_GDB_BIN = '/opt/xtensa/bin/xtensa-esp32-elf-gdb';
    qemu.getGdbPort.mockReturnValueOnce(3333);
    qemu.getFirmwareElf.mockReturnValueOnce('/tmp/blink.elf');
    try {
      const handler = state.handles.get('dbg:connect');
      expect(handler).toBeDefined();
      await expect(handler!(undefined)).resolves.toEqual({ connected: true });
      expect(gdb.start).toHaveBeenCalledWith({
        gdbBin: '/opt/xtensa/bin/xtensa-esp32-elf-gdb',
        elfPath: '/tmp/blink.elf',
        targetHost: '127.0.0.1',
        port: 3333,
      });
    } finally {
      if (prevBin === undefined) delete process.env.BREADESP_GDB_BIN;
      else process.env.BREADESP_GDB_BIN = prevBin;
    }
  });

  it('routes sim:step through GDB only when attached (P1.9)', async () => {
    const handler = state.handles.get('sim:step');
    gdb.isConnected.mockReturnValueOnce(false);
    await expect(handler!(undefined)).rejects.toThrow(/\[BB-105\].*dbg:connect/);
    gdb.isConnected.mockReturnValueOnce(true);
    await expect(handler!(undefined)).resolves.toBeUndefined();
    expect(gdb.step).toHaveBeenCalledTimes(1);
  });
});
