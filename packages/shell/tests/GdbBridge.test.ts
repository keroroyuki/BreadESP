// PRD: §F-DBG-1, §F-DBG-5 — GdbBridge integration tests against a mock GDB/MI
// subprocess (dev-plan §7.2: shell integration tests use mock child processes).
// Covers the P0.5 surface: MI handshake + target-select, -break-insert parsing,
// breakpoint-hit / end-stepping-range stopped events, ^error propagation,
// command timeouts and graceful shutdown.
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { GdbBridge, type GdbStartOptions, type StoppedInfo } from '../src/debugger/GdbBridge.js';

const MOCK_GDB = join(import.meta.dirname, 'mock-gdb.mjs');
const NODE = process.execPath;

/** Args seam that swaps the GDB binary for a Node-based MI mock (same shape). */
function mockArgsBuilder(scenario: string) {
  return (opts: GdbStartOptions): string[] => [
    NODE, MOCK_GDB, '--scenario', scenario, opts.elfPath,
  ];
}

async function onceStopped(gdb: GdbBridge, what: string): Promise<StoppedInfo> {
  return new Promise<StoppedInfo>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), 5000);
    gdb.once('stopped', (info: StoppedInfo) => {
      clearTimeout(timer);
      resolve(info);
    });
  });
}

describe('GdbBridge (mock GDB/MI subprocess)', () => {
  let openBridge: GdbBridge | null = null;
  afterEach(async () => {
    await openBridge?.stop();
    openBridge = null;
  });

  async function startBridge(scenario: string, commandTimeoutMs?: number): Promise<GdbBridge> {
    const bridge = new GdbBridge();
    bridge.on('log', () => {}); // command echo from the mock; uninteresting here
    openBridge = bridge;
    await bridge.start({
      gdbBin: NODE,
      elfPath: 'mock://blink.elf',
      targetHost: '127.0.0.1',
      port: 1234,
      commandTimeoutMs,
      argsBuilder: mockArgsBuilder(scenario),
    });
    return bridge;
  }

  it('completes the MI handshake after -target-select remote', async () => {
    await startBridge('ok'); // start() resolves only past the ^connected handshake
  }, 10000);

  it('setBreakpoint parses the bkpt tuple', async () => {
    const bridge = await startBridge('ok');
    const bp = await bridge.setBreakpoint('app_main');
    expect(bp).toEqual({ id: 1, address: '0x40080024', enabled: true });
    const bp2 = await bridge.setBreakpoint('*0x40080027');
    expect(bp2.id).toBe(2);
    await bridge.removeBreakpoint(bp.id);
  }, 10000);

  it('continue() resolves on ^running and emits breakpoint-hit stopped at app_main', async () => {
    const bridge = await startBridge('ok');
    const stopped = onceStopped(bridge, 'breakpoint hit');
    await bridge.continue();
    const info = await stopped;
    expect(info.reason).toBe('breakpoint-hit');
    expect(info.breakpointNumber).toBe('1');
    expect(info.frame?.func).toBe('app_main');
    expect(info.frame?.addr).toBe('0x40080024');
    expect(info.stoppedThreads).toEqual(['all']);
  }, 10000);

  it('step() emits an end-stepping-range stop at the next instruction', async () => {
    const bridge = await startBridge('ok');
    const stopped = onceStopped(bridge, 'step stop');
    await bridge.step();
    const info = await stopped;
    expect(info.reason).toBe('end-stepping-range');
    expect(info.frame?.func).toBe('app_main');
    expect(info.frame?.addr).toBe('0x40080027');
  }, 10000);

  it('propagates ^error replies as readable failures', async () => {
    const bridge = await startBridge('error');
    await expect(bridge.setBreakpoint('app_main')).rejects.toThrow(/\[BB-113\].*not defined/);
  }, 10000);

  it('propagates target-select failures out of start()', async () => {
    const bridge = new GdbBridge();
    openBridge = bridge;
    await expect(bridge.start({
      gdbBin: NODE,
      elfPath: 'mock://blink.elf',
      targetHost: '127.0.0.1',
      port: 1,
      argsBuilder: mockArgsBuilder('refuse'),
    })).rejects.toThrow(/\[BB-113\].*Connection refused/);
  }, 10000);

  it('rejects commands that never answer with a timeout', async () => {
    const bridge = await startBridge('hang', 250);
    await expect(bridge.setBreakpoint('app_main')).rejects.toThrow(/\[BB-112\].*timed out.*-break-insert/);
  }, 10000);

  it('stop() shuts GDB down gracefully; later commands fail with BB-114', async () => {
    const bridge = await startBridge('ok');
    let exitCode: number | null = null;
    bridge.on('exit', (code: number) => { exitCode = code; });
    await bridge.stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(exitCode).toBe(0);
    await expect(bridge.setBreakpoint('app_main')).rejects.toThrow(/\[BB-114\]/);
    await bridge.stop(); // idempotent
  }, 10000);

  it('validates the GDB binary path up front (default builder)', async () => {
    const missingBin = process.platform === 'win32' ? 'Z:/missing/xtensa-esp32-elf-gdb.exe' : '/missing/xtensa-esp32-elf-gdb';
    const bridge = new GdbBridge();
    openBridge = bridge;
    await expect(bridge.start({
      gdbBin: missingBin,
      elfPath: 'mock://blink.elf',
      targetHost: '127.0.0.1',
      port: 1234,
    })).rejects.toThrow(/\[BB-110\] GDB binary not found/);
  });
});
