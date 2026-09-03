// PRD: §4.2, §F-SIM — QemuRunner lifecycle against a mock QEMU subprocess (dev-plan §7.2).
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { QemuArgsInput } from '@breadesp/sim-core';
import { QemuRunner, type SimStatus } from '../src/qemu/QemuRunner.js';

const MOCK_QEMU = join(import.meta.dirname, 'mock-qemu.mjs');
const NODE = process.execPath;

/** Args seam that swaps the QEMU binary for a Node-based mock (same argv shape). */
function mockArgsBuilder(extra: string[] = []) {
  return (input: QemuArgsInput): string[] => [
    NODE, MOCK_QEMU,
    '-kernel', input.firmwareElf,
    '-qmp', `tcp:127.0.0.1:${input.qmpPort ?? 0},server=on,wait=off`,
    ...extra,
  ];
}

async function until(fn: () => boolean, ms = 5000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function trackStatus(runner: QemuRunner): { once(s: SimStatus): Promise<void> } {
  const seen = new Set<SimStatus>();
  const waiters: Array<{ s: SimStatus; resolve: () => void }> = [];
  runner.on('status', (s: SimStatus) => {
    seen.add(s);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].s === s) { waiters[i].resolve(); waiters.splice(i, 1); }
    }
  });
  return {
    once(s: SimStatus): Promise<void> {
      if (seen.has(s)) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ s, resolve }));
    },
  };
}

