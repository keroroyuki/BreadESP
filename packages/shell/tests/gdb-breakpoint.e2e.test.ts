// PRD: §F-DBG-1, §F-DBG-5, §9 — dev-plan task P0.5 acceptance (end-to-end).
// 1. The QEMU GDB stub listens on the requested loopback port and answers the
//    RSP halt query (runs with just the fetched QEMU binary).
// 2. Full acceptance: `setBreakpoint('app_main')` + continue stops GDB at
//    app_main. Requires xtensa-esp32-elf-gdb; skipped unless BREADESP_GDB_BIN
//    points at it (dev-plan §11.2), mirroring the QEMU skip behavior of the
//    P0.4 e2e.
import { describe, expect, it } from 'vitest';
import net from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QemuRunner } from '../src/qemu/QemuRunner.js';
import { GdbBridge, type StoppedInfo } from '../src/debugger/GdbBridge.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const FIXTURE_ELF = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'blink.elf');

// Small local copies of the P0.4 e2e resolvers (kept separate to avoid
// refactoring that test inside this task's scope).
function resolveQemuBin(): string | null {
  const fromEnv = process.env.BREADESP_QEMU_BIN;
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv;
  const manifestPath = join(REPO_ROOT, 'packages', 'sim-core', 'bin', 'qemu.json');
  if (!existsSync(manifestPath)) return null;
  try {
    // JSON manifest written by scripts/fetch-qemu.mjs — trusted repo artifact.
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { repoRelativePath?: string };
    if (manifest.repoRelativePath === undefined) return null;
    const bin = join(REPO_ROOT, manifest.repoRelativePath);
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

function resolveGdbBin(): string | null {
  const fromEnv = process.env.BREADESP_GDB_BIN;
  return fromEnv !== undefined && existsSync(fromEnv) ? fromEnv : null;
}

const QEMU_BIN = resolveQemuBin();
const GDB_BIN = resolveGdbBin();

function needQemuBin(): string {
  if (QEMU_BIN === null) throw new Error('QEMU binary missing; run pnpm fetch-qemu');
  return QEMU_BIN;
}

/** Reserve an ephemeral loopback port, then release it for QEMU to bind. */
function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('failed to allocate an ephemeral gdb stub port'));
        return;
      }
      server.close(() => resolve(addr.port));
    });
  });
}

/** Minimal GDB Remote Serial Protocol client, just enough for a smoke check. */
function rspPacket(cmd: string): string {
  let sum = 0;
  for (const ch of cmd) sum = (sum + ch.charCodeAt(0)) & 0xff;
  return `$${cmd}#${sum.toString(16).padStart(2, '0')}`;
}

function rspExchange(port: number, cmd: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buf = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`RSP timeout waiting for a reply to '${cmd}'`));
    }, timeoutMs);
    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
    socket.on('connect', () => socket.write(rspPacket(cmd)));
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('ascii');
      const m = /\$([^#]*)#[0-9a-fA-F]{2}/.exec(buf);
      if (m) {
        clearTimeout(timer);
        socket.destroy();
        resolve(m[1]);
      }
    });
  });
}

function waitStopped(gdb: GdbBridge, what: string, timeoutMs = 30_000): Promise<StoppedInfo> {
  return new Promise<StoppedInfo>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs);
    gdb.once('stopped', (info: StoppedInfo) => {
      clearTimeout(timer);
      resolve(info);
    });
  });
}

describe.skipIf(QEMU_BIN === null)('QEMU GDB stub (real QEMU-ESP32)', () => {
  it('listens on the requested loopback port and answers the RSP halt query', async () => {
    const gdbPort = await allocatePort();
    const runner = new QemuRunner();
    await runner.load({ firmwareElf: FIXTURE_ELF, chip: 'esp32', qemuBin: needQemuBin(), gdbPort });

    // The stub binds during machine init; give it a short retry window.
    let reply: string | null = null;
    let lastErr: unknown = null;
    const deadline = Date.now() + 10_000;
    while (reply === null && Date.now() < deadline) {
      try {
        reply = await rspExchange(gdbPort, '?');
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    try {
      expect(reply).not.toBeNull();
      // Halt reason for the -S frozen VM: T05 (signal TRAP) or S05 on older stubs.
      expect(reply!.startsWith('T') || reply!.startsWith('S')).toBe(true);
    } catch {
      throw new Error(`GDB stub did not answer '?' on 127.0.0.1:${gdbPort}: ${String(lastErr)}`);
    }
    await runner.stop();
    expect(runner.getStatus()).toBe('stopped');
  }, 30_000);
});

describe.skipIf(QEMU_BIN === null || GDB_BIN === null)('GdbBridge e2e (real QEMU + real GDB)', () => {
  it('setBreakpoint("app_main") + continue stops at app_main (P0.5 acceptance)', async () => {
    const gdbPort = await allocatePort();
    const runner = new QemuRunner();
    await runner.load({ firmwareElf: FIXTURE_ELF, chip: 'esp32', qemuBin: needQemuBin(), gdbPort });

    const gdb = new GdbBridge();
    try {
      await gdb.start({ gdbBin: GDB_BIN!, elfPath: FIXTURE_ELF, targetHost: '127.0.0.1', port: gdbPort });

      const bp = await gdb.setBreakpoint('app_main');
      expect(bp.id).toBeGreaterThan(0);
      expect(bp.enabled).toBe(true);
      expect(bp.address).toMatch(/^0x[0-9a-f]+$/i);

      await gdb.continue();
      const stop = await waitStopped(gdb, 'the app_main breakpoint hit');
      expect(stop.reason).toBe('breakpoint-hit');
      expect(stop.frame?.func).toBe('app_main');

      // Bonus within scope: single-instruction step from the breakpoint.
      const stepped = waitStopped(gdb, 'the instruction step');
      await gdb.step();
      expect((await stepped).reason).toBe('end-stepping-range');

      await gdb.stop();
    } finally {
      await runner.stop();
    }
    expect(runner.getStatus()).toBe('stopped');
  }, 90_000);
});
