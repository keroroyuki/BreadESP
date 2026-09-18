// PRD: §F-DBG-6 — DAP adapter end-to-end against real QEMU + real GDB
// (dev-plan task P4.5 acceptance; dev-plan §11.2 gating). A VS Code-style DAP
// client launches blink.elf on a real `-machine esp32` VM, sets a function
// breakpoint on app_main, and drives the standard debug loop: breakpoint hit
// → stackTrace → registers → evaluate → step → disconnect. Skipped unless
// BREADESP_GDB_BIN points at xtensa-esp32-elf-gdb (QEMU resolves from the
// fetch-qemu manifest like the other e2e suites).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DapServer } from '../src/debugger/dap/DapServer.js';
import { QemuGdbBackend } from '../src/debugger/dap/QemuGdbBackend.js';
import { DapClient } from './helpers/dap-client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const FIXTURE_ELF = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'blink.elf');

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

describe.skipIf(QEMU_BIN === null || GDB_BIN === null)('DAP launch e2e (real QEMU + real GDB)', () => {
  it('launch → function breakpoint hit → stack/regs/evaluate → step → disconnect', async () => {
    const client = new DapClient();
    const server = new DapServer(() => new QemuGdbBackend({ attachDeadlineMs: 20000 }), {
      log: (message) => process.env.BREADESP_DAP_E2E_DEBUG === '1' ? process.stderr.write(`[dap-e2e] ${message}\n`) : undefined,
    });
    server.serve({ input: client.toServer, output: client.fromServer });

    const init = await client.request('initialize', { adapterID: 'breadesp' });
    expect(init.success).toBe(true);
    expect((init.body as Record<string, unknown>).supportsFunctionBreakpoints).toBe(true);

    // Windows cold start: QEMU spawn + GDB index load + stub bind can exceed
    // the client's 8s default; allow a generous window like the GdbBridge e2e.
    const launch = await client.request('launch', {
      elfPath: FIXTURE_ELF,
      chip: 'esp32',
      qemuBin: QEMU_BIN,
      gdbBin: GDB_BIN,
    }, 60_000);
    expect(launch.success).toBe(true);
    await client.waitEvent('initialized');

    // `target remote` onto the -S frozen VM halts it and GDB reports an
    // initial stop WITHOUT a reason — the adapter maps it to 'pause'. Consume
    // it before arming breakpoints so the next stop is the breakpoint hit.
    const attachStop = await client.nextEvent('stopped', 30000);
    expect(attachStop.body).toMatchObject({ reason: 'pause', allThreadsStopped: true });

    const bps = await client.request('setFunctionBreakpoints', { breakpoints: [{ name: 'app_main' }] });
    const bpList = bps.body as { breakpoints: Array<Record<string, unknown>> };
    expect(bpList.breakpoints[0]).toMatchObject({ verified: true });

    await client.request('configurationDone');
    const stopped = await client.nextEvent('stopped', 30000);
    expect(stopped.body).toMatchObject({ reason: 'breakpoint', allThreadsStopped: true });
    expect(stopped.body?.description).toBe('breakpoint-hit');

    const stack = await client.request('stackTrace', { threadId: 1 });
    const stackBody = stack.body as { stackFrames: Array<Record<string, unknown>> };
    expect(stackBody.stackFrames[0]).toMatchObject({ id: 0, name: 'app_main' });

    const scopes = await client.request('scopes', { frameId: 0 });
    const scopeList = scopes.body as { scopes: Array<{ name: string; variablesReference: number }> };
    const registers = scopeList.scopes.find((s) => s.name === 'Registers');
    expect(registers).toBeDefined();
    const regs = await client.request('variables', { variablesReference: registers!.variablesReference });
    const regVars = (regs.body as { variables: Array<{ name: string; value: string }> }).variables;
    expect(regVars.map((v) => v.name)).toContain('pc');
    expect(regVars.find((v) => v.name === 'pc')!.value).toMatch(/^0x[0-9a-f]+$/i);

    const evaluated = await client.request('evaluate', { expression: '$pc', frameId: 0, context: 'watch' });
    expect(evaluated.success).toBe(true);
    expect(String((evaluated.body as Record<string, unknown>).result)).toMatch(/0x[0-9a-f]+/i);

    await client.request('stepIn');
    const stepped = await client.nextEvent('stopped', 30000);
    expect(stepped.body).toMatchObject({ reason: 'step' });

    // UART output flows through as stdout output events. The app_main
    // breakpoint freezes the VM mid-boot-print (only the first FIFO bytes
    // escape, e.g. "He"), and the print never re-runs — so assert that the
    // DAP stdout channel received UART bytes, not the full banner.
    await client.request('continue');
    const deadline = Date.now() + 10_000;
    while (client.outputText('stdout').length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(client.outputText('stdout').length).toBeGreaterThan(0);

    const disconnect = await client.request('disconnect', { terminateDebuggee: true });
    expect(disconnect.success).toBe(true);
    await client.waitEvent('terminated');
  }, 120_000);
});
