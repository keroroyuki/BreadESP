// PRD: §F-PROJ-3 — PlatformIO/ESP-IDF external project detection and
// build/*.elf discovery (dev-plan task P4.3). Pure filesystem scanning: this
// module never writes and never knows about .breadesp projects; the
// ProjectManager owns association persistence (meta.json) and the firmware
// import gate.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Recognized external build systems. */
export type ExternalProjectKind = 'platformio' | 'esp-idf';

/** A persisted association between a .breadesp project and an external one. */
export interface ExternalProjectLink {
  kind: ExternalProjectKind;
  /** Absolute path of the external project root. */
  dir: string;
}

/** One discovered build output ELF. */
export interface ExternalElfCandidate {
  /** Absolute path to the .elf file. */
  path: string;
  /** PlatformIO environment name ([env:x]); null for the single-build IDF layout. */
  env: string | null;
  mtimeMs: number;
  sizeBytes: number;
  /**
   * Filled by ProjectManager when a project chip context is available
   * (validateElf against the saved netlist's chip); absent from raw scans.
   */
  archOk?: boolean;
}

export interface ExternalScanResult {
  link: ExternalProjectLink;
  /** Newest build first (mtimeMs desc, path as tiebreak). */
  candidates: ExternalElfCandidate[];
}

async function isFile(p: string): Promise<boolean> {
  return stat(p).then((s) => s.isFile()).catch(() => false);
}

async function isDir(p: string): Promise<boolean> {
  return stat(p).then((s) => s.isDirectory()).catch(() => false);
}

/**
 * Parse the environment names out of a platformio.ini. Named sections
 * `[env:NAME]` map to `.pio/build/NAME/`; the bare `[env]` defaults section
 * builds into `.pio/build/env/`. Comments (`;`/`#`) and duplicate sections
 * are tolerated; anything else is ignored (this is a scanner, not an INI parser).
 */
export function parsePlatformioEnvs(ini: string): string[] {
  const envs: string[] = [];
  for (const rawLine of ini.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;
    if (line === '[env]') {
      if (!envs.includes('env')) envs.push('env');
      continue;
    }
    const m = /^\[env:([^\]]+)\]$/.exec(line);
    if (m !== null) {
      const name = m[1].trim();
      if (name !== '' && !envs.includes(name)) envs.push(name);
    }
  }
  return envs;
}

/**
 * Recognize an external project root, or null when it matches neither build
 * system. platformio.ini wins when both markers exist (PlatformIO projects
 * carry a CMakeLists.txt for the CLion integration, so presence of both is
 * common). ESP-IDF requires CMakeLists.txt plus a strong IDF signal: an
 * sdkconfig, or the canonical `project.cmake` include in the file body.
 */
export async function detectExternalProject(dir: string): Promise<ExternalProjectKind | null> {
  if (await isFile(join(dir, 'platformio.ini'))) return 'platformio';
  const cmake = join(dir, 'CMakeLists.txt');
  if (await isFile(cmake)) {
    if (await isFile(join(dir, 'sdkconfig'))) return 'esp-idf';
    const body = await readFile(cmake, 'utf8').catch(() => '');
    if (body.includes('project.cmake')) return 'esp-idf';
  }
  return null;
}

/**
 * Detect and scan an external project for built firmware ELFs.
 * Returns null when `dir` is not a recognized PlatformIO/ESP-IDF project.
 */
export async function scanExternalProject(dir: string): Promise<ExternalScanResult | null> {
  const kind = await detectExternalProject(dir);
  if (kind === null) return null;
  const candidates = kind === 'platformio' ? await scanPlatformio(dir) : await scanEspIdf(dir);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  return { link: { kind, dir }, candidates };
}

/** PlatformIO layout: `<dir>/.pio/build/<env>/*.elf` (top level of each env dir). */
async function scanPlatformio(dir: string): Promise<ExternalElfCandidate[]> {
  const buildRoot = join(dir, '.pio', 'build');
  // Union of the envs declared in platformio.ini and the env directories that
  // actually exist: renamed envs and the bare [env] case stay discoverable.
  let declared: string[] = [];
  try {
    declared = parsePlatformioEnvs(await readFile(join(dir, 'platformio.ini'), 'utf8'));
  } catch {
    // Detection already proved platformio.ini exists; an unreadable file just
    // means "no declared envs" — the directory listing still applies.
  }
  const onDisk = (await isDir(buildRoot))
    ? (await readdir(buildRoot, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];
  const envDirs = [...declared, ...onDisk.filter((d) => !declared.includes(d))];
  const out: ExternalElfCandidate[] = [];
  for (const env of envDirs) {
    for (const elf of await listElfFiles(join(buildRoot, env))) {
      out.push({ ...elf, env });
    }
  }
  return out;
}

/** ESP-IDF layout: `<dir>/build/*.elf` (top level; nested CMake dirs ignored). */
async function scanEspIdf(dir: string): Promise<ExternalElfCandidate[]> {
  return (await listElfFiles(join(dir, 'build'))).map((elf) => ({ ...elf, env: null }));
}

/** Top-level `*.elf` files of `dir` with stats; empty when the dir is missing. */
async function listElfFiles(dir: string): Promise<Omit<ExternalElfCandidate, 'env'>[]> {
  if (!(await isDir(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out: Omit<ExternalElfCandidate, 'env'>[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.elf')) continue;
    const path = join(dir, entry.name);
    try {
      const s = await stat(path);
      out.push({ path, mtimeMs: s.mtimeMs, sizeBytes: s.size });
    } catch {
      // A file vanishing mid-scan is skipped, not fatal.
    }
  }
  return out;
}
