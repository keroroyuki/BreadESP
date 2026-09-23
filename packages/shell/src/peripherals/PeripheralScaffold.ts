// PRD: §F-EXT-4 — Peripheral package scaffold (dev-plan P5.3). Generates a
// ready-to-publish peripheral package (manifest + host-API entry + README +
// dependency-free self-check) from a name and optional metadata. The generator
// is self-checking: the produced manifest is re-validated through the P5.2
// catalog validator before it is ever written, so a scaffolded package is a
// package the catalog accepts — no privileged path.
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PERIPHERAL_SDK_VERSION } from '@breadesp/peripherals';
import { PERIPHERAL_MANIFEST_FILE, PERIPHERAL_PACKAGE_NAME_RE, validatePeripheralManifest } from './PluginCatalog.js';

/** Default semver of a freshly scaffolded package (pre-1.0 signals "young"). */
export const SCAFFOLD_PACKAGE_VERSION = '0.1.0';
/** Entry module every scaffolded package carries (ESM, host-API default export). */
export const SCAFFOLD_ENTRY_FILE = 'index.mjs';
/** Dependency-free smoke check shipped with the package. */
export const SCAFFOLD_SELF_CHECK_FILE = 'self-check.mjs';
/** Generated usage guide. */
export const SCAFFOLD_README_FILE = 'README.md';

/** Raw user input to the scaffold (CLI surface). */
export interface ScaffoldRequest {
  /** Package name: lowercase kebab, optionally `@scoped/` (catalog NAME_RE). */
  name: string;
  displayName?: string;
  description?: string;
}

/** Validated + derived scaffold input. */
export interface NormalizedScaffoldRequest {
  /** Package name as given (may be `@scoped/`). */
  name: string;
  /** Factory kind and package directory name: the unscoped name segment. */
  kind: string;
  displayName: string;
  description?: string;
}

/** A generated package: directory name + exact file contents. */
export interface ScaffoldPackage {
  dirName: string;
  /** Relative file path -> content. Exactly four files (PRD §F-EXT-4). */
  files: Record<string, string>;
}

/** Result of writing a scaffolded package to disk. */
export interface ScaffoldWriteResult {
  /** Absolute path of the package directory. */
  dir: string;
  /** Relative paths written, in a stable order. */
  files: string[];
}

/** Single-line text only: multi-line values would break the generated files. */
const isSingleLine = (v: string): boolean => !/[\r\n]/.test(v);

/** 'acme-matrix' -> 'Acme Matrix' (palette display name fallback). */
function deriveDisplayName(kind: string): string {
  return kind
    .split('-')
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join(' ');
}

/** 'acme-matrix' -> 'AcmeMatrix'; digit-leading kinds get a prefix ('7seg' -> 'Peripheral7seg'). */
function deriveClassName(kind: string): string {
  const pascal = kind
    .split('-')
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join('');
  return /^[A-Za-z]/.test(pascal) ? pascal : `Peripheral${pascal}`;
}

/**
 * Validate a scaffold request and derive the normalized form. Every problem
 * is listed in one coded [BB-230] error (same style as the registry/catalog
 * validators). `existingKinds` (e.g. the live registry's kinds) triggers an
 * early collision rejection: the generated factory would otherwise fail to
 * load later with [BB-221].
 */
