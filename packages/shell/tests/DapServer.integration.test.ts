// PRD: §F-DBG-6 — DapServer integration tests against the mock GDB/MI and mock
// QEMU subprocesses (dev-plan §7.2). Drives full DAP sessions over in-memory
// transports exactly as a VS Code client would: initialize → launch/attach →
// setBreakpoints/setFunctionBreakpoints → configurationDone → threads/stack/
// scopes/variables/evaluate → continue/step/pause → disconnect. Wire-level
// assertions ride the backend's `output` event channel (the mock echoes every
// MI command to stderr, which GdbBridge re-emits as log events).
import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DapFrameDecoder } from '../src/debugger/dap/DapProtocol.js';
import { DapServer } from '../src/debugger/dap/DapServer.js';
import { QemuGdbBackend } from '../src/debugger/dap/QemuGdbBackend.js';
import { resolveDynconfigEnv } from '../src/debugger/XtensaDynconfig.js';
import { DapClient, type DapMessage } from './helpers/dap-client.js';

const MOCK_GDB = join(import.meta.dirname, 'mock-gdb.mjs');
const MOCK_QEMU = join(import.meta.dirname, 'mock-qemu.mjs');
const NODE = process.execPath;

function makeServer(gdbScenario = 'ok'): { server: DapServer; client: DapClient } {
  const client = new DapClient();
  openClients.push(client);
  const server = new DapServer(
    () => new QemuGdbBackend({
      gdbArgsBuilder: (opts) => [NODE, MOCK_GDB, '--scenario', gdbScenario, opts.elfPath],
      qemuArgsBuilder: (input) => [
        NODE, MOCK_QEMU,
        '-kernel', input.firmwareElf,
        '-qmp', `tcp:127.0.0.1:${input.qmpPort ?? 0},server=on,wait=off`,
      ],
      attachDeadlineMs: 4000,
    }),
  );
  server.serve({ input: client.toServer, output: client.fromServer });
  return { server, client };
}

/** Sessions that never disconnected: ending the transport tears the backend down. */
const openClients: DapClient[] = [];

/** initialize + attach over the mock GDB; returns the client ready to drive. */
async function startAttachSession(gdbScenario = 'ok'): Promise<{ server: DapServer; client: DapClient }> {
  const { server, client } = makeServer(gdbScenario);
  const init = await client.request('initialize', { adapterID: 'breadesp' });
  expect(init.success).toBe(true);
  expect((init.body as Record<string, unknown>).supportsConfigurationDoneRequest).toBe(true);
  await client.request('attach', { port: 1234, elfPath: 'mock://blink.elf' });
  await client.waitEvent('initialized');
  return { server, client };
}

const outputText = (client: DapClient, category?: string): string => client.outputText(category);

