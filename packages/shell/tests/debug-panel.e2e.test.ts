// PRD: §F-DBG-1..3, §9 — dev-plan task P1.9 acceptance (end-to-end).
// Real QEMU + real xtensa-esp32-elf-gdb against the DWARF-carrying blink.elf:
//   1. breakpoint at `led_state_written` (the instruction after led_state=1),
//   2. global watch: `led_state` reads 1 at the stop,
//   3. frame locals from the hand-built DWARF (app_main),
//   4. registers (pc lands on the breakpoint address),
//   5. instruction single step,
//   6. breakpoint listing + clear.
// Requires xtensa-esp32-elf-gdb; skipped unless BREADESP_GDB_BIN points at
// it, mirroring the skip behavior of the P0.5 GDB e2e.
import { describe, expect, it } from 'vitest';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QemuRunner } from '../src/qemu/QemuRunner.js';
import { GdbBridge, type StoppedInfo } from '../src/debugger/GdbBridge.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const FIXTURE_ELF = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'blink.elf');
const LED_STATE_WRITTEN = 0x40080078; // label after `led_state = 1` (make-blink-elf.mjs)

// Local resolvers (same policy as gdb-breakpoint.e2e.test.ts — kept separate
// so each e2e stays independently runnable).
function resolveQemuBin(): string | null {
  const fromEnv = process.env.BREADESP_QEMU_BIN;
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv;
  return null;
}

function resolveGdbBin(): string | null {
  const fromEnv = process.env.BREADESP_GDB_BIN;
  return fromEnv !== undefined && existsSync(fromEnv) ? fromEnv : null;
}

const QEMU_BIN = resolveQemuBin();
const GDB_BIN = resolveGdbBin();

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

function waitStopped(gdb: GdbBridge, what: string, timeoutMs = 30_000): Promise<StoppedInfo> {
  return new Promise<StoppedInfo>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs);
    gdb.once('stopped', (info: StoppedInfo) => {
      clearTimeout(timer);
      resolve(info);
    });
  });
}

describe.skipIf(QEMU_BIN === null || GDB_BIN === null)('debug panel e2e (real QEMU + real GDB, P1.9)', () => {
  it('breakpoint/step/locals/globals/registers against DWARF blink.elf', async () => {
    const gdbPort = await allocatePort();
    const runner = new QemuRunner();
    await runner.load({ firmwareElf: FIXTURE_ELF, chip: 'esp32', qemuBin: QEMU_BIN!, gdbPort });

    const gdb = new GdbBridge();
    gdb.on('log', () => {}); // keep GDB's stderr chatter out of the test output
    try {
      await gdb.start({ gdbBin: GDB_BIN!, elfPath: FIXTURE_ELF, targetHost: '127.0.0.1', port: gdbPort, chip: 'esp32' });

      // 1. Breakpoint right after `led_state = 1` — the stop proves the write happened.
      const bp = await gdb.setBreakpoint('led_state_written');
      expect(bp.id).toBeGreaterThan(0);
      expect(bp.address).toBe(`0x${LED_STATE_WRITTEN.toString(16)}`);

      const stop = waitStopped(gdb, 'the led_state_written breakpoint hit');
      await gdb.continue();
      const info = await stop;
      expect(info.reason).toBe('breakpoint-hit');
      expect(info.frame?.func).toBe('app_main');

      // 2. Global watch (PRD F-DBG-3 全局变量): led_state was just written to 1.
      expect(await gdb.evaluate('led_state')).toBe('1');

      // 3. Frame locals from the fixture's DWARF (PRD F-DBG-3 局部变量 — P1.9 acceptance).
      const vars = await gdb.vars();
      const names = vars.map((v) => v.name);
      expect(names).toContain('msg_cursor');
      expect(names).toContain('remaining');
      expect(names).toContain('delay_ticks');
      const remaining = vars.find((v) => v.name === 'remaining');
      expect(remaining?.value).toBe('0'); // the print loop finished its 13 chars

      // 4. Registers (PRD F-DBG-3 寄存器): pc sits on the breakpoint address.
      const regs = await gdb.regs();
      expect(Object.keys(regs).length).toBeGreaterThan(0);
      expect(parseInt(regs.pc, 16)).toBe(LED_STATE_WRITTEN);

      // 5. Instruction single step (PRD F-DBG-2 单步).
      const stepped = waitStopped(gdb, 'the instruction step');
      await gdb.step();
      expect((await stepped).reason).toBe('end-stepping-range');

      // 6. Breakpoint listing + clear (PRD F-DBG-1 删除断点/清空断点).
      let rows = await gdb.listBreakpoints();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: bp.id, location: 'led_state_written' });
      await gdb.clearBreakpoints();
      rows = await gdb.listBreakpoints();
      expect(rows).toHaveLength(0);

      await gdb.stop();
    } finally {
      await runner.stop();
    }
    expect(runner.getStatus()).toBe('stopped');
  }, 120_000);
});