export function normalizeScaffoldRequest(request: ScaffoldRequest, existingKinds: readonly string[] = []): NormalizedScaffoldRequest {
  const issues: string[] = [];
  if (typeof request !== 'object' || request === null) {
    throw new Error('[BB-230] invalid scaffold request: request must be an object');
  }
  if (typeof request.name !== 'string' || !PERIPHERAL_PACKAGE_NAME_RE.test(request.name)) {
    issues.push(`name must be a lowercase kebab-case package name, optionally @scoped (got ${String(request.name)})`);
  }
  // The unscoped segment is the factory kind; PERIPHERAL_PACKAGE_NAME_RE
  // guarantees it is lowercase kebab, which is exactly the registry's kind rule.
  const kind = typeof request.name === 'string' ? (request.name.split('/').pop() ?? '') : '';
  if (kind.length > 0 && existingKinds.includes(kind)) {
    issues.push(`kind '${kind}' collides with an already-registered peripheral kind (it would fail to load with [BB-221])`);
  }
  let displayName: string | undefined;
  if (request.displayName !== undefined) {
    if (typeof request.displayName !== 'string' || request.displayName.trim().length === 0) {
      issues.push('displayName must be a non-empty string when given');
    } else if (!isSingleLine(request.displayName)) {
      issues.push('displayName must be a single line (it is embedded into generated files)');
    } else {
      displayName = request.displayName.trim();
    }
  }
  let description: string | undefined;
  if (request.description !== undefined) {
    if (typeof request.description !== 'string' || request.description.trim().length === 0) {
      issues.push('description must be a non-empty string when given');
    } else if (!isSingleLine(request.description)) {
      issues.push('description must be a single line (it is embedded into generated files)');
    } else {
      description = request.description.trim();
    }
  }
  if (issues.length > 0) {
    throw new Error(`[BB-230] invalid scaffold request: ${issues.join('; ')}`);
  }
  // Boundary cast (dev-plan §4.3): name passed PERIPHERAL_PACKAGE_NAME_RE above,
  // so it is a string whose unscoped segment is a valid kind.
  return {
    name: request.name,
    kind,
    displayName: displayName ?? deriveDisplayName(kind),
    ...(description !== undefined ? { description } : {}),
  };
}

/** Substitute {{TOKEN}} placeholders (split/join: no regex-escaping hazards). */
function fill(template: string, tokens: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(tokens)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}

/**
 * The generated entry module. Deliberately free of backticks and ${} so the
 * template below needs no escaping beyond the {{TOKEN}} substitution. The
 * model is the smallest complete peripheral: a GPIO-driven level indicator
 * (the same shape the P5.2 catalog smoke uses end to end).
 */
const ENTRY_TEMPLATE = `// {{DISPLAY_NAME}} — BreadESP peripheral package '{{NAME}}' (kind '{{KIND}}').
// Generated by \`pnpm create-peripheral\` (PRD §F-EXT-4; guide: docs/peripheral-sdk.md).
//
// Entry contract (PRD §F-EXT-3): the catalog loader imports this module and
// calls the default export with the host API. Register through
// host.registerPeripheral — do NOT import '@breadesp/peripherals' from a
// drop-in package: it cannot resolve the host's module instance, and the
// registration would land in a registry the Bridge never reads.

/**
 * Example model: a GPIO-driven level indicator. Replace the internals with
 * your own device behavior — the contract surface is Peripheral (PRD §6.2):
 * onTransaction(tx, viaPin?) consumes bus transactions routed to this
 * instance, ctx.emitSnapshot() pushes render snapshots to the UI (throttled
 * at 30fps by the host — no debounce needed here), dispose() releases
 * resources on netlist re-apply.
 */
class {{CLASS_NAME}} {
  constructor(instanceId, ctx) {
    this.kind = '{{KIND}}';
    this.instanceId = instanceId;
    this.ctx = ctx;
    this.level = 0;
  }

  onTransaction(tx) {
    if (tx.kind !== 'gpio' || tx.dir !== 'write') return; // not addressed to us
    this.level = tx.data[0] ? 1 : 0;
    this.ctx.emitSnapshot({ instanceId: this.instanceId, type: 'level', payload: { level: this.level } });
  }

  dispose() {
    // This example holds no timers or subscriptions — release yours here.
  }
}

export default function register(host) {
  host.registerPeripheral({
    kind: '{{KIND}}',           // globally unique, lowercase kebab (PRD §6.2)
    version: '{{PACKAGE_VERSION}}', // this package's own semver; bump major on breaking changes
    displayName: '{{DISPLAY_NAME}}', // shown in the palette
    sdkVersion: host.PERIPHERAL_SDK_VERSION, // stamp the SDK contract you built against
    pins: [
      { id: 'A', role: 'gpio-out' },           // anode: wire to an MCU GPIO
      { id: 'K', role: 'gnd', optional: true }, // cathode: logical only (no electrical sim, PRD §1.3)
    ],
    create: (ctx, props) => new {{CLASS_NAME}}(String(props?.instanceId ?? '{{KIND}}'), ctx),
  });
}
`;