describe('DapServer (mock GDB subprocess)', () => {
  afterEach(async () => {
    const closing = openClients.splice(0);
    if (closing.length === 0) return;
    for (const client of closing) client.toServer.end();
    // Give the backend's disconnect-on-transport-end a beat to kill mock children.
    await new Promise((r) => setTimeout(r, 100));
  });

  it('completes the full VS Code attach flow: breakpoints, stack, scopes, evaluate', async () => {
    const { client } = await startAttachSession();

    // Function breakpoints (VS Code "Function Breakpoints" pane).
    const fnBps = await client.request('setFunctionBreakpoints', { breakpoints: [{ name: 'app_main' }] });
    expect(fnBps.success).toBe(true);
    expect((fnBps.body as { breakpoints: Array<Record<string, unknown>> }).breakpoints[0]).toMatchObject({ verified: true });

    await client.request('setExceptionBreakpoints', { filters: [] });
    const cfg = await client.request('configurationDone');
    expect(cfg.success).toBe(true);

    const threads = await client.request('threads');
    expect((threads.body as { threads: Array<Record<string, unknown>> }).threads).toEqual([{ id: 1, name: 'ESP32' }]);

    const stack = await client.request('stackTrace', { threadId: 1 });
    const stackBody = stack.body as { stackFrames: Array<Record<string, unknown>>; totalFrames: number };
    expect(stackBody.totalFrames).toBe(2);
    expect(stackBody.stackFrames[0]).toMatchObject({ id: 0, name: 'app_main', line: 10 });
    expect(stackBody.stackFrames[1].name).toBe('call_start_cpu0');

    const scopes = await client.request('scopes', { frameId: 0 });
    const scopeList = scopes.body as { scopes: Array<Record<string, unknown>> };
    expect(scopeList.scopes.map((s) => s.name)).toEqual(['Locals', 'Registers']);
    const localsRef = scopeList.scopes[0].variablesReference as number;
    const regsRef = scopeList.scopes[1].variablesReference as number;
    expect(localsRef).not.toBe(regsRef);

    // led_state has no simple value in GDB's output; the backend must resolve
    // it through -data-evaluate-expression instead of emitting junk.
    const locals = await client.request('variables', { variablesReference: localsRef });
    const localVars = locals.body as { variables: Array<Record<string, unknown>> };
    expect(localVars.variables).toEqual([
      { name: 'msg_cursor', value: '165', variablesReference: 0 },
      { name: 'remaining', value: '13', variablesReference: 0 },
      { name: 'led_state', value: '165', variablesReference: 0 },
    ]);

    const regs = await client.request('variables', { variablesReference: regsRef });
    const regVars = regs.body as { variables: Array<Record<string, unknown>> };
    expect(regVars.variables).toContainEqual({ name: 'pc', value: '0x40080024', variablesReference: 0 });

    const evalRes = await client.request('evaluate', { expression: 'remaining', frameId: 0, context: 'watch' });
    expect((evalRes.body as Record<string, unknown>).result).toBe('13');

    // configurationDone auto-resumed the target (stopOnEntry defaults false):
    // mock-gdb reports the breakpoint hit as a *stopped record.
    const stopped = await client.nextEvent('stopped');
    expect(stopped.body).toMatchObject({ reason: 'breakpoint', threadId: 1, allThreadsStopped: true, hitBreakpointIds: [1] });
    await client.waitEvent('continued');
  }, 15000);

  it('pause, stepOut and evaluate surface as DAP events/responses', async () => {
    const { client } = await startAttachSession();
    await client.request('configurationDone');
    await client.nextEvent('stopped'); // breakpoint hit

    await client.request('pause');
    const paused = await client.nextEvent('stopped');
    expect(paused.body).toMatchObject({ reason: 'pause' });
    expect((paused.body as Record<string, unknown>).text).toBe('signal-received');

    await client.request('stepOut');
    const finished = await client.nextEvent('stopped');
    expect(finished.body).toMatchObject({ reason: 'step' });

    const stepIn = await client.request('stepIn');
    expect(stepIn.success).toBe(true);
  }, 15000);

  it('re-setBreakpoints deletes the previous set and inserts the new lines', async () => {
    const { client } = await startAttachSession();
    const first = await client.request('setBreakpoints', {
      source: { path: 'blink.S' },
      breakpoints: [{ line: 10, condition: 'led_state > 0' }, { line: 20 }],
    });
    const firstBps = first.body as { breakpoints: Array<Record<string, unknown>> };
    expect(firstBps.breakpoints.map((b) => b.verified)).toEqual([true, true]);

    const second = await client.request('setBreakpoints', {
      source: { path: 'blink.S' },
      breakpoints: [{ line: 11 }],
    });
    const secondBps = second.body as { breakpoints: Array<Record<string, unknown>> };
    expect(secondBps.breakpoints).toHaveLength(1);
    expect(secondBps.breakpoints[0].verified).toBe(true);

    // Wire-level: the mock echoes MI commands to stderr → 'log' output events.
    // quoteMiArg only quotes when MI requires it (whitespace/quotes): the
    // condition is quoted, the bare file:line location is not.
    const logs = outputText(client, 'log');
    expect(logs).toContain('-break-insert -c "led_state > 0" blink.S:10');
    expect(logs).toContain('-break-insert blink.S:20');
    expect(logs).toContain('-break-delete 1 2');
    expect(logs).toContain('-break-insert blink.S:11');
  }, 15000);

  it('reports unverified breakpoints instead of failing the request on GDB errors', async () => {
    const { client } = await startAttachSession('error'); // -break-insert replies ^error
    const res = await client.request('setBreakpoints', {
      source: { path: 'blink.S' },
      breakpoints: [{ line: 10 }],
    });
    const bps = res.body as { breakpoints: Array<Record<string, unknown>> };
    expect(bps.breakpoints[0]).toMatchObject({ verified: false });
    expect(String(bps.breakpoints[0].message)).toMatch(/\[BB-113\]/);
  }, 15000);

  it('maps protocol misuse and backend errors to readable DAP error responses', async () => {
    const { client } = makeServer();

    const beforeInit = await client.request('threads');
    expect(beforeInit.success).toBe(false);
    expect(beforeInit.message).toMatch(/not initialized/);

    const preInitLaunch = await client.request('launch', { port: 1234 });
    expect(preInitLaunch.success).toBe(false);
    expect(preInitLaunch.message).toMatch(/not initialized/);

    await client.request('initialize', { adapterID: 'breadesp' });
    const badLaunch = await client.request('launch', { elfPath: 'mock://blink.elf', port: 1234 });
    expect(badLaunch.success).toBe(false);
    expect(badLaunch.message).toMatch(/\[BB-132\].*port/);
    const again = await client.request('initialize', { adapterID: 'breadesp' });
    expect(again.success).toBe(false);
    expect(again.message).toMatch(/already initialized/);

    const noElf = await client.request('launch', {});
    expect(noElf.success).toBe(false);
    expect(noElf.message).toMatch(/\[BB-132\].*elfPath/);

    const badPort = await client.request('attach', { port: 'x', elfPath: 'mock://blink.elf' });
    expect(badPort.success).toBe(false);
    expect(badPort.message).toMatch(/\[BB-132\].*port/);

    await client.request('attach', { port: 1234, elfPath: 'mock://blink.elf' });
    await client.waitEvent('initialized');
    const twice = await client.request('launch', { elfPath: 'mock://blink.elf' });
    expect(twice.success).toBe(false);
    expect(twice.message).toMatch(/already started/);

    const unknown = await client.request('restart');
    expect(unknown.success).toBe(false);
    expect(unknown.message).toMatch(/unknown command 'restart'/);

    const noRef = await client.request('variables', { variablesReference: 424242 });
    expect(noRef.success).toBe(false);
    expect(noRef.message).toMatch(/unknown variablesReference/);
  }, 15000);

  it('stopOnEntry=true defers the resume and reports the entry stop', async () => {
    const client = new DapClient();
    openClients.push(client);
    const server = new DapServer(() => new QemuGdbBackend({
      gdbArgsBuilder: (opts) => [NODE, MOCK_GDB, '--scenario', 'ok', opts.elfPath],
      attachDeadlineMs: 4000,
    }));
    server.serve({ input: client.toServer, output: client.fromServer });
    await client.request('initialize', { adapterID: 'breadesp' });
    await client.request('attach', { port: 1234, elfPath: 'mock://blink.elf', stopOnEntry: true });
    await client.waitEvent('initialized');
    await client.request('configurationDone');
    const entry = await client.waitEvent('stopped');
    expect(entry.body).toMatchObject({ reason: 'entry' });
    // No auto-continue happened: no breakpoint-hit stop can follow.
    await new Promise((r) => setTimeout(r, 150));
    expect(client.eventsNamed('stopped')).toHaveLength(1);
  }, 15000);

  it('runs the launch flow against mock QEMU and tears the VM down on disconnect', async () => {
    const { client } = makeServer();
    await client.request('initialize', { adapterID: 'breadesp' });
    const launch = await client.request('launch', { elfPath: 'mock://blink.elf', chip: 'esp32' });
    expect(launch.success).toBe(true);
    await client.waitEvent('initialized');
    await client.request('setFunctionBreakpoints', { breakpoints: [{ name: 'app_main' }] });
    await client.request('configurationDone');
    await client.nextEvent('stopped');

    // QEMU stderr (spawn banner) flows through as stderr output events.
    expect(outputText(client, 'stderr')).toContain('mock-qemu');

    const disconnect = await client.request('disconnect', { terminateDebuggee: true });
    expect(disconnect.success).toBe(true);
    await client.waitEvent('terminated');
  }, 15000);

  it('survives a malformed frame and terminates the session', async () => {
    const { client } = makeServer();
    client.writeRaw(Buffer.from('garbage without a header\r\n\r\n'));
    await client.waitEvent('terminated');
  }, 15000);
});

