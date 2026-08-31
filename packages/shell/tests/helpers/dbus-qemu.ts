// PRD: §6.7 — shared gate for e2e tests that need the breadesp-dbus-enabled QEMU.
// Resolves the binary from BREADESP_QEMU_DBUS_BIN or the manifest written by
// scripts/build-qemu-device.mjs (packages/sim-core/bin/qemu-breadesp.json).
// Path separators are normalized so a manifest written on one host (e.g.
// Windows MSYS2 build) is also consumable from WSL running a linux-docker build.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// tests/helpers -> tests -> shell -> packages -> repo root
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const DBUS_META = join(REPO_ROOT, 'packages', 'sim-core', 'bin', 'qemu-breadesp.json');

interface DbusMeta {
  target?: string;
  binaryPath?: string;
  repoRelativePath?: string;
}

/** Normalize Windows separators so metadata paths work on POSIX hosts too. */
function normalizePath(p: string): string {
  return p.replaceAll('\\', '/');
}

/** Manifest written by scripts/build-qemu-device.mjs — trusted repo artifact. */
export function resolveDbusQemuBin(): string | null {
  const fromEnv = process.env.BREADESP_QEMU_DBUS_BIN;
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv;
  if (!existsSync(DBUS_META)) return null;
  let meta: DbusMeta;
  try {
    meta = JSON.parse(readFileSync(DBUS_META, 'utf8')) as DbusMeta;
  } catch {
    return null;
  }
  // A linux-docker build produces a Linux ELF; it cannot run on other hosts.
  if (meta.target === 'linux-docker' && process.platform !== 'linux') return null;
  for (const p of [meta.binaryPath, meta.repoRelativePath]) {
    if (typeof p === 'string' && p.length > 0 && existsSync(normalizePath(p))) return normalizePath(p);
  }
  if (typeof meta.repoRelativePath === 'string') {
    const rel = join(REPO_ROOT, normalizePath(meta.repoRelativePath));
    if (existsSync(rel)) return rel;
  }
  return null;
}

export function needDbusQemuBin(): string {
  const bin = resolveDbusQemuBin();
  if (bin === null) {
    throw new Error('device-enabled QEMU missing; run node scripts/build-qemu-device.mjs');
  }
  return bin;
}