const SELF_CHECK_TEMPLATE = `// Self-check for the '{{NAME}}' package — dependency-free smoke test
// (docs/peripheral-sdk.md §10). Run: node self-check.mjs (exit 0 = pass).
// It verifies the entry contract and drives the example model through its
// documented behavior; extend the checks when you change the model.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const failures = [];
const check = (ok, label) => { if (!ok) failures.push(label); };

// 1. The entry module imports cleanly and default-exports the registration
//    function (PRD §F-EXT-3).
let mod;
try {
  mod = await import(pathToFileURL(join(here, 'index.mjs')).href);
} catch (err) {
  console.error('SELF-CHECK FAILED: index.mjs failed to load: ' + (err && err.message ? err.message : err));
  process.exit(1);
}
check(typeof mod.default === 'function', 'index.mjs must default-export the registration function');

// 2. Registration through the host API registers exactly the package kind,
//    stamping sdkVersion from the host (never a hardcoded copy).
const registered = [];
const host = {
  PERIPHERAL_SDK_VERSION: '0.0.0-self-check',
  registerPeripheral: (factory) => registered.push(factory),
};
if (typeof mod.default === 'function') {
  try {
    await mod.default(host);
  } catch (err) {
    failures.push('the registration function threw: ' + (err && err.message ? err.message : err));
  }
}
check(registered.length === 1, 'expected exactly one registered factory, got ' + registered.length);

const factory = registered[0];
check(factory !== undefined && factory.kind === '{{KIND}}', 'factory kind must be \\'{{KIND}}\\'');
check(factory !== undefined && factory.sdkVersion === '0.0.0-self-check', 'factory must stamp sdkVersion from host.PERIPHERAL_SDK_VERSION');
check(factory !== undefined && typeof factory.create === 'function', 'factory must provide create()');
check(
  factory !== undefined && Array.isArray(factory.pins) && factory.pins.some((p) => p && p.id === 'A' && p.role === 'gpio-out'),
  'factory must declare pin A with role gpio-out',
);

// 3. The model answers a GPIO write with a level snapshot (PRD §6.4).
if (factory !== undefined && typeof factory.create === 'function') {
  const snapshots = [];
  const ctx = { emitSnapshot: (s) => snapshots.push(s), log: () => {}, onTick: () => () => {} };
  const inst = factory.create(ctx, { instanceId: 'self-check' });
  check(inst.instanceId === 'self-check', 'instanceId must come from props.instanceId');
  inst.onTransaction({ kind: 'gpio', bus: 0, target: 2, dir: 'write', data: Uint8Array.from([1]), ts: 0 });
  check(
    snapshots.length === 1 && snapshots[0].type === 'level' && snapshots[0].payload.level === 1,
    'gpio write 1 must emit a level=1 snapshot',
  );
  inst.onTransaction({ kind: 'gpio', bus: 0, target: 2, dir: 'write', data: Uint8Array.from([0]), ts: 1 });
  check(
    snapshots.length === 2 && snapshots[1].payload.level === 0,
    'gpio write 0 must emit a level=0 snapshot',
  );
  if (typeof inst.dispose === 'function') inst.dispose();
}

if (failures.length > 0) {
  console.error('SELF-CHECK FAILED:');
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('SELF-CHECK OK — {{NAME}} registers \\'{{KIND}}\\' and the model behaves');
`;

const README_TEMPLATE = `# {{DISPLAY_NAME}}

BreadESP peripheral package \`{{NAME}}\`, providing the \`{{KIND}}\` peripheral kind.
{{DESCRIPTION_LINE}}Generated by the BreadESP scaffold (\`pnpm create-peripheral\`, PRD §F-EXT-4).

## Contents

| File | Purpose |
|---|---|
| \`breadesp-peripheral.json\` | Package manifest (PRD §F-EXT-3) |
| \`index.mjs\` | Entry module: registers the \`{{KIND}}\` factory with the host |
| \`self-check.mjs\` | Dependency-free smoke check: \`node self-check.mjs\` |
| \`README.md\` | This file |

## Install

Copy this directory into your local peripherals root so BreadESP discovers it:

- Default root: \`~/.breadesp/peripherals/\` (override with the \`BREADESP_PERIPHERALS_DIR\` environment variable)
- Then open BreadESP, find the package in the **Peripheral catalog** panel and click **Load**

The \`{{KIND}}\` peripheral appears in the palette immediately — no restart and
no UI code needed. To remove it later, delete the directory and restart the app
(hot unload is out of scope, PRD §F-EXT-3).

## Try it

1. Drag **{{DISPLAY_NAME}}** from the palette onto the breadboard.
2. Wire pin **A** to an MCU GPIO (e.g. \`GPIO2\`); pin **K** is optional (logical GND).
3. Run a firmware that toggles that GPIO (the golden blink firmware works).
4. The node lights and dims with the pin level (\`level\` snapshots, PRD §6.4).

## Develop

- Model code lives in \`index.mjs\` (class \`{{CLASS_NAME}}\`). The contract is
  \`Peripheral\` / \`PeripheralFactory\` (PRD §6.2) — see
  \`docs/peripheral-sdk.md\` in the BreadESP repository for the full guide.
- Run \`node self-check.mjs\` after edits for a fast smoke check.
- Code changes apply after an app restart (the catalog caches loaded packages
  per session, PRD §F-EXT-3).
- Registration gates enforced at load time: \`[BB-220]\` malformed factory shape,
  \`[BB-221]\` kind already taken, \`[BB-222]\` SDK major newer than the host.
`;

