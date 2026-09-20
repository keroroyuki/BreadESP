// PRD: §F-EXT-3, §6.2 — Local peripheral package catalog ("offline
// marketplace", dev-plan P5.2). Scans the local peripherals root for package
// directories (a `breadesp-peripheral.json` manifest + a JS entry module) and
// loads them into the Bridge registry on explicit user request. Scanning is
// pure read-only filesystem work; loading executes the entry module, so it is
// gated behind a fresh scan (the target must be a currently-scanned 'ok'
// entry) and rolls the registry back on failure.
import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PERIPHERAL_SDK_VERSION,
  getFactory,
  isSemver,
  listPeripherals,
  registerPeripheral,
  semverMajor,
  unregisterPeripheral,
  type PeripheralHostApi,
  type PeripheralMeta,
} from '@breadesp/peripherals';

/** Manifest file every catalog package directory MUST carry (PRD §F-EXT-3). */
export const PERIPHERAL_MANIFEST_FILE = 'breadesp-peripheral.json';

/** Defensive manifest size cap: a manifest is a small JSON document. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** Package name: lowercase kebab, optionally @scoped (npm-style identity). */
const NAME_RE = /^(?:@[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Factory kinds are lowercase kebab (the registry's KIND_RE, mirrored). */
const KIND_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Parsed manifest of a catalog package (PRD §F-EXT-3). `manifestVersion` is
 * the format contract version (currently 1); `version` is the package's own
 * semver. `sdkVersion` declares the SDK contract the package was built
 * against (same gate as factory-level sdkVersion, evaluated at scan time so
 * the marketplace can grey out incompatible packages before any code runs).
 */
export interface PeripheralPackageManifest {
  manifestVersion: 1;
  name: string;
  version: string;
  displayName: string;
  description?: string;
  /** Entry module path relative to the package dir (MUST stay inside it). */
  entry: string;
  sdkVersion?: string;
  /** Advertised factory kinds (informational; the registry diff is truth). */
  provides?: string[];
}

export type PeripheralCatalogStatus = 'ok' | 'invalid' | 'incompatible';

export interface PeripheralCatalogEntry {
  /** Absolute path of the package directory. */
  dir: string;
  status: PeripheralCatalogStatus;
  /** Readable validation problems; empty for 'ok' entries. */
  issues: string[];
  /** The parsed manifest; null when it could not be parsed/validated at all. */
  manifest: PeripheralPackageManifest | null;
  /** True when this package was loaded into the Bridge registry this session. */
  loaded: boolean;
  /** Factory kinds this package registered (empty until loaded). */
  kinds: string[];
  /**
   * Metadata of the registered factories (populated once loaded) so a freshly
   * reloaded renderer can re-mirror the kinds without a separate round-trip.
   */
  factories: PeripheralMeta[];
}

export interface PeripheralCatalogScan {
  /** The root directory that was scanned. */
  rootDir: string;
  entries: PeripheralCatalogEntry[];
}

export interface PeripheralCatalogLoadResult {
  dir: string;
  /** Factory kinds this package has registered into the Bridge registry. */
  kinds: string[];
  /** Metadata of those factories, for renderer-side mirroring. */
  factories: PeripheralMeta[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Process-global load-attempt counter feeding the entry URL's cache-busting
 * query. The ESM module cache is process-global and keyed by URL, so the
 * counter MUST be module-scoped (not per-catalog): without it a failed load
 * poisons the entry URL forever, and fixing the file then retrying would
 * replay the cached (still broken) module. Successful loads are idempotent
 * via the catalog's loaded map and never re-import.
 */
let loadAttemptSeq = 0;

/**
 * True when a manifest entry path would resolve outside its package dir.
 * Segment-exact `..` detection (a directory literally named `..v2` is legal),
 * plus cross-platform absolute forms: POSIX-rooted, drive-lettered and UNC
 * (path.isAbsolute alone misses `/x` and UNC under win32 semantics).
 */
export function entryEscapesPackage(entry: string): boolean {
  if (isAbsolute(entry)) return true;
  if (entry.startsWith('/') || entry.startsWith('\\\\')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(entry)) return true;
  return entry.split(/[\\/]+/).some((seg) => seg === '..');
}

/**
 * Validate a parsed manifest document. Returns the issues found (empty =
 * valid); the manifest is returned only when valid. Pure — the entry-file
 * existence check happens in scanPackage (it needs fs).
 */
export function validatePeripheralManifest(raw: unknown): { manifest: PeripheralPackageManifest | null; issues: string[] } {
  const issues: string[] = [];
  if (!isPlainObject(raw)) return { manifest: null, issues: ['manifest must be a JSON object'] };
  if (raw.manifestVersion !== 1) issues.push(`manifestVersion must be 1 (got ${String(raw.manifestVersion)})`);
  if (typeof raw.name !== 'string' || !NAME_RE.test(raw.name)) {
    issues.push(`name must be a lowercase kebab-case package name, optionally @scoped (got ${String(raw.name)})`);
  }
  if (!isSemver(raw.version)) issues.push(`version must be a semantic version (got ${String(raw.version)})`);
  if (typeof raw.displayName !== 'string' || raw.displayName.trim().length === 0) {
    issues.push('displayName must be a non-empty string');
  }
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    issues.push('description must be a string when present');
  }
  if (typeof raw.entry !== 'string' || raw.entry.length === 0) {
    issues.push('entry must be a non-empty relative module path');
  } else if (entryEscapesPackage(raw.entry)) {
    // Path-escape guard: the entry must resolve inside the package dir.
    issues.push(`entry must stay inside the package directory (got '${raw.entry}')`);
  }
  if (raw.sdkVersion !== undefined && !isSemver(raw.sdkVersion)) {
    issues.push(`sdkVersion must be a semantic version (got ${String(raw.sdkVersion)})`);
  }
  if (raw.provides !== undefined) {
    if (!Array.isArray(raw.provides) || raw.provides.some((k) => typeof k !== 'string' || !KIND_RE.test(k))) {
      issues.push('provides must be an array of lowercase kebab-case kind identifiers');
    }
  }
  if (issues.length > 0) return { manifest: null, issues };
  // Boundary cast (dev-plan §4.3): every field was validated above; the cast
  // narrows the untrusted document to the manifest contract.
  return { manifest: raw as unknown as PeripheralPackageManifest, issues };
}

/**
 * The local peripheral catalog: scans the peripherals root and loads packages
 * into the Bridge registry. The root defaults to `~/.breadesp/peripherals`,
 * overridable via BREADESP_PERIPHERALS_DIR (dev-plan §11.2) or the constructor
 * (test seam). Instances hold the session's loaded set so re-scans keep the
 * loaded badge and repeat loads are idempotent.
 */
export class PluginCatalog {
  private readonly rootDir: string;
  /** Session-loaded packages: resolved dir -> registered kinds. */
  private readonly loaded = new Map<string, string[]>();
  /** In-flight loads keyed by dir, so concurrent requests share one import. */
  private readonly inflight = new Map<string, Promise<PeripheralCatalogLoadResult>>();

  constructor(rootDir?: string) {
    this.rootDir = resolve(rootDir ?? process.env.BREADESP_PERIPHERALS_DIR ?? join(homedir(), '.breadesp', 'peripherals'));
  }

  /** The resolved peripherals root this catalog scans. */
  getRootDir(): string {
    return this.rootDir;
  }

  /**
   * Scan the peripherals root. Read-only and total: a missing/unreadable root
   * yields an empty catalog, and a broken package degrades to an 'invalid'
   * entry instead of failing the scan. Entries sort by package name (dir
   * basename as fallback), then dir.
   */
  async scan(): Promise<PeripheralCatalogScan> {
    const entries: PeripheralCatalogEntry[] = [];
    let dirents: Dirent[];
    try {
      dirents = await readdir(this.rootDir, { withFileTypes: true });
    } catch {
      dirents = []; // missing/unreadable root = empty marketplace, not an error
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const entry = await this.scanPackage(join(this.rootDir, dirent.name));
      if (entry !== null) entries.push(entry);
    }
    entries.sort((a, b) => {
      const an = a.manifest?.name ?? basename(a.dir);
      const bn = b.manifest?.name ?? basename(b.dir);
      return an.localeCompare(bn) || a.dir.localeCompare(b.dir);
    });
    return { rootDir: this.rootDir, entries };
  }

  /** Scan one package dir; null when it is not a package (no manifest file). */
  private async scanPackage(dir: string): Promise<PeripheralCatalogEntry | null> {
    const manifestPath = join(dir, PERIPHERAL_MANIFEST_FILE);
    let rawText: string;
    try {
      const s = await stat(manifestPath);
      if (!s.isFile()) return null;
      if (s.size > MAX_MANIFEST_BYTES) {
        return this.entry(dir, 'invalid', [`manifest exceeds the ${MAX_MANIFEST_BYTES}-byte size cap`], null);
      }
      rawText = await readFile(manifestPath, 'utf8');
    } catch (err) {
      // ENOENT = not a package directory -> skipped silently. Other read
      // failures surface as an invalid entry so the user sees the problem.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return this.entry(dir, 'invalid', [`manifest unreadable: ${(err as Error).message}`], null);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      return this.entry(dir, 'invalid', [`manifest is not valid JSON: ${(err as Error).message}`], null);
    }
    const { manifest, issues } = validatePeripheralManifest(parsed);
    if (manifest === null) return this.entry(dir, 'invalid', issues, null);

    // The entry module must exist at scan time so 'ok' means loadable.
    const entryPath = resolve(dir, manifest.entry);
    try {
      const s = await stat(entryPath);
      if (!s.isFile()) issues.push(`entry file not found: ${manifest.entry}`);
    } catch {
      issues.push(`entry file not found: ${manifest.entry}`);
    }
    if (issues.length > 0) return this.entry(dir, 'invalid', issues, manifest);

    // Pre-flight the SDK-major gate at scan time (the factory-level [BB-222]
    // gate still applies to the code itself at load time).
    if (manifest.sdkVersion !== undefined && semverMajor(manifest.sdkVersion) > semverMajor(PERIPHERAL_SDK_VERSION)) {
      return this.entry(dir, 'incompatible', [
        `package requires SDK ${manifest.sdkVersion} but this host provides SDK ${PERIPHERAL_SDK_VERSION}; upgrade BreadESP`,
      ], manifest);
    }
    return this.entry(dir, 'ok', [], manifest);
  }

  /** Assemble an entry, folding in the session's loaded state. */
  private entry(
    dir: string,
    status: PeripheralCatalogStatus,
    issues: string[],
    manifest: PeripheralPackageManifest | null,
  ): PeripheralCatalogEntry {
    const kinds = this.loaded.get(resolve(dir)) ?? [];
    return { dir, status, issues, manifest, loaded: kinds.length > 0, kinds, factories: this.metaFor(kinds) };
  }

  /**
   * Load a package into the Bridge registry (explicit user action). The dir
   * MUST be a currently-scanned 'ok' entry — the catalog is re-scanned here
   * so the IPC surface cannot be talked into importing arbitrary paths
   * ([BB-224]). The entry module is imported and, when it default-exports a
   * function, that function is called with the host API (PRD §F-EXT-3);
   * registration is observed by diffing the registry. A load that throws or
   * registers nothing fails with [BB-223] and rolls back any partial
   * registration. Re-loading an already-loaded dir is an idempotent no-op
   * (hot reload is out of scope: code changes apply after an app restart).
   */
  async load(dir: string): Promise<PeripheralCatalogLoadResult> {
    const resolvedDir = resolve(dir);
    const prior = this.loaded.get(resolvedDir);
    if (prior !== undefined) return { dir: resolvedDir, kinds: prior, factories: this.metaFor(prior) };
    const pending = this.inflight.get(resolvedDir);
    if (pending !== undefined) return pending;
    const promise = this.loadFresh(resolvedDir).finally(() => this.inflight.delete(resolvedDir));
    this.inflight.set(resolvedDir, promise);
    return promise;
  }

  private async loadFresh(resolvedDir: string): Promise<PeripheralCatalogLoadResult> {
    const scan = await this.scan();
    const found = scan.entries.find((e) => resolve(e.dir) === resolvedDir);
    if (found === undefined || found.status !== 'ok' || found.manifest === null) {
      const detail = found === undefined
        ? 'not found in the current scan'
        : `status is '${found.status}' (${found.issues.join('; ') || 'not loadable'})`;
      throw new Error(
        `[BB-224] '${resolvedDir}' is not a loadable catalog entry: ${detail}; rescan the catalog and pick a listed package`,
      );
    }
    const manifest = found.manifest;
    const entryPath = resolve(resolvedDir, manifest.entry);
    // Defense in depth: the manifest validator already rejects escaping
    // entries; re-check the resolved path against the package dir.
    const rel = relative(resolvedDir, entryPath);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`[BB-223] package '${manifest.name}' entry escapes its directory: ${manifest.entry}`);
    }

    const before = new Set(listPeripherals().map((f) => f.kind));
    /** Kinds this load has added so far — computed live so the catch path can
     *  roll back even when the entry threw before the success-path diff ran. */
    const addedKinds = (): string[] => listPeripherals().filter((f) => !before.has(f.kind)).map((f) => f.kind);
    const attempt = ++loadAttemptSeq;
    try {
      // @vite-ignore: the path is runtime-computed by design (plugin entry).
      // The ?attempt= query busts the ESM module cache so a retry after a fix
      // re-executes the entry instead of replaying the cached failure.
      const mod: unknown = await import(`${pathToFileURL(entryPath).href}?attempt=${attempt}`);
      const register = (mod as { default?: unknown }).default;
      if (register !== undefined) {
        if (typeof register !== 'function') {
          throw new Error(`the entry's default export must be a registration function (got ${typeof register})`);
        }
        const host: PeripheralHostApi = { registerPeripheral, PERIPHERAL_SDK_VERSION };
        await (register as (host: PeripheralHostApi) => unknown)(host);
      }
      if (addedKinds().length === 0) {
        throw new Error('the entry ran but registered no peripherals');
      }
    } catch (err) {
      // Rollback: a failed load must not leave a partial registration behind.
      for (const kind of addedKinds()) unregisterPeripheral(kind);
      const reason = err instanceof Error ? err.message : String(err);
      // Already-coded errors ([BB-220]/[BB-221]/[BB-222]) propagate as-is.
      if (reason.startsWith('[BB-')) throw err;
      throw new Error(`[BB-223] failed to load peripheral package '${manifest.name}' from ${entryPath}: ${reason}`);
    }
    const added = addedKinds();
    this.loaded.set(resolvedDir, added);
    return { dir: resolvedDir, kinds: added, factories: this.metaFor(added) };
  }

  /** Registry metadata of the given kinds (skips kinds that vanished). */
  private metaFor(kinds: readonly string[]): PeripheralMeta[] {
    const out: PeripheralMeta[] = [];
    for (const kind of kinds) {
      const f = getFactory(kind);
      if (f === undefined) continue;
      const meta: PeripheralMeta = {
        kind: f.kind,
        version: f.version,
        displayName: f.displayName,
        pins: f.pins,
      };
      if (f.defaults !== undefined) meta.defaults = f.defaults;
      if (f.sdkVersion !== undefined) meta.sdkVersion = f.sdkVersion;
      out.push(meta);
    }
    return out;
  }
}
