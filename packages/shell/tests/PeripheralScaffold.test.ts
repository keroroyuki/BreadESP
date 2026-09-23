// PRD: §F-EXT-4, dev-plan P5.3 — PeripheralScaffold tests. The generator is
// covered at four layers: request normalization (pure), package building
// (pure, self-checked against the P5.2 manifest validator), disk writes (real
// temp dirs), and the M5 acceptance — a scaffolded package is publishable: it
// scans 'ok', loads through the real PluginCatalog, and its model consumes
// routed transactions exactly like a built-in. The registry is shared within
// this file, so scaffolded kinds are unique to it.
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PERIPHERAL_SDK_VERSION, getFactory, registerBuiltins, type RenderSnapshot } from '@breadesp/peripherals';
import { PERIPHERAL_MANIFEST_FILE, PluginCatalog, validatePeripheralManifest } from '../src/peripherals/PluginCatalog.js';
import { PeripheralManager } from '../src/peripherals/PeripheralManager.js';
import {
  SCAFFOLD_ENTRY_FILE,
  SCAFFOLD_PACKAGE_VERSION,
  SCAFFOLD_README_FILE,
  SCAFFOLD_SELF_CHECK_FILE,
  buildPeripheralPackage,
  normalizeScaffoldRequest,
  writePeripheralPackage,
} from '../src/peripherals/PeripheralScaffold.js';
import { parseScaffoldArgs, runScaffoldCli, SCAFFOLD_USAGE, type ScaffoldCliIO } from '../src/peripherals/scaffold-cli.js';

registerBuiltins();

const tmp = mkdtempSync(join(tmpdir(), 'breadesp-scaffold-'));
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