/**
 * Build the package file set for a normalized request. Pure. The manifest is
 * re-validated through the P5.2 catalog validator before returning — a
 * scaffold that produced an invalid manifest is a generator bug, not user
 * input, so that invariant throws uncoded.
 */
export function buildPeripheralPackage(request: NormalizedScaffoldRequest): ScaffoldPackage {
  const manifest: Record<string, unknown> = {
    manifestVersion: 1,
    name: request.name,
    version: SCAFFOLD_PACKAGE_VERSION,
    displayName: request.displayName,
    ...(request.description !== undefined ? { description: request.description } : {}),
    entry: SCAFFOLD_ENTRY_FILE,
    sdkVersion: PERIPHERAL_SDK_VERSION,
    provides: [request.kind],
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  // Internal invariant (dev-plan §4.7): the generator must only emit manifests
  // the catalog accepts.
  const { issues } = validatePeripheralManifest(JSON.parse(manifestJson));
  if (issues.length > 0) {
    throw new Error(`scaffold generated an invalid manifest (generator bug): ${issues.join('; ')}`);
  }
  const tokens: Record<string, string> = {
    NAME: request.name,
    KIND: request.kind,
    DISPLAY_NAME: request.displayName,
    CLASS_NAME: deriveClassName(request.kind),
    PACKAGE_VERSION: SCAFFOLD_PACKAGE_VERSION,
    DESCRIPTION_LINE: request.description !== undefined ? `${request.description}\n\n` : '',
  };
  return {
    dirName: request.kind,
    files: {
      [PERIPHERAL_MANIFEST_FILE]: manifestJson,
      [SCAFFOLD_ENTRY_FILE]: fill(ENTRY_TEMPLATE, tokens),
      [SCAFFOLD_README_FILE]: fill(README_TEMPLATE, tokens),
      [SCAFFOLD_SELF_CHECK_FILE]: fill(SELF_CHECK_TEMPLATE, tokens),
    },
  };
}

/**
 * Write a scaffolded package under `parentDir` (created recursively). The
 * target directory must be absent or empty — the scaffold never overwrites
 * existing files ([BB-231]). A mid-write failure removes the partial package
 * again (files written by this call, plus the directory if this call created
 * it), so a failed scaffold never leaves a broken half-package behind.
 */
export async function writePeripheralPackage(parentDir: string, request: NormalizedScaffoldRequest): Promise<ScaffoldWriteResult> {
  const pkg = buildPeripheralPackage(request);
  const dir = resolve(join(parentDir, pkg.dirName));
  let createdDir = false;
  try {
    const existing = await readdir(dir);
    if (existing.length > 0) {
      throw new Error(
        `[BB-231] target directory '${dir}' already exists and is not empty; the scaffold never overwrites existing files — pick a fresh name or directory`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await mkdir(dir, { recursive: true });
      createdDir = true;
    } else {
      throw err;
    }
  }
  const written: string[] = [];
  try {
    for (const [file, content] of Object.entries(pkg.files)) {
      try {
        await writeFile(join(dir, file), content, 'utf8');
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`failed to write package file '${file}': ${reason}`);
      }
      written.push(file);
    }
  } catch (err) {
    // Cleanup: a failed scaffold must not leave a broken half-package behind.
    for (const file of written) await rm(join(dir, file), { force: true });
    if (createdDir) await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return { dir, files: written };
}
