// PRD: §F-EXT-3 — P5.2 manual smoke (plain Node runtime, NOT vitest):
// simulates the app's real user journey — drop a package into the local
// peripherals root, scan, load, wire it into a netlist, route a transaction.
// Run: pnpm --filter @breadesp/shell exec tsx tests/manual-smoke-p52.ts
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBuiltins, getFactory } from '@breadesp/peripherals';
import { PluginCatalog, PERIPHERAL_MANIFEST_FILE } from '../src/peripherals/PluginCatalog.js';
import { PeripheralManager } from '../src/peripherals/PeripheralManager.js';

const root = mkdtempSync(join(tmpdir(), 'breadesp-p52-smoke-'));
const pkg = join(root, 'acme-led');
mkdirSync(pkg, { recursive: true });
writeFileSync(join(pkg, PERIPHERAL_MANIFEST_FILE), JSON.stringify({
  manifestVersion: 1, name: 'acme-led', version: '1.0.0',
  displayName: 'Smoke LED', entry: 'index.mjs', sdkVersion: '1.0.0', provides: ['smoke-led'],
}));
writeFileSync(join(pkg, 'index.mjs'), `export default function register(host) {
  host.registerPeripheral({
    kind: 'smoke-led', version: '1.0.0', displayName: 'Smoke LED',
    sdkVersion: host.PERIPHERAL_SDK_VERSION,
    pins: [{ id: 'A', role: 'gpio-out' }],
    create: (ctx, props) => {
      const id = String(props?.instanceId ?? 'x');
      return { kind: 'smoke-led', instanceId: id,
        onTransaction(tx) {
          if (tx.kind === 'gpio' && tx.dir === 'write')
            ctx.emitSnapshot({ instanceId: id, type: 'level', payload: { level: tx.data[0] ? 1 : 0 } });
        } };
    },
  });
}`);

try {
  registerBuiltins();
  const catalog = new PluginCatalog(root);
  const scan = await catalog.scan();
  console.log('scan:', JSON.stringify({ rootDir: scan.rootDir === root, entries: scan.entries.map((e) => [e.manifest?.name, e.status]) }));
  if (scan.entries.length !== 1 || scan.entries[0].status !== 'ok') throw new Error('scan failed');

  const loaded = await catalog.load(scan.entries[0].dir);
  console.log('load:', JSON.stringify(loaded));
  if (loaded.kinds[0] !== 'smoke-led' || getFactory('smoke-led') === undefined) throw new Error('load failed');

  const pm = new PeripheralManager();
  const snaps: unknown[] = [];
  pm.on('snapshot', (s) => snaps.push(s));
  pm.applyNetlist({
    version: 1, chip: 'esp32',
    peripherals: [{ instanceId: 'sl1', kind: 'smoke-led' }],
    wires: [{ id: 'w1', from: { instanceId: 'mcu', pin: 'GPIO2' }, to: { instanceId: 'sl1', pin: 'A' } }],
  });
  pm.route({ kind: 'gpio', bus: 0, target: 2, dir: 'write', data: Uint8Array.from([1]), ts: 1 });
  console.log('snapshots:', JSON.stringify(snaps));
  if (snaps.length !== 1) throw new Error('routing failed');
  console.log('SMOKE OK');
} finally {
  rmSync(root, { recursive: true, force: true });
}
