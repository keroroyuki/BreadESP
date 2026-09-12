// PRD: §6.5, §F-SIM — dev-plan task P4.1 acceptance (end-to-end, real QEMU).
// The chip -> machine mapping must reach the real emulator: the same QemuRunner
// load path boots blink.elf on `-machine esp32` and s3-blink.elf on
// `-machine esp32s3` (both Xtensa, served by the stock qemu-system-xtensa).
// A wrong chip/binary family combination (Xtensa binary asked for the RISC-V
// esp32c3 machine) must fail loudly as status 'error', not hang. Skips when
// the QEMU binary has not been fetched yet (`pnpm fetch-qemu`).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QemuRunner } from '../src/qemu/QemuRunner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const FIXTURES = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures');
const BLINK_ELF = join(FIXTURES, 'blink.elf');
const S3_BLINK_ELF = join(FIXTURES, 's3-blink.elf');

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

const QEMU_BIN = resolveQemuBin();

function needQemuBin(): string {
  if (QEMU_BIN === null) throw new Error('QEMU binary missing; run pnpm fetch-qemu');
  return QEMU_BIN;
}

/** Poll until fn() holds or the deadline passes (e2e assertion helper). */
async function until(fn: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(QEMU_BIN === null)('chip machine mapping e2e (real QEMU, dev-plan P4.1)', () => {
  it('boots blink.elf on -machine esp32 via the same runner path', async () => {
    const runner = new QemuRunner();
    const logs: string[] = [];
    runner.on('log', (s: string) => logs.push(s));

    await runner.load({ firmwareElf: BLINK_ELF, chip: 'esp32', qemuBin: needQemuBin() });
    await runner.start();

    // '\r\n'-suffixed: 'Hello ESP32-S3' would also match a bare 'Hello ESP32'.
    await until(() => runner.getUartLog().includes('Hello ESP32\r\n'), 30000, 'esp32 hello');
    expect(runner.getUartLog()).toContain('Hello ESP32\r\n');

    await runner.stop();
    expect(runner.getStatus()).toBe('stopped');
  }, 60000);

  it('boots s3-blink.elf on -machine esp32s3', async () => {
    const runner = new QemuRunner();
    const logs: string[] = [];
    runner.on('log', (s: string) => logs.push(s));

    await runner.load({ firmwareElf: S3_BLINK_ELF, chip: 'esp32s3', qemuBin: needQemuBin() });
    expect(runner.getStatus()).toBe('loaded');
    await runner.start();

    await until(() => runner.getUartLog().includes('Hello ESP32-S3\r\n'), 30000, 's3 hello');
    expect(runner.getUartLog()).toContain('Hello ESP32-S3\r\n');

    await runner.stop();
    expect(runner.getStatus()).toBe('stopped');
  }, 60000);

  it('fails loudly when the RISC-V esp32c3 machine is asked of the Xtensa binary', async () => {
    const runner = new QemuRunner();
    const logs: string[] = [];
    runner.on('log', (s: string) => logs.push(s));

    // No ELF-architecture gate at this layer (that is ProjectManager/IPC's job):
    // the Xtensa fixture with a RISC-V chip reaches QEMU, whose unknown machine
    // must surface as status 'error' (PRD §F-SIM-4) instead of a silent hang.
    await runner.load({ firmwareElf: BLINK_ELF, chip: 'esp32c3', qemuBin: needQemuBin() });
    await until(() => runner.getStatus() === 'error', 15000, 'qemu error status');
    expect(runner.getStatus()).toBe('error');

    await runner.stop();
  }, 30000);
});