describe('QemuRunner (mock subprocess)', () => {
  it('gates execution behind start(): no uart before cont, Hello ESP32 after', async () => {
    const runner = new QemuRunner();
    const chunks: string[] = [];
    runner.on('uart', (s: string) => chunks.push(s));

    await runner.load({
      firmwareElf: 'mock://blink.elf',
      chip: 'esp32',
      qemuBin: NODE, // unused by the seam; validated only for the default builder
      argsBuilder: mockArgsBuilder(),
    });
    expect(runner.getStatus()).toBe('loaded');
    // The mock only prints after QMP `cont`; a short grace proves nothing leaked early.
    await new Promise((r) => setTimeout(r, 300));
    expect(chunks.join('')).not.toContain('Hello ESP32');

    await runner.start();
    expect(runner.getStatus()).toBe('running');
    await until(() => chunks.join('').includes('Hello ESP32'), 5000, 'uart Hello ESP32');
    expect(runner.getUartLog()).toContain('Hello ESP32');

    await runner.stop();
    expect(runner.getStatus()).toBe('stopped');
  }, 15000);

  it('pauses a running VM via QMP stop', async () => {
    const runner = new QemuRunner();
    const status = trackStatus(runner);
    await runner.load({
      firmwareElf: 'mock://blink.elf',
      chip: 'esp32',
      qemuBin: NODE,
      argsBuilder: mockArgsBuilder(),
    });
    await runner.start();
    await status.once('running');
    await runner.pause();
    expect(runner.getStatus()).toBe('paused');
    await runner.stop();
    expect(runner.getStatus()).toBe('stopped');
  }, 15000);

  it('reports error status when the subprocess crashes at startup', async () => {
    const runner = new QemuRunner();
    const status = trackStatus(runner);
    await runner.load({
      firmwareElf: 'mock://blink.elf',
      chip: 'esp32',
      qemuBin: NODE,
      argsBuilder: mockArgsBuilder(['--exit-error']),
    });
    await status.once('error');
    expect(runner.getStatus()).toBe('error');
  }, 15000);

  it('stop() on a loaded-but-never-started VM terminates the child', async () => {
    const runner = new QemuRunner();
    await runner.load({
      firmwareElf: 'mock://blink.elf',
      chip: 'esp32',
      qemuBin: NODE,
      argsBuilder: mockArgsBuilder(),
    });
    await runner.stop();
    expect(runner.getStatus()).toBe('stopped');
  }, 15000);

  it('rejects start() before load() with a readable error', async () => {
    const runner = new QemuRunner();
    await expect(runner.start()).rejects.toThrow(/\[BB-102\]/);
  });

  // --- P2.6 (PRD §F-SIM-2): speed multiplier + duty-cycle throttle ---

  it('rejects non-finite or out-of-range speed factors with [BB-116]', () => {
    const runner = new QemuRunner();
    expect(runner.getSpeed()).toBe(1);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, 0.05, 10.5, -1]) {
      expect(() => runner.setSpeed(bad)).toThrow(/\[BB-116\] speed factor/);
    }
    expect(() => runner.setSpeed(0.1)).not.toThrow();
    expect(() => runner.setSpeed(10)).not.toThrow();
    expect(runner.getSpeed()).toBe(10);
  });

  it('emits speed events with the applied factor', () => {
    const runner = new QemuRunner();
    const seen: number[] = [];
    runner.on('speed', (f: number) => seen.push(f));
    runner.setSpeed(0.5);
    runner.setSpeed(2);
    expect(seen).toEqual([0.5, 2]);
  });

  it('throttles a running VM below 1x by QMP stop/cont duty-cycling', async () => {
    const runner = new QemuRunner({ throttleQuantumMs: 40 });
    const logs: string[] = [];
    runner.on('log', (s: string) => logs.push(s));
    const countStops = () => logs.join('').split('mock-qemu: qmp stop').length - 1;

    runner.setSpeed(0.5); // armed before start; applies once running
    await runner.load({
      firmwareElf: 'mock://blink.elf',
      chip: 'esp32',
      qemuBin: NODE,
      argsBuilder: mockArgsBuilder(),
    });
    await runner.start();
    expect(runner.getStatus()).toBe('running');

    // 40ms quantum: ~12 halt windows per 500ms of wall time.
    await until(() => countStops() >= 4, 5000, 'throttle halt windows');
    // Throttle halts are internal: the broadcast status stays 'running'.
    expect(runner.getStatus()).toBe('running');
    const contCount = logs.join('').split('mock-qemu: qmp cont').length - 1;
    expect(contCount).toBeGreaterThanOrEqual(4);

    // A user pause supersedes the cycle: no further throttle stops arrive.
    await runner.pause();
    expect(runner.getStatus()).toBe('paused');
    // Settle first: a stop already in flight when pause() landed may flush
    // its stderr log line a tick late — that one predates the pause.
    await new Promise((r) => setTimeout(r, 60));
    const stopsAtPause = countStops();
    await new Promise((r) => setTimeout(r, 200));
    expect(countStops()).toBe(stopsAtPause);

    // Resume keeps throttling, and restoring 1x disarms the cycle.
    await runner.start();
    await until(() => countStops() > stopsAtPause, 5000, 'throttle resumes after start');
    runner.setSpeed(1);
    await new Promise((r) => setTimeout(r, 60)); // settle in-flight stop logs
    const stopsAtFull = countStops();
    await new Promise((r) => setTimeout(r, 200));
    expect(countStops()).toBe(stopsAtFull);
    expect(runner.getStatus()).toBe('running');

    await runner.stop();
    expect(runner.getStatus()).toBe('stopped');
  }, 20000);

  it('forwards writeStdin bytes to the subprocess stdin (P1.10)', async () => {
    const runner = new QemuRunner();
    const chunks: string[] = [];
    runner.on('uart', (s: string) => chunks.push(s));
    await runner.load({
      firmwareElf: 'mock://uart-echo.elf',
      chip: 'esp32',
      qemuBin: NODE,
      argsBuilder: mockArgsBuilder(),
    });
    await runner.start();
    // The mock echoes stdin back on stdout (UART0 RX -> firmware -> TX).
    runner.writeStdin('Hello BreadESP\n');
    await until(() => chunks.join('').includes('Hello BreadESP\n'), 5000, 'stdin echo on uart');
    await runner.stop();
    expect(runner.getStatus()).toBe('stopped');
  }, 15000);

  it('rejects writeStdin before load() with a readable error (P1.10)', () => {
    const runner = new QemuRunner();
    expect(() => runner.writeStdin('x')).toThrow(/\[BB-102\] QEMU is not loaded/);
  });

  it('validates the firmware ELF path up front (default builder)', async () => {
    const runner = new QemuRunner();
    await expect(runner.load({
      firmwareElf: 'Z:/definitely/missing.elf',
      chip: 'esp32',
      qemuBin: NODE,
    })).rejects.toThrow(/\[BB-100\] firmware ELF not found/);
  });

  it('validates the QEMU binary path up front (default builder)', async () => {
    const runner = new QemuRunner();
    const missingBin = process.platform === 'win32' ? 'Z:/missing/qemu-system-xtensa.exe' : '/missing/qemu-system-xtensa';
    await expect(runner.load({
      firmwareElf: join(import.meta.dirname, 'mock-qemu.mjs'),
      chip: 'esp32',
      qemuBin: missingBin,
    })).rejects.toThrow(/\[BB-100\] QEMU binary not found/);
  });
});
