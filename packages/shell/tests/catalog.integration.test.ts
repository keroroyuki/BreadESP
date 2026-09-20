// PRD: §F-EXT-3, §6.6, dev-plan task P5.2 — local peripheral catalog over the
// real IPC surface: preload API -> ipcMain handler -> real PluginCatalog ->
// real registry -> real PeripheralManager consumption, with JSON round-trips
// on both IPC directions (PRD §6.6 requires JSON-serializable payloads).
// Acceptance: a package dropped into the local peripherals root is discovered
// by scan, loaded on request, and its model then consumes routed bus
// transactions exactly like a built-in kind.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBuiltins, type BusTransaction, type RenderSnapshot } from '@breadesp/peripherals';
import { PluginCatalog, type PeripheralCatalogLoadResult, type PeripheralCatalogScan } from '../src/peripherals/PluginCatalog.js';

/** The preload per surface P5.2 adds (payload/returns are JSON over the wire). */
interface PerApi {
  catalogScan: () => Promise<PeripheralCatalogScan>;
  catalogLoad: (p: { dir: string }) => Promise<PeripheralCatalogLoadResult>;
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
    // returns JSON too. Rejections propagate as Error objects (Electron
    // preserves the message on invoke rejections).
    invoke: (channel: string, payload?: unknown) => {
      const handler = state.handles.get(channel);
      if (!handler) return Promise.reject(new Error(`no handler for ${channel}`));
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
import { PeripheralManager } from '../src/peripherals/PeripheralManager.js';

registerBuiltins();

const tmp = mkdtempSync(join(tmpdir(), 'breadesp-p52-e2e-'));
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

/** A self-contained host-API plugin whose model levels up on gpio writes. */
const PLUG_LED_ENTRY = `export default function register(host) {
  host.registerPeripheral({
    kind: 'plug-led',
    version: '1.2.0',
    displayName: 'Plugin LED',
    pins: [{ id: 'A', role: 'gpio-out' }, { id: 'K', role: 'gnd', optional: true }],
    sdkVersion: host.PERIPHERAL_SDK_VERSION,
    create: (ctx, props) => {
      const instanceId = String(props?.instanceId ?? 'plug');
      return {
        kind: 'plug-led',
        instanceId,
        onTransaction(tx) {
          if (tx.kind !== 'gpio' || tx.dir !== 'write') return;
          ctx.emitSnapshot({ instanceId, type: 'level', payload: { level: tx.data[0] ? 1 : 0 } });
        },
      };
    },
  });
}
`;

let peripherals: PeripheralManager;

beforeAll(async () => {
  const packDir = join(tmp, 'root', 'acme-led');
  await mkdir(packDir, { recursive: true });
  await writeFile(join(packDir, 'breadesp-peripheral.json'), JSON.stringify({
    manifestVersion: 1,
    name: 'acme-led',
    version: '1.2.0',
    displayName: 'Plugin LED',
    description: 'Test plugin package',
    entry: 'index.mjs',
    provides: ['plug-led'],
  }));
  await writeFile(join(packDir, 'index.mjs'), PLUG_LED_ENTRY);

  // Stubs mirror only the surface registerIpcHandlers touches — the catalog
  // and peripheral paths under test are the real PluginCatalog (rooted at the
  // temp dir) and the real PeripheralManager.
  const qemu = { load: vi.fn(), start: vi.fn(), pause: vi.fn(), reset: vi.fn(), getStatus: vi.fn(), getGdbPort: vi.fn(), getFirmwareElf: vi.fn(), on: vi.fn() };
  const gdb = { start: vi.fn(), stop: vi.fn(), isConnected: vi.fn(), setBreakpoint: vi.fn(), removeBreakpoint: vi.fn(), clearBreakpoints: vi.fn(), listBreakpoints: vi.fn(), continue: vi.fn(), step: vi.fn(), stepOver: vi.fn(), vars: vi.fn(), regs: vi.fn(), evaluate: vi.fn(), on: vi.fn() };
  const project = { loadNetlist: vi.fn() };
  peripherals = new PeripheralManager();
  await registerIpcHandlers({
    project, qemu, gdb, peripherals,
    catalog: new PluginCatalog(join(tmp, 'root')),
  } as unknown as Parameters<typeof registerIpcHandlers>[0]);
});

describe('local peripheral catalog over the real IPC surface (P5.2)', () => {
  // Boundary cast: the mocked contextBridge captured the preload API object.
  const per = (state.api as { per: PerApi }).per;

  it('scan discovers the dropped-in package with its manifest', async () => {
    const scan = await per.catalogScan();
    expect(scan.rootDir).toBe(join(tmp, 'root'));
    expect(scan.entries).toHaveLength(1);
    expect(scan.entries[0]).toMatchObject({
      status: 'ok',
      issues: [],
      loaded: false,
      kinds: [],
      factories: [],
    });
    expect(scan.entries[0].manifest).toMatchObject({
      manifestVersion: 1,
      name: 'acme-led',
      version: '1.2.0',
      displayName: 'Plugin LED',
      entry: 'index.mjs',
    });
  });

  it('load registers the kind and returns renderer-mirror metadata as JSON', async () => {
    const dir = join(tmp, 'root', 'acme-led');
    const result = await per.catalogLoad({ dir });
    expect(result.dir).toBe(dir);
    expect(result.kinds).toEqual(['plug-led']);
    // The metadata must survive the JSON boundary intact (pins nested arrays included).
    expect(result.factories).toEqual([
      {
        kind: 'plug-led',
        version: '1.2.0',
        displayName: 'Plugin LED',
        pins: [{ id: 'A', role: 'gpio-out' }, { id: 'K', role: 'gnd', optional: true }],
        sdkVersion: '1.0.0',
      },
    ]);

    // A rescan now reports the package as loaded with its kinds + factories
    // (the renderer re-mirror path after a reload).
    const scan = await per.catalogScan();
    expect(scan.entries[0]).toMatchObject({ loaded: true, kinds: ['plug-led'] });
    expect(scan.entries[0].factories[0]?.kind).toBe('plug-led');
  });

  it('routes real bus transactions to the catalog-loaded model like a built-in', async () => {
    const snapshots: RenderSnapshot[] = [];
    peripherals.on('snapshot', (s: RenderSnapshot) => snapshots.push(s));

    const apply = state.handles.get('bb:applyNetlist');
    expect(apply).toBeDefined();
    await apply!(undefined, JSON.parse(JSON.stringify({
      version: 1,
      chip: 'esp32',
      peripherals: [{ instanceId: 'pl1', kind: 'plug-led' }],
      wires: [{ id: 'w1', from: { instanceId: 'mcu', pin: 'GPIO5' }, to: { instanceId: 'pl1', pin: 'A' } }],
    })));

    const tx: BusTransaction = { kind: 'gpio', bus: 0, target: 5, dir: 'write', data: Uint8Array.from([1]), ts: 1 };
    peripherals.route(tx);
    expect(snapshots).toEqual([{ instanceId: 'pl1', type: 'level', payload: { level: 1 } }]);
  });

  it('propagates [BB-224] for dirs outside the scan and [BB-225] for malformed payloads', async () => {
    await expect(per.catalogLoad({ dir: join(tmp, 'root', 'stranger') })).rejects.toThrow(/\[BB-224\]/);
    await expect(per.catalogLoad({ dir: '' })).rejects.toThrow(/\[BB-225\]/);
    // Boundary cast: deliberately malformed payload through the JSON boundary.
    await expect(per.catalogLoad({} as { dir: string })).rejects.toThrow(/\[BB-225\]/);
  });

  it('is idempotent across the IPC boundary (double Load click)', async () => {
    const dir = join(tmp, 'root', 'acme-led');
    const again = await per.catalogLoad({ dir });
    expect(again.kinds).toEqual(['plug-led']);
  });
});
