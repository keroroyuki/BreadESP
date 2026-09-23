// PRD: §F-EXT-4 — P5.3 manual smoke (plain Node runtime via tsx, NOT vitest):
// the real user journey — scaffold a package with the CLI path, then walk the
// generated package through the catalog like a hand-written one: scan, load,
// wire into a netlist, route a transaction, and run its self-check standalone.
// Run: pnpm --filter @breadesp/shell exec tsx tests/manual-smoke-p53.ts
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBuiltins, getFactory } from '@breadesp/peripherals';
import { PluginCatalog } from '../src/peripherals/PluginCatalog.js';
import { PeripheralManager } from '../src/peripherals/PeripheralManager.js';
import { runScaffoldCli } from '../src/peripherals/scaffold-cli.js';

const root = mkdtempSync(join(tmpdir(), 'breadesp-p53-smoke-'));

try {
  registerBuiltins();
  const out: string[] = [];
  const code = await runScaffoldCli(['smoke-lamp', '--description', 'P5.3 smoke lamp', '--into', root], {
    out: (l) => out.push(l),
    err: (l) => { throw new Error(`scaffold errored: ${l}`); },
    cwd: root,
  });
  console.log('scaffold:', JSON.stringify({ code, firstLine: out[0] }));
  if (code !== 0) throw new Error('scaffold failed');

  const pkgDir = join(root, 'smoke-lamp');
  const catalog = new PluginCatalog(root);
  const scan = await catalog.scan();
  console.log('scan:', JSON.stringify(scan.entries.map((e) => [e.manifest?.name, e.status])));
  if (scan.entries.length !== 1 || scan.entries[0].status !== 'ok') throw new Error('scan failed');

  const loaded = await catalog.load(scan.entries[0].dir);
  console.log('load:', JSON.stringify(loaded));
  if (loaded.kinds[0] !== 'smoke-lamp' || getFactory('smoke-lamp') === undefined) throw new Error('load failed');

  const pm = new PeripheralManager();
  const snaps: unknown[] = [];
  pm.on('snapshot', (s) => snaps.push(s));
  pm.applyNetlist({
    version: 1, chip: 'esp32',
    peripherals: [{ instanceId: 'lamp1', kind: 'smoke-lamp' }],
    wires: [{ id: 'w1', from: { instanceId: 'mcu', pin: 'GPIO5' }, to: { instanceId: 'lamp1', pin: 'A' } }],
  });
  pm.route({ kind: 'gpio', bus: 0, target: 5, dir: 'write', data: Uint8Array.from([1]), ts: 1 });
  console.log('snapshots:', JSON.stringify(snaps));
  if (snaps.length !== 1) throw new Error('routing failed');
  pm.dispose();

  const selfCheck = spawnSync(process.execPath, [join(pkgDir, 'self-check.mjs')], { encoding: 'utf8' });
  console.log('self-check:', JSON.stringify({ status: selfCheck.status, stdout: selfCheck.stdout.trim() }));
  if (selfCheck.status !== 0) throw new Error('self-check failed');

  console.log('SMOKE OK');
} finally {
  rmSync(root, { recursive: true, force: true });
}
