// PRD: §F-SER-1, §F-SIM — dev-plan task P0.4 acceptance (end-to-end, real QEMU).
// Loads the golden firmware (P0.3 fixture) into the real qemu-system-xtensa and
// asserts the UART0 stream carries `Hello ESP32` after start(). Skips when the
// QEMU binary has not been fetched yet (`pnpm fetch-qemu`).
// P1.10 adds the bidirectional acceptance: writeStdin() bytes travel the stdio
// chardev into UART0 RX, and the uart-echo golden firmware reads them back out.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QemuRunner } from '../src/qemu/QemuRunner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const FIXTURE_ELF = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'blink.elf');
const ECHO_ELF = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'uart-echo.elf');

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

async function until(fn: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function needQemuBin(): string {
  if (QEMU_BIN === null) throw new Error('QEMU binary missing; run pnpm fetch-qemu');
  return QEMU_BIN;
}

describe.skipIf(QEMU_BIN === null)('QemuRunner e2e (real QEMU-ESP32)', () => {
  it('boots blink.elf and prints Hello ESP32 on UART0 after start()', async () => {
    const runner = new QemuRunner();
    const logs: string[] = [];
    runner.on('log', (s: string) => logs.push(s));

    await runner.load({ firmwareElf: FIXTURE_ELF, chip: 'esp32', qemuBin: needQemuBin() });
    expect(runner.getStatus()).toBe('loaded');

    await runner.start();
    expect(runner.getStatus()).toBe('running');

    const t0 = Date.now();
    while (!runner.getUartLog().includes('Hello ESP32')) {
      if (Date.now() - t0 > 30000) {
        throw new Error(
          `UART did not print Hello ESP32 within 30s. status=${runner.getStatus()} log=${JSON.stringify(logs.join(''))} uart=${JSON.stringify(runner.getUartLog())}`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(runner.getUartLog()).toContain('Hello ESP32');

    await runner.stop();
    expect(runner.getStatus()).toBe('stopped');
  }, 60000);

  // dev-plan task P1.10 acceptance: 键入回车被固件读到.
  it('echoes a stdin-injected line back over UART0 (uart-echo.elf)', async () => {
    const runner = new QemuRunner();
    const logs: string[] = [];
    runner.on('log', (s: string) => logs.push(s));

    await runner.load({ firmwareElf: ECHO_ELF, chip: 'esp32', qemuBin: needQemuBin() });
    await runner.start();
    await until(() => runner.getUartLog().includes('UART echo ready'), 30000, 'echo banner');

    // LF-only terminator: the Windows stdio backend (char-win-stdio.c) drops '\r'.
    runner.writeStdin('Hello BreadESP\n');

    const t0 = Date.now();
    while (!runner.getUartLog().includes('ECHO: Hello BreadESP\r\n')) {
      if (Date.now() - t0 > 30000) {
        throw new Error(
          `firmware did not echo the injected line. status=${runner.getStatus()} log=${JSON.stringify(logs.join(''))} uart=${JSON.stringify(runner.getUartLog())}`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    // A second line proves the buffer reset keeps the console usable.
    runner.writeStdin('line two\n');
    await until(() => runner.getUartLog().includes('ECHO: line two\r\n'), 30000, 'second echo');

    await runner.stop();
    expect(runner.getStatus()).toBe('stopped');
  }, 90000);
});