describe('resolveDynconfigEnv (esp-gdb Xtensa register layout selection)', () => {
  it('finds xtensa_<chip>.so next to the GDB binary for Xtensa chips', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'breadesp-dap-'));
    await mkdir(join(tmp, 'bin'), { recursive: true });
    await mkdir(join(tmp, 'lib'), { recursive: true });
    const gdbBin = join(tmp, 'bin', 'gdb.exe');
    await writeFile(gdbBin, '#!/bin/sh\n');
    for (const so of ['xtensa_esp32.so', 'xtensa_esp32s3.so', 'xtensa_esp8266.so']) {
      await writeFile(join(tmp, 'lib', so), '');
    }

    expect(resolveDynconfigEnv(gdbBin, 'esp32')).toEqual({ XTENSA_GNU_CONFIG: join(tmp, 'lib', 'xtensa_esp32.so') });
    expect(resolveDynconfigEnv(gdbBin, 'esp32s3')).toEqual({ XTENSA_GNU_CONFIG: join(tmp, 'lib', 'xtensa_esp32s3.so') });
    // RISC-V chips need no Xtensa layout; absent libraries change nothing.
    expect(resolveDynconfigEnv(gdbBin, 'esp32c3')).toBeUndefined();
    expect(resolveDynconfigEnv(gdbBin, 'esp32c6')).toBeUndefined();
    await rm(tmp, { recursive: true, force: true });
  }, 10000);

  it('returns undefined when the library is missing or the binary is unknown', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'breadesp-dap-'));
    const gdbBin = join(tmp, 'gdb-missing-dir', 'gdb.exe');
    expect(resolveDynconfigEnv(gdbBin, 'esp32')).toBeUndefined();
    expect(resolveDynconfigEnv('', 'esp32')).toBeUndefined();
    await rm(tmp, { recursive: true, force: true });
  }, 10000);

  it('leaves a user-set XTENSA_GNU_CONFIG untouched', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'breadesp-dap-'));
    await mkdir(join(tmp, 'bin'), { recursive: true });
    await mkdir(join(tmp, 'lib'), { recursive: true });
    const gdbBin = join(tmp, 'bin', 'gdb.exe');
    await writeFile(gdbBin, '#!/bin/sh\n');
    await writeFile(join(tmp, 'lib', 'xtensa_esp32.so'), '');
    process.env.XTENSA_GNU_CONFIG = 'user-choice.so';
    try {
      expect(resolveDynconfigEnv(gdbBin, 'esp32')).toBeUndefined();
    } finally {
      delete process.env.XTENSA_GNU_CONFIG;
    }
    await rm(tmp, { recursive: true, force: true });
  }, 10000);
});

