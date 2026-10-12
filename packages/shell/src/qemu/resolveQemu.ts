// PRD: §4.2, §9, §11.2 — QEMU binary resolution for the Bridge (packaging P6.1).
//
// The app must find a runnable qemu-system-* without any user configuration:
// an installed build ships the breadesp-dbus device build under
// <resources>/qemu/, a dev checkout resolves the repo's packages/sim-core/bin
// metadata (qemu-breadesp.json / qemu.json), and BREADESP_QEMU_BIN /
// BREADESP_QEMU_DBUS_BIN stay explicit overrides. `hasDevice` tells the caller
// whether the resolved binary carries the breadesp-dbus forward device — only
// then may the load argv include `-device breadesp-dbus,...` (a stock binary
// would exit with "device not found").
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { qemuSystemForChip } from '@breadesp/sim-core';
import type { ChipKind } from '@breadesp/netlist';

export interface QemuResolution {
  /** Absolute path of the qemu-system-* binary to spawn. */
  qemuBin: string;
  /** True when the binary carries the breadesp-dbus device (peripheral buses live). */
  hasDevice: boolean;
  /** Human-readable origin for diagnostics ('env:…', 'packaged', 'repo:qemu-breadesp.json', …). */
  source: string;
}

/** Test seam: every environment touch point is injectable. */
export interface ResolveQemuOptions {
  env?: NodeJS.ProcessEnv;
  /** Electron's process.resourcesPath; undefined outside a packaged app. */
  resourcesPath?: string;
  /** Search start for the repo-layout walk (defaults to this module's dir). */
  startDir?: string;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
}

/** Metadata written by scripts/build-qemu-device.mjs next to the staged build. */
interface QemuMeta {
  binaryPath?: string;
  target?: string;
}

const DEVICE_META = 'qemu-breadesp.json';
const STOCK_META = 'qemu.json';

/** The packaged bundle ships the device build only when this marker exists. */
function packagedBin(resourcesPath: string, binName: string, exists: (p: string) => boolean): QemuResolution | null {
  const qemuDir = join(resourcesPath, 'qemu');
  const qemuBin = join(qemuDir, 'bin', binName);
  if (!exists(qemuBin)) return null;
  return { qemuBin, hasDevice: exists(join(qemuDir, DEVICE_META)), source: 'packaged' };
}

/** A repo bin/qemu-breadesp.json entry is usable only when it targets this host. */
function deviceMetaHostCompatible(meta: QemuMeta, platform: NodeJS.Platform): boolean {
  if (meta.target === 'windows-msys2') return platform === 'win32';
  if (meta.target === 'linux-docker') return platform === 'linux';
  return false;
}

/** Walk up from `startDir` looking for the repo's packages/sim-core/bin metadata. */
function repoResolution(
  startDir: string,
  binName: string,
  platform: NodeJS.Platform,
  exists: (p: string) => boolean,
  read: (p: string) => string,
): QemuResolution | null {
  let dir = startDir;
  for (let depth = 0; depth < 12; depth++) {
    const binDir = join(dir, 'packages', 'sim-core', 'bin');
    const deviceMetaPath = join(binDir, DEVICE_META);
    if (exists(deviceMetaPath)) {
      try {
        const meta = JSON.parse(read(deviceMetaPath)) as QemuMeta;
        if (
          typeof meta.binaryPath === 'string' &&
          basename(meta.binaryPath) === binName &&
          deviceMetaHostCompatible(meta, platform) &&
          exists(meta.binaryPath)
        ) {
          return { qemuBin: meta.binaryPath, hasDevice: true, source: `repo:${DEVICE_META}` };
        }
      } catch {
        // Malformed metadata: fall through to the stock manifest.
      }
    }
    const stockMetaPath = join(binDir, STOCK_META);
    if (exists(stockMetaPath)) {
      try {
        const meta = JSON.parse(read(stockMetaPath)) as QemuMeta;
        if (typeof meta.binaryPath === 'string' && basename(meta.binaryPath) === binName && exists(meta.binaryPath)) {
          return { qemuBin: meta.binaryPath, hasDevice: false, source: `repo:${STOCK_META}` };
        }
      } catch {
        // Malformed metadata: keep walking up.
      }
    }
    const parent = join(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the QEMU binary for `chip`. `explicitBin` (renderer-sent, dev flows)
 * always wins and is trusted to carry the device. Throws [BB-100] with the
 * full search story when nothing runnable exists.
 */
export function resolveQemu(chip: ChipKind, explicitBin?: string, opts: ResolveQemuOptions = {}): QemuResolution {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? existsSync;
  const read = (p: string): string => readFileSync(p, 'utf8');
  const resourcesPath = opts.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const startDir = opts.startDir ?? __dirname;

  const system = qemuSystemForChip(chip);
  const binName = platform === 'win32' ? `${system}.exe` : system;

  if (explicitBin !== undefined && explicitBin !== '') {
    return { qemuBin: explicitBin, hasDevice: true, source: 'explicit' };
  }

  const tried: string[] = [];
  const envDbus = env.BREADESP_QEMU_DBUS_BIN;
  if (envDbus !== undefined && envDbus !== '') {
    if (exists(envDbus)) return { qemuBin: envDbus, hasDevice: true, source: 'env:BREADESP_QEMU_DBUS_BIN' };
    tried.push(`BREADESP_QEMU_DBUS_BIN=${envDbus} (not found)`);
  }
  const envBin = env.BREADESP_QEMU_BIN;
  if (envBin !== undefined && envBin !== '') {
    // Historical dev flow (fetch-qemu prints this hint): assumed to be a stock
    // binary — firmware/UART/debug work, peripheral buses stay silent.
    if (exists(envBin)) return { qemuBin: envBin, hasDevice: false, source: 'env:BREADESP_QEMU_BIN' };
    tried.push(`BREADESP_QEMU_BIN=${envBin} (not found)`);
  }

  if (resourcesPath !== undefined && resourcesPath !== '') {
    const hit = packagedBin(resourcesPath, binName, exists);
    if (hit) return hit;
    tried.push(`${join(resourcesPath, 'qemu', 'bin', binName)} (not bundled)`);
  }

  const repo = repoResolution(startDir, binName, platform, exists, read);
  if (repo) return repo;
  tried.push('packages/sim-core/bin/{qemu-breadesp.json,qemu.json} (not found or not usable on this host)');

  throw new Error(
    `[BB-100] no usable ${binName} for chip '${chip}'.\nSearched:\n  - ${tried.join('\n  - ')}\n` +
      'Remediation: run `pnpm fetch-qemu` (stock, no peripheral buses) or ' +
      '`node scripts/build-qemu-device.mjs` (breadesp-dbus build), or set BREADESP_QEMU_BIN / BREADESP_QEMU_DBUS_BIN.',
  );
}
