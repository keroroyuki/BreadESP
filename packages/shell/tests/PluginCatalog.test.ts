// PRD: §F-EXT-3, dev-plan P5.2 — PluginCatalog unit tests. Scanning is tested
// against real temp directories (the module is pure read-only fs); loading is
// tested with real entry modules through the host-API default-export contract
// (temp-dir packages cannot resolve '@breadesp/peripherals', which is exactly
// why the host-injected pattern is the supported one). The registry is shared
// within this file, so every test package registers distinct kinds.
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFactory, listPeripherals, PERIPHERAL_SDK_VERSION, registerBuiltins } from '@breadesp/peripherals';
import {
  PERIPHERAL_MANIFEST_FILE,
  PluginCatalog,
  validatePeripheralManifest,
  type PeripheralPackageManifest,
} from '../src/peripherals/PluginCatalog.js';

registerBuiltins();

const tmp = mkdtempSync(join(tmpdir(), 'breadesp-catalog-'));
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

let seq = 0;
/** Create a fresh catalog root with a unique path per test. */
async function makeRoot(): Promise<string> {
  const dir = join(tmp, `root-${seq++}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    name: 'acme-matrix',
    version: '0.3.1',
    displayName: 'Acme LED Matrix',
    description: '8x8 LED matrix driver',
    entry: 'index.mjs',
    sdkVersion: PERIPHERAL_SDK_VERSION,
    provides: ['acme-matrix'],
    ...overrides,
  };
}

/** Write a package dir into root with the given manifest + entry source. */
async function writePackage(
  root: string,
  dirName: string,
  manifest: Record<string, unknown> | string,
  entrySource: string | null,
  entryName = 'index.mjs',
): Promise<string> {
  const dir = join(root, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, PERIPHERAL_MANIFEST_FILE), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  if (entrySource !== null) await writeFile(join(dir, entryName), entrySource);
  return dir;
}

/** Entry source of a minimal host-API package registering the given kinds. */
function hostEntry(kinds: string[]): string {
  const registrations = kinds
    .map(
      (kind) => `host.registerPeripheral({
        kind: '${kind}', version: '1.0.0', displayName: '${kind} display',
        pins: [{ id: 'A', role: 'gpio-out' }],
        create: (ctx, props) => ({
          kind: '${kind}',
          instanceId: String(props?.instanceId ?? 'x'),
          onTransaction() {},
        }),
      });`,
    )
    .join('\n');
  return `export default function register(host) {\n${registrations}\n}\n`;
}

describe('validatePeripheralManifest — pure shape matrix (PRD §F-EXT-3)', () => {
  it('accepts a full valid manifest', () => {
    const { manifest, issues } = validatePeripheralManifest(validManifest());
    expect(issues).toEqual([]);
    expect(manifest).toMatchObject({ manifestVersion: 1, name: 'acme-matrix', entry: 'index.mjs' });
  });

  it('rejects non-objects and a wrong manifestVersion', () => {
    expect(validatePeripheralManifest(null).issues).toEqual(['manifest must be a JSON object']);
    expect(validatePeripheralManifest([1]).issues).toEqual(['manifest must be a JSON object']);
    expect(validatePeripheralManifest(validManifest({ manifestVersion: 2 })).issues[0]).toMatch(/manifestVersion must be 1/);
    expect(validatePeripheralManifest(validManifest({ manifestVersion: '1' })).issues[0]).toMatch(/manifestVersion must be 1/);
  });

  it('rejects malformed names and accepts plain and @scoped kebab names', () => {
    for (const name of ['', 'Acme', 'acme_matrix', 'acme matrix', '-acme', 'acme-', '@acme', '@/acme', 42]) {
      const { issues, manifest } = validatePeripheralManifest(validManifest({ name }));
      expect(manifest, `name=${String(name)}`).toBeNull();
      expect(issues.some((i) => i.includes('name'))).toBe(true);
    }
    for (const name of ['acme', 'acme-matrix', '@acme/matrix-driver', 'a']) {
      expect(validatePeripheralManifest(validManifest({ name })).issues, `name=${name}`).toEqual([]);
    }
  });

  it('rejects non-semver versions and non-empty displayName violations', () => {
    expect(validatePeripheralManifest(validManifest({ version: '1.0' })).issues[0]).toMatch(/version must be a semantic version/);
    expect(validatePeripheralManifest(validManifest({ version: 7 })).issues[0]).toMatch(/version must be a semantic version/);
    expect(validatePeripheralManifest(validManifest({ version: '1.2.3-rc.1+build.5' })).issues).toEqual([]);
    expect(validatePeripheralManifest(validManifest({ displayName: '' })).issues).toContain('displayName must be a non-empty string');
    expect(validatePeripheralManifest(validManifest({ displayName: '   ' })).issues).toContain('displayName must be a non-empty string');
  });

  it('rejects non-string descriptions and non-semver sdkVersion', () => {
    expect(validatePeripheralManifest(validManifest({ description: 3 })).issues).toContain('description must be a string when present');
    expect(validatePeripheralManifest(validManifest({ sdkVersion: '1' })).issues[0]).toMatch(/sdkVersion must be a semantic version/);
    const noOpt = validManifest();
    delete noOpt.description;
    delete noOpt.sdkVersion;
    delete noOpt.provides;
    expect(validatePeripheralManifest(noOpt).issues).toEqual([]);
  });

  it('rejects entries that are empty, absolute or escape the package dir', () => {
    expect(validatePeripheralManifest(validManifest({ entry: '' })).issues[0]).toMatch(/entry must be a non-empty relative module path/);
    expect(validatePeripheralManifest(validManifest({ entry: 7 })).issues[0]).toMatch(/entry must be a non-empty relative module path/);
    expect(validatePeripheralManifest(validManifest({ entry: '/abs/x.mjs' })).issues[0]).toMatch(/entry must stay inside the package directory/);
    expect(validatePeripheralManifest(validManifest({ entry: '../escape.mjs' })).issues[0]).toMatch(/entry must stay inside the package directory/);
    expect(validatePeripheralManifest(validManifest({ entry: 'sub/../inside.mjs' })).issues[0]).toMatch(/entry must stay inside/);
    expect(validatePeripheralManifest(validManifest({ entry: 'dist/bundle.mjs' })).issues).toEqual([]);
  });

  it('detects escapes segment-exactly across platforms (no false positives)', () => {
    // A directory literally named '..v2' is legal; only a bare '..' segment escapes.
    expect(validatePeripheralManifest(validManifest({ entry: 'dist/..v2/x.mjs' })).issues).toEqual([]);
    expect(validatePeripheralManifest(validManifest({ entry: 'deep/.../x.mjs' })).issues).toEqual([]);
    // Absolute forms under any host semantics: POSIX root, drive letter, UNC.
    expect(validatePeripheralManifest(validManifest({ entry: 'C:/abs/x.mjs' })).issues[0]).toMatch(/must stay inside/);
    expect(validatePeripheralManifest(validManifest({ entry: '\\\\server\\share\\x.mjs' })).issues[0]).toMatch(/must stay inside/);
    expect(validatePeripheralManifest(validManifest({ entry: '..\\escape.mjs' })).issues[0]).toMatch(/must stay inside/);
    // Backward-relative inside then out again still escapes.
    expect(validatePeripheralManifest(validManifest({ entry: 'a/b/../../out.mjs' })).issues[0]).toMatch(/must stay inside/);
  });

  it('rejects malformed provides tables', () => {
    expect(validatePeripheralManifest(validManifest({ provides: 'acme' })).issues[0]).toMatch(/provides must be an array/);
    expect(validatePeripheralManifest(validManifest({ provides: ['ok-kind', 'Bad Kind'] })).issues[0]).toMatch(/provides must be an array/);
    expect(validatePeripheralManifest(validManifest({ provides: [1] })).issues[0]).toMatch(/provides must be an array/);
    expect(validatePeripheralManifest(validManifest({ provides: [] })).issues).toEqual([]);
  });
});

describe('PluginCatalog.scan (PRD §F-EXT-3, read-only)', () => {
  it('echoes the root and returns an empty catalog for a missing root', async () => {
    const missing = join(tmp, 'no-such-root');
    const scan = await new PluginCatalog(missing).scan();
    expect(scan.rootDir).toBe(missing);
    expect(scan.entries).toEqual([]);
  });

  it('discovers valid packages, skips non-packages, flags broken ones', async () => {
    const root = await makeRoot();
    const okDir = await writePackage(root, 'acme-matrix', validManifest(), hostEntry(['scan-ok']));
    await mkdir(join(root, 'random-folder'), { recursive: true }); // no manifest -> skipped
    await writePackage(root, 'broken-json', '{ not json', null);
    await writePackage(root, 'missing-entry', validManifest({ name: 'missing-entry' }), null);
    const incompatible = validManifest({ name: 'too-new', sdkVersion: '99.0.0' });
    await writePackage(root, 'too-new', incompatible, hostEntry(['scan-new']));

    const scan = await new PluginCatalog(root).scan();
    expect(scan.entries.map((e) => basenameOf(e.dir))).toEqual(['acme-matrix', 'broken-json', 'missing-entry', 'too-new']);
    const byDir = new Map(scan.entries.map((e) => [basenameOf(e.dir), e]));

    const ok = byDir.get('acme-matrix');
    expect(ok).toMatchObject({ dir: okDir, status: 'ok', issues: [], loaded: false, kinds: [], factories: [] });
    expect(ok?.manifest).toMatchObject({ name: 'acme-matrix', version: '0.3.1', provides: ['acme-matrix'] });

    expect(byDir.get('broken-json')?.status).toBe('invalid');
    expect(byDir.get('broken-json')?.issues[0]).toMatch(/not valid JSON/);
    expect(byDir.get('broken-json')?.manifest).toBeNull();

    expect(byDir.get('missing-entry')?.status).toBe('invalid');
    expect(byDir.get('missing-entry')?.issues[0]).toMatch(/entry file not found: index\.mjs/);
    expect(byDir.get('missing-entry')?.manifest).not.toBeNull(); // parsed, but not loadable

    const inc = byDir.get('too-new');
    expect(inc?.status).toBe('incompatible');
    expect(inc?.issues[0]).toMatch(/requires SDK 99\.0\.0.*SDK 1\.0\.0/);
    expect(inc?.manifest).not.toBeNull();
  });

  it('flags manifests over the size cap as invalid without parsing', async () => {
    const root = await makeRoot();
    const dir = join(root, 'giant');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, PERIPHERAL_MANIFEST_FILE), `{"pad":"${'x'.repeat(1024 * 1024)}"}`);
    const scan = await new PluginCatalog(root).scan();
    expect(scan.entries).toHaveLength(1);
    expect(scan.entries[0].status).toBe('invalid');
    expect(scan.entries[0].issues[0]).toMatch(/size cap/);
  });

  it('flags shape-invalid manifests with every issue listed', async () => {
    const root = await makeRoot();
    await writePackage(root, 'multi-bad', validManifest({ name: 'Bad Name', version: 'nope', displayName: '' }), null);
    const scan = await new PluginCatalog(root).scan();
    const entry = scan.entries[0];
    expect(entry.status).toBe('invalid');
    expect(entry.issues.join(' | ')).toMatch(/name .* kebab/);
    expect(entry.issues.join(' | ')).toMatch(/version must be a semantic version/);
    expect(entry.issues.join(' | ')).toMatch(/displayName must be a non-empty string/);
  });
});

describe('PluginCatalog.load (PRD §F-EXT-3, explicit user action)', () => {
  it('loads a host-API package: kinds registered, metadata returned, scan marks it loaded', async () => {
    const root = await makeRoot();
    const dir = await writePackage(root, 'pack-one', validManifest({ name: 'pack-one', provides: ['plug-alpha'] }), hostEntry(['plug-alpha']));
    const catalog = new PluginCatalog(root);

    const result = await catalog.load(dir);
    expect(result.kinds).toEqual(['plug-alpha']);
    expect(result.factories).toEqual([
      { kind: 'plug-alpha', version: '1.0.0', displayName: 'plug-alpha display', pins: [{ id: 'A', role: 'gpio-out' }] },
    ]);
    // The factory is live in the Bridge registry with a working create().
    const f = getFactory('plug-alpha');
    expect(f?.create({ emitSnapshot: () => {}, log: () => {}, onTick: () => () => {} }, { instanceId: 'i1' }).instanceId).toBe('i1');

    const scan = await catalog.scan();
    const entry = scan.entries.find((e) => e.dir === dir);
    expect(entry).toMatchObject({ loaded: true, kinds: ['plug-alpha'] });
    expect(entry?.factories[0]?.kind).toBe('plug-alpha');
  });

  it('is idempotent for an already-loaded dir (no duplicate-registration storm)', async () => {
    const root = await makeRoot();
    const dir = await writePackage(root, 'pack-two', validManifest({ name: 'pack-two' }), hostEntry(['plug-beta']));
    const catalog = new PluginCatalog(root);
    const first = await catalog.load(dir);
    const countBefore = listPeripherals().length;
    const second = await catalog.load(dir);
    expect(second.kinds).toEqual(first.kinds);
    expect(listPeripherals().length).toBe(countBefore);
  });

  it('deduplicates concurrent loads of the same dir onto one import', async () => {
    const root = await makeRoot();
    const dir = await writePackage(
      root,
      'pack-three',
      validManifest({ name: 'pack-three' }),
      // An async entry widens the race window: without the inflight map the
      // second load would diff an unchanged registry and fail with [BB-223].
      `export default async function register(host) {
        await new Promise((r) => setTimeout(r, 25));
        host.registerPeripheral({
          kind: 'plug-gamma', version: '1.0.0', displayName: 'Gamma', pins: [],
          create: () => ({ kind: 'plug-gamma', instanceId: 'x', onTransaction() {} }),
        });
      }`,
    );
    const catalog = new PluginCatalog(root);
    const [a, b] = await Promise.all([catalog.load(dir), catalog.load(dir)]);
    expect(a.kinds).toEqual(['plug-gamma']);
    expect(b.kinds).toEqual(['plug-gamma']);
    expect(getFactory('plug-gamma')).toBeDefined();
  });

  it('supports CJS entries via the default-export interop', async () => {
    const root = await makeRoot();
    const dir = await writePackage(
      root,
      'pack-cjs',
      validManifest({ name: 'pack-cjs', entry: 'index.cjs' }),
      `module.exports = function register(host) {
        host.registerPeripheral({
          kind: 'plug-cjs', version: '2.0.0', displayName: 'CJS Pack', pins: [],
          create: () => ({ kind: 'plug-cjs', instanceId: 'x', onTransaction() {} }),
        });
      };`,
      'index.cjs',
    );
    const result = await new PluginCatalog(root).load(dir);
    expect(result.kinds).toEqual(['plug-cjs']);
  });

  it('rejects dirs outside the current scan with [BB-224] (no arbitrary-path imports)', async () => {
    const root = await makeRoot();
    const catalog = new PluginCatalog(root);
    await expect(catalog.load(join(root, 'never-scanned'))).rejects.toThrow(/\[BB-224\].*not found in the current scan/);
    // An invalid entry is equally not loadable.
    const bad = await writePackage(root, 'pack-bad', '{ nope', null);
    await expect(catalog.load(bad)).rejects.toThrow(/\[BB-224\].*status is 'invalid'/);
    // Nor is a package built against a newer SDK major.
    const tooNew = await writePackage(root, 'pack-toonew', validManifest({ name: 'pack-toonew', sdkVersion: '99.0.0' }), hostEntry(['plug-tn']));
    await expect(catalog.load(tooNew)).rejects.toThrow(/\[BB-224\].*status is 'incompatible'/);
    expect(getFactory('plug-tn')).toBeUndefined();
  });

  it('fails with [BB-223] when the entry registers nothing', async () => {
    const root = await makeRoot();
    const dir = await writePackage(root, 'pack-none', validManifest({ name: 'pack-none' }), `export const marker = 1;\n`);
    await expect(new PluginCatalog(root).load(dir)).rejects.toThrow(/\[BB-223\].*registered no peripherals/);
  });

  it('fails with [BB-223] on a non-function default export and on syntax errors', async () => {
    const root = await makeRoot();
    const catalog = new PluginCatalog(root);
    const wrong = await writePackage(root, 'pack-wrong', validManifest({ name: 'pack-wrong' }), `export default 42;\n`);
    await expect(catalog.load(wrong)).rejects.toThrow(/\[BB-223\].*default export must be a registration function/);
    const broken = await writePackage(root, 'pack-broken', validManifest({ name: 'pack-broken' }), `export default function ( {\n`);
    await expect(catalog.load(broken)).rejects.toThrow(/\[BB-223\] failed to load peripheral package 'pack-broken'/);
  });

  it('rolls back partial registrations when the entry throws mid-way', async () => {
    const root = await makeRoot();
    const dir = await writePackage(
      root,
      'pack-throws',
      validManifest({ name: 'pack-throws' }),
      `export default function register(host) {
        host.registerPeripheral({
          kind: 'plug-partial', version: '1.0.0', displayName: 'Partial', pins: [],
          create: () => ({ kind: 'plug-partial', instanceId: 'x', onTransaction() {} }),
        });
        throw new Error('boom after register');
      }`,
    );
    await expect(new PluginCatalog(root).load(dir)).rejects.toThrow(/\[BB-223\].*boom after register/);
    expect(getFactory('plug-partial')).toBeUndefined();
    // And the same dir can be loaded again after a fix (no residue blocks it).
    await writeFile(join(dir, 'index.mjs'), hostEntry(['plug-partial']));
    const retry = await new PluginCatalog(root).load(dir);
    expect(retry.kinds).toEqual(['plug-partial']);
  });

  it('propagates coded registration errors ([BB-220]/[BB-221]/[BB-222]) with rollback', async () => {
    const root = await makeRoot();
    const catalog = new PluginCatalog(root);
    // Invalid factory shape -> [BB-220].
    const malformed = await writePackage(
      root,
      'pack-malformed',
      validManifest({ name: 'pack-malformed' }),
      `export default function register(host) {
        host.registerPeripheral({ kind: 'Bad Kind', version: '1', displayName: '', pins: [], create: () => {} });
      }`,
    );
    await expect(catalog.load(malformed)).rejects.toThrow('[BB-220]');
    // Kind collision with a built-in -> [BB-221], and nothing else lingers.
    const dup = await writePackage(
      root,
      'pack-dup',
      validManifest({ name: 'pack-dup' }),
      `export default function register(host) {
        host.registerPeripheral({
          kind: 'plug-dup-first', version: '1.0.0', displayName: 'First', pins: [],
          create: () => ({ kind: 'plug-dup-first', instanceId: 'x', onTransaction() {} }),
        });
        host.registerPeripheral({
          kind: 'led', version: '1.0.0', displayName: 'Squatter', pins: [],
          create: () => ({ kind: 'led', instanceId: 'x', onTransaction() {} }),
        });
      }`,
    );
    await expect(catalog.load(dup)).rejects.toThrow("[BB-221] peripheral kind 'led' is already registered");
    expect(getFactory('plug-dup-first')).toBeUndefined(); // rolled back
    // Factory-level sdkVersion newer than the host (manifest omitted it) -> [BB-222].
    const newer = await writePackage(
      root,
      'pack-newer',
      validManifest({ name: 'pack-newer', sdkVersion: undefined }),
      `export default function register(host) {
        host.registerPeripheral({
          kind: 'plug-newer', version: '1.0.0', displayName: 'Newer', pins: [], sdkVersion: '99.0.0',
          create: () => ({ kind: 'plug-newer', instanceId: 'x', onTransaction() {} }),
        });
      }`,
    );
    await expect(catalog.load(newer)).rejects.toThrow('[BB-222]');
    expect(getFactory('plug-newer')).toBeUndefined();
  });

  it('fails with [BB-223] when the entry file vanishes between scan and load', async () => {
    const root = await makeRoot();
    const dir = await writePackage(root, 'pack-vanish', validManifest({ name: 'pack-vanish' }), hostEntry(['plug-vanish']));
    const catalog = new PluginCatalog(root);
    // Prime the loaded-dir cache is not involved here; delete the entry and
    // re-scan implicitly inside load: the package becomes 'invalid'.
    await rmSync(join(dir, 'index.mjs'));
    await expect(catalog.load(dir)).rejects.toThrow(/\[BB-224\].*status is 'invalid'.*entry file not found/);
  });

  it('loads multi-kind packages and reports every kind', async () => {
    const root = await makeRoot();
    const dir = await writePackage(root, 'pack-multi', validManifest({ name: 'pack-multi' }), hostEntry(['plug-m1', 'plug-m2']));
    const result = await new PluginCatalog(root).load(dir);
    expect(result.kinds).toEqual(['plug-m1', 'plug-m2']);
    expect(result.factories.map((f) => f.kind)).toEqual(['plug-m1', 'plug-m2']);
  });
});

function basenameOf(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
}

// Type-level guard: the manifest contract is exported for SDK consumers.
const _typeCheck: PeripheralPackageManifest | null = null;
void _typeCheck;