describe('DapServer socket mode', () => {
  it('serves a full session over TCP (the VS Code debugServer path)', async () => {
    // Reserve an ephemeral port, then hand it to the server.
    const port = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address();
        if (addr === null || typeof addr === 'string') {
          reject(new Error('failed to allocate an ephemeral port'));
          return;
        }
        probe.close(() => resolve(addr.port));
      });
    });

    const server = new DapServer(() => new QemuGdbBackend({
      gdbArgsBuilder: (opts) => [NODE, MOCK_GDB, '--scenario', 'ok', opts.elfPath],
      attachDeadlineMs: 4000,
    }));
    const tcp = await server.listen(port);

    const socket = net.connect(port, '127.0.0.1');
    const decoder = new DapFrameDecoder();
    const messages: DapMessage[] = [];
    socket.on('data', (chunk: Buffer) => messages.push(...(decoder.push(chunk) as DapMessage[])));

    const send = (frame: object): void => {
      socket.write(Buffer.concat([
        Buffer.from(`Content-Length: ${Buffer.byteLength(JSON.stringify(frame))}\r\n\r\n`, 'ascii'),
        Buffer.from(JSON.stringify(frame), 'utf8'),
      ]));
    };
    const waitResponse = async (seq: number): Promise<DapMessage> => {
      for (let i = 0; i < 100; i++) {
        const hit = messages.find((m) => m.type === 'response' && m.request_seq === seq);
        if (hit !== undefined) return hit;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`no response for seq ${seq}`);
    };

    send({ seq: 1, type: 'request', command: 'initialize', arguments: { adapterID: 'breadesp' } });
    const init = await waitResponse(1);
    expect(init.success).toBe(true);
    send({ seq: 2, type: 'request', command: 'attach', arguments: { port: 1234, elfPath: 'mock://blink.elf' } });
    const attach = await waitResponse(2);
    expect(attach.success).toBe(true);

    socket.end();
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
  }, 15000);
});