let seq = 0;
/** Fresh parent directory per test. */
async function makeParent(): Promise<string> {
  const dir = join(tmp, `parent-${seq++}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Capturing IO seam for the CLI. */
function captureIo(cwd: string): ScaffoldCliIO & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    cwd,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
  };
}

describe('normalizeScaffoldRequest — request gate ([BB-230])', () => {
  it('derives kind, displayName and dirName from a plain kebab name', () => {
    const req = normalizeScaffoldRequest({ name: 'acme-matrix' });
    expect(req).toEqual({ name: 'acme-matrix', kind: 'acme-matrix', displayName: 'Acme Matrix' });
  });

  it('strips the @scope for kind/dirName and keeps explicit metadata', () => {
    const req = normalizeScaffoldRequest({
      name: '@acme/matrix-driver',
      displayName: 'Matrix Driver Pro',
      description: 'Drives 8x8 matrices',
    });
    expect(req).toEqual({
      name: '@acme/matrix-driver',
      kind: 'matrix-driver',
      displayName: 'Matrix Driver Pro',
      description: 'Drives 8x8 matrices',
    });
  });

  it('rejects malformed names with [BB-230]', () => {
    for (const name of ['', 'Acme', 'acme_matrix', 'acme matrix', '-acme', 'acme-', '@acme', '@/acme']) {
      expect(() => normalizeScaffoldRequest({ name }), `name=${name}`).toThrow(/\[BB-230\] invalid scaffold request:.*name must be/);
    }
    // A non-object request is a boundary violation, not a TypeError.
    for (const bogus of [null, undefined, 42]) {
      expect(() => normalizeScaffoldRequest(bogus as unknown as { name: string })).toThrow(
        '[BB-230] invalid scaffold request: request must be an object',
      );
    }
  });

  it('lists every violation in one [BB-230] error', () => {
    let message = '';
    try {
      normalizeScaffoldRequest({ name: 'Bad Name', displayName: '  ', description: 'two\nlines' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^\[BB-230\] invalid scaffold request: /);
    expect(message).toMatch(/name must be/);
    expect(message).toMatch(/displayName must be a non-empty string/);
    expect(message).toMatch(/description must be a single line/);
  });

  it('rejects a kind colliding with a registered kind early (would-be [BB-221])', () => {
    expect(() => normalizeScaffoldRequest({ name: 'led' }, ['led', 'button'])).toThrow(
      /\[BB-230\].*kind 'led' collides with an already-registered peripheral kind/,
    );
    // A scoped package whose unscoped part collides is rejected too.
    expect(() => normalizeScaffoldRequest({ name: '@acme/led' }, ['led'])).toThrow(/\[BB-230\].*'led' collides/);
    // No collision -> accepted.
    expect(normalizeScaffoldRequest({ name: 'led' }, ['button']).kind).toBe('led');
  });

  it('rejects multi-line displayName (it is embedded into generated files)', () => {
    expect(() => normalizeScaffoldRequest({ name: 'ok-name', displayName: 'line1\nline2' })).toThrow(
      /\[BB-230\].*displayName must be a single line/,
    );
  });
});

describe('buildPeripheralPackage — pure generation, self-checked', () => {
  const req = normalizeScaffoldRequest({ name: 'acme-matrix', description: '8x8 matrix' });
  const pkg = buildPeripheralPackage(req);

  it('emits exactly the four contracted files (PRD §F-EXT-4)', () => {
    expect(pkg.dirName).toBe('acme-matrix');
    expect(Object.keys(pkg.files)).toEqual([
      PERIPHERAL_MANIFEST_FILE,
      SCAFFOLD_ENTRY_FILE,
      SCAFFOLD_README_FILE,
      SCAFFOLD_SELF_CHECK_FILE,
    ]);
  });

  it('emits a manifest the P5.2 catalog validator accepts with zero issues', () => {
    const parsed: unknown = JSON.parse(pkg.files[PERIPHERAL_MANIFEST_FILE]);
    const { manifest, issues } = validatePeripheralManifest(parsed);
    expect(issues).toEqual([]);
    expect(manifest).toEqual({
      manifestVersion: 1,
      name: 'acme-matrix',
      version: SCAFFOLD_PACKAGE_VERSION,
      displayName: 'Acme Matrix',
      description: '8x8 matrix',
      entry: SCAFFOLD_ENTRY_FILE,
      sdkVersion: PERIPHERAL_SDK_VERSION,
      provides: ['acme-matrix'],
    });
  });

  it('omits the description when none was given', () => {
    const bare = buildPeripheralPackage(normalizeScaffoldRequest({ name: 'bare-pack' }));
    const parsed = JSON.parse(bare.files[PERIPHERAL_MANIFEST_FILE]) as Record<string, unknown>;
    expect('description' in parsed).toBe(false);
    expect(validatePeripheralManifest(parsed).issues).toEqual([]);
  });

  it('embeds the host-API entry contract and the derived class name', () => {
    const entry = pkg.files[SCAFFOLD_ENTRY_FILE];
    expect(entry).toContain('export default function register(host)');
    expect(entry).toContain("kind: 'acme-matrix'");
    expect(entry).toContain('sdkVersion: host.PERIPHERAL_SDK_VERSION');
    expect(entry).toContain('class AcmeMatrix');
    expect(entry).toContain("role: 'gpio-out'");
  });

  it('keeps class names valid identifiers for digit-leading kinds', () => {
    const digit = buildPeripheralPackage(normalizeScaffoldRequest({ name: '7seg-display' }));
    expect(digit.files[SCAFFOLD_ENTRY_FILE]).toContain('class Peripheral7segDisplay');
  });

  it('ships a README with install/load/develop guidance and a self-check', () => {
    const readme = pkg.files[SCAFFOLD_README_FILE];
    expect(readme).toContain('Peripheral catalog');
    expect(readme).toContain('BREADESP_PERIPHERALS_DIR');
    expect(readme).toContain('8x8 matrix');
    const selfCheck = pkg.files[SCAFFOLD_SELF_CHECK_FILE];
    expect(selfCheck).toContain('node self-check.mjs');
    expect(selfCheck).toContain("factory.kind === 'acme-matrix'");
  });
});

describe('writePeripheralPackage — disk writes', () => {
  it('creates the package dir (and missing parents) with contents matching the pure build', async () => {
    const parent = join(tmp, 'deeply', 'nested', 'parent');
    const req = normalizeScaffoldRequest({ name: 'write-me' });
    const result = await writePeripheralPackage(parent, req);
    expect(result.dir).toBe(join(parent, 'write-me'));
    expect(result.files).toEqual([PERIPHERAL_MANIFEST_FILE, SCAFFOLD_ENTRY_FILE, SCAFFOLD_README_FILE, SCAFFOLD_SELF_CHECK_FILE]);
    const expected = buildPeripheralPackage(req);
    for (const [file, content] of Object.entries(expected.files)) {
      await expect(readFile(join(result.dir, file), 'utf8')).resolves.toBe(content);
    }
  });

  it('uses an existing EMPTY directory but refuses a non-empty one ([BB-231], no overwrite)', async () => {
    const parent = await makeParent();
    const req = normalizeScaffoldRequest({ name: 'target-pack' });
    // Existing empty dir: fine.
    await mkdir(join(parent, 'target-pack'));
    const first = await writePeripheralPackage(parent, req);
    expect(first.files).toHaveLength(4);
    // Now it is non-empty: refused, and nothing is overwritten.
    await expect(writePeripheralPackage(parent, req)).rejects.toThrow(/\[BB-231\].*already exists and is not empty/);
    await expect(readFile(join(first.dir, PERIPHERAL_MANIFEST_FILE), 'utf8')).resolves.toContain('"name": "target-pack"');
    // A pre-existing unrelated file is equally protective.
    const parent2 = await makeParent();
    const occupied = join(parent2, 'occupied-pack');
    await mkdir(occupied);
    await writeFile(join(occupied, 'keep.txt'), 'precious');
    await expect(writePeripheralPackage(parent2, normalizeScaffoldRequest({ name: 'occupied-pack' }))).rejects.toThrow('[BB-231]');
    await expect(readFile(join(occupied, 'keep.txt'), 'utf8')).resolves.toBe('precious');
  });

  it('fails cleanly when the parent path is a file (nothing created)', async () => {
    const parent = await makeParent();
    const fileParent = join(parent, 'not-a-dir');
    await writeFile(fileParent, 'x');
    await expect(writePeripheralPackage(fileParent, normalizeScaffoldRequest({ name: 'no-room' }))).rejects.toThrow();
  });
});

describe('scaffolded package is publishable (M5 acceptance, PRD §F-EXT-4)', () => {
  it('scans ok, loads through the real catalog, and consumes routed transactions like a built-in', async () => {
    const root = await makeParent();
    const req = normalizeScaffoldRequest({ name: 'scaf-led', description: 'Scaffolded LED' });
    const { dir } = await writePeripheralPackage(root, req);
    const catalog = new PluginCatalog(root);

    // Discovery: the scaffolded package is a first-class catalog entry.
    const scan = await catalog.scan();
    expect(scan.entries).toHaveLength(1);
    expect(scan.entries[0]).toMatchObject({ dir, status: 'ok', issues: [], loaded: false });
    expect(scan.entries[0].manifest).toMatchObject({
      name: 'scaf-led',
      sdkVersion: PERIPHERAL_SDK_VERSION,
      provides: ['scaf-led'],
    });

    // Load: the entry registers the factory through the host API.
    const loaded = await catalog.load(dir);
    expect(loaded.kinds).toEqual(['scaf-led']);
    expect(loaded.factories).toEqual([
      {
        kind: 'scaf-led',
        version: SCAFFOLD_PACKAGE_VERSION,
        displayName: 'Scaf Led',
        pins: [
          { id: 'A', role: 'gpio-out' },
          { id: 'K', role: 'gnd', optional: true },
        ],
        sdkVersion: PERIPHERAL_SDK_VERSION,
      },
    ]);
    expect(getFactory('scaf-led')).toBeDefined();

    // Consumption: the same route() path every built-in peripheral takes.
    let now = 0;
    const pm = new PeripheralManager(() => now);
    const snaps: RenderSnapshot[] = [];
    pm.on('snapshot', (s: RenderSnapshot) => snaps.push(s));
    pm.applyNetlist({
      version: 1,
      chip: 'esp32',
      peripherals: [{ instanceId: 'sl1', kind: 'scaf-led' }],
      wires: [{ id: 'w1', from: { instanceId: 'mcu', pin: 'GPIO4' }, to: { instanceId: 'sl1', pin: 'A' } }],
    });
    pm.route({ kind: 'gpio', bus: 0, target: 4, dir: 'write', data: Uint8Array.from([1]), ts: 0 });
    now += 100; // past the 30fps throttle window, so the second write emits immediately
    pm.route({ kind: 'gpio', bus: 0, target: 4, dir: 'write', data: Uint8Array.from([0]), ts: 1 });
    expect(snaps).toEqual([
      { instanceId: 'sl1', type: 'level', payload: { level: 1 } },
      { instanceId: 'sl1', type: 'level', payload: { level: 0 } },
    ]);
    pm.dispose();
  });

  it('generated self-check passes standalone (node self-check.mjs) and gates a broken entry', async () => {
    const root = await makeParent();
    const { dir } = await writePeripheralPackage(root, normalizeScaffoldRequest({ name: 'scaf-check' }));
    const okRun = spawnSync(process.execPath, [join(dir, SCAFFOLD_SELF_CHECK_FILE)], { encoding: 'utf8', timeout: 30000 });
    expect(okRun.status).toBe(0);
    expect(okRun.stdout).toContain("SELF-CHECK OK — scaf-check registers 'scaf-check' and the model behaves");

    // The self-check is a real gate: an entry that registers nothing fails it.
    await writeFile(join(dir, SCAFFOLD_ENTRY_FILE), 'export const marker = 1;\n');
    const badRun = spawnSync(process.execPath, [join(dir, SCAFFOLD_SELF_CHECK_FILE)], { encoding: 'utf8', timeout: 30000 });
    expect(badRun.status).toBe(1);
    expect(badRun.stderr).toContain('SELF-CHECK FAILED');
    expect(badRun.stderr).toContain('default-export the registration function');
  });
});

describe('scaffold CLI (parseScaffoldArgs / runScaffoldCli)', () => {
  it('parses the full flag set and defaults', () => {
    expect(parseScaffoldArgs(['acme-matrix'])).toEqual({ help: false, request: { name: 'acme-matrix' } });
    expect(parseScaffoldArgs(['@acme/mx', '--display-name', 'Mx', '--description', 'd', '--into', 'packages'])).toEqual({
      help: false,
      request: { name: '@acme/mx', displayName: 'Mx', description: 'd' },
      into: 'packages',
    });
    expect(parseScaffoldArgs(['--help'])).toMatchObject({ help: true });
    expect(parseScaffoldArgs(['-h'])).toMatchObject({ help: true });
  });

  it('rejects usage errors as coded [BB-230] strings', () => {
    expect(parseScaffoldArgs([]).error).toBe('[BB-230] missing package name');
    expect(parseScaffoldArgs(['--nope']).error).toBe("[BB-230] unknown option '--nope'");
    expect(parseScaffoldArgs(['x', '--display-name']).error).toBe('[BB-230] option --display-name needs a value');
    expect(parseScaffoldArgs(['x', '--into', '--description']).error).toBe('[BB-230] option --into needs a value');
    expect(parseScaffoldArgs(['a', 'b']).error).toBe("[BB-230] unexpected extra argument 'b' (exactly one package name)");
  });

  it('--help prints usage to stdout and exits 0', async () => {
    const io = captureIo(tmp);
    await expect(runScaffoldCli(['--help'], io)).resolves.toBe(0);
    expect(io.outLines.join('\n')).toContain('Usage: pnpm create-peripheral');
    expect(io.errLines).toEqual([]);
  });

  it('usage errors print the coded error + usage to stderr and exit 2', async () => {
    const io = captureIo(tmp);
    await expect(runScaffoldCli([], io)).resolves.toBe(2);
    expect(io.errLines[0]).toBe('[BB-230] missing package name');
    expect(io.errLines[1]).toBe(SCAFFOLD_USAGE);
  });

  it('rejects a name whose kind collides with a built-in (exit 2, nothing written)', async () => {
    const parent = await makeParent();
    const io = captureIo(parent);
    await expect(runScaffoldCli(['led'], io)).resolves.toBe(2);
    expect(io.errLines.join('\n')).toMatch(/\[BB-230\].*kind 'led' collides/);
    // The invalid request never reached the disk.
    await expect(readFile(join(parent, 'led', PERIPHERAL_MANIFEST_FILE), 'utf8')).rejects.toThrow();
  });

  it('creates a package via the CLI path and prints next steps (exit 0)', async () => {
    const parent = await makeParent();
    const io = captureIo(parent);
    const code = await runScaffoldCli(['scaf-cli', '--display-name', 'CLI Pack', '--into', parent], io);
    expect(code).toBe(0);
    expect(io.errLines).toEqual([]);
    const text = io.outLines.join('\n');
    expect(text).toContain("Created peripheral package 'scaf-cli' (kind 'scaf-cli')");
    expect(text).toContain('Next steps:');
    expect(text).toContain('self-check.mjs');
    // The CLI-written package is identical to the library build.
    const expected = buildPeripheralPackage(normalizeScaffoldRequest({ name: 'scaf-cli', displayName: 'CLI Pack' }));
    for (const [file, content] of Object.entries(expected.files)) {
      await expect(readFile(join(parent, 'scaf-cli', file), 'utf8')).resolves.toBe(content);
    }
  });

  it('propagates [BB-231] when the target exists (exit 2)', async () => {
    const parent = await makeParent();
    await mkdir(join(parent, 'taken-pack'));
    await writeFile(join(parent, 'taken-pack', 'x.txt'), 'x');
    const io = captureIo(parent);
    await expect(runScaffoldCli(['taken-pack'], io)).resolves.toBe(2);
    expect(io.errLines.join('\n')).toContain('[BB-231]');
  });
});
