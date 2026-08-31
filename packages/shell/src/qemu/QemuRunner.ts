// PRD: §4.2, §F-SIM, §F-SER-1 — QEMU-ESP32 subprocess lifecycle.
// load() arms a paused VM (`-S`) with a loopback QMP control channel; start() resumes
// execution via QMP `cont`. QEMU stdout is the UART0 stream (PRD §F-SER-1); stderr
// carries QEMU diagnostics and is re-emitted as `log` events.
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { buildQemuArgs, type QemuArgsInput } from '@breadesp/sim-core';
import type { ChipKind } from '@breadesp/netlist';
import { QmpClient } from './QmpClient.js';

export type SimStatus = 'idle' | 'loaded' | 'running' | 'paused' | 'stopped' | 'error';

export interface QemuLoadInput {
  firmwareElf: string;
  chip: ChipKind;
  qemuBin: string;
  gdbPort?: number;
  dbusSocket?: string;
  /** Fixed QMP port; an ephemeral loopback port is allocated when omitted. */
  qmpPort?: number;
  /** Test seam: full argv override for mock-subprocess integration tests (dev-plan §7.2). */
  argsBuilder?: (input: QemuArgsInput) => string[];
}

const UART_LOG_LIMIT = 1000; // retained stdout chunks (tail)
const QMP_CONNECT_DEADLINE_MS = 5000;

export class QemuRunner extends EventEmitter {
  private proc: ChildProcess | null = null;
  private status: SimStatus = 'idle';
  private readonly qmp = new QmpClient();
  private readonly uartLog: string[] = [];
  private qmpPort: number | null = null;
  private stopping = false;
  private exitWaiter: Promise<number | null> = Promise.resolve(null);

  getStatus(): SimStatus { return this.status; }

  /** QMP control port of the current/last process, if any. */
  getQmpPort(): number | null { return this.qmpPort; }

  /** UART0 output accumulated this session (oldest first, truncated to the tail). */
  getUartLog(): string { return this.uartLog.join(''); }

  /** Validate inputs and spawn QEMU frozen (`-S`); execution gates on start(). */
  async load(input: QemuLoadInput): Promise<void> {
    if (this.proc) await this.stop();
    this.stopping = false;

    if (input.argsBuilder === undefined) {
      // Pre-flight checks so failures are readable instead of async spawn noise (PRD §4.7).
      assertReadable(input.qemuBin, '[BB-100] QEMU binary not found or not executable');
      assertReadable(input.firmwareElf, '[BB-100] firmware ELF not found or not readable');
    }

    const qmpPort = input.qmpPort ?? await allocateEphemeralPort();
    const argsInput: QemuArgsInput = {
      qemuBin: input.qemuBin,
      firmwareElf: input.firmwareElf,
      chip: input.chip,
      gdbPort: input.gdbPort,
      dbusSocket: input.dbusSocket,
      qmpPort,
      noNetwork: true, // PRD §9 sandbox
    };
    const argv = input.argsBuilder !== undefined ? input.argsBuilder(argsInput) : buildQemuArgs(argsInput);
    const [bin, ...rest] = argv;

    const child = spawn(bin, rest, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = child;
    this.qmpPort = qmpPort;
    this.uartLog.length = 0;

    this.exitWaiter = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        this.qmp.close();
        this.proc = null;
        // Deliberate stop or clean quit => stopped; crash => error (PRD F-SIM-4).
        this.setStatus(this.stopping || code === 0 ? 'stopped' : 'error');
        resolve(code);
      });
    });
    child.once('error', (err) => {
      this.qmp.close();
      this.proc = null;
      this.setStatus('error');
      // EventEmitter throws on unlistened 'error'; keep the process alive (PRD §4.7).
      // ipc/handlers.ts subscribes and forwards to the 'sim:error' IPC channel (P1.1).
      if (this.listenerCount('error') > 0) this.emit('error', err);
      else this.emit('log', `[qemu] ${err.message}`);
    });

    const uartDecoder = new StringDecoder('utf8');
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = uartDecoder.write(chunk);
      this.pushUart(text);
      this.emit('uart', text);
    });
    const logDecoder = new StringDecoder('utf8');
    child.stderr?.on('data', (chunk: Buffer) => this.emit('log', logDecoder.write(chunk)));

    this.setStatus('loaded');
  }

  /** Resume the frozen VM. Idempotent while already running. */
  async start(): Promise<void> {
    if (!this.proc) throw new Error('[BB-102] QEMU is not loaded; call load() first');
    if (this.status === 'running') return;
    await this.connectQmp();
    await this.qmp.cont();
    this.setStatus('running');
  }

  /** Pause the virtual CPU via QMP `stop`. */
  async pause(): Promise<void> {
    if (!this.proc || this.status !== 'running') throw new Error('[BB-103] QEMU is not running');
    await this.qmp.stop();
    this.setStatus('paused');
  }

  /** Instruction-level single step needs the GDB bridge. */
  async step(): Promise<void> {
    // TODO(PRD §F-SIM-1): route through GdbBridge `-exec-step-instruction` when
    // the debug panel wires the IPC layer (dev-plan task 1.9); GdbBridge.step()
    // provides the MI command since P0.5.
    throw new Error('[BB-105] single-step requires the GDB bridge (dev-plan task 1.9)');
  }

  /** Stop the VM (reset back to idle). */
  async reset(): Promise<void> {
    await this.stop();
    this.setStatus('idle');
  }

  /** Terminate QEMU: prefer a clean QMP `quit`, then hard-kill as fallback. */
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) {
      this.qmp.close();
      if (this.status !== 'idle') this.setStatus('stopped');
      return;
    }
    this.stopping = true;
    try {
      if (this.qmpPort !== null) {
        await this.qmp.connect({ port: this.qmpPort, timeoutMs: 1000 });
        await this.qmp.quit();
      }
    } catch {
      // QMP unavailable (e.g. QEMU wedged) — fall through to the hard kill.
    }
    await Promise.race([this.exitWaiter, delay(1000)]);
    if (this.proc === proc) proc.kill();
    await this.exitWaiter;
    this.qmp.close();
  }

  /** Inject keyboard input into UART0 stdin (PRD §F-SER-2). */
  writeStdin(s: string): void {
    if (!this.proc) throw new Error('[BB-102] QEMU is not loaded; call load() first');
    this.proc.stdin?.write(s);
  }

  private async connectQmp(): Promise<void> {
    if (this.qmpPort === null) throw new Error('[BB-104] QMP port unknown');
    const deadline = Date.now() + QMP_CONNECT_DEADLINE_MS;
    for (;;) {
      try {
        await this.qmp.connect({ port: this.qmpPort, timeoutMs: 1000 });
        return;
      } catch (err) {
        if (Date.now() >= deadline) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(`[BB-104] cannot reach QEMU QMP on 127.0.0.1:${this.qmpPort}: ${reason}`);
        }
        await delay(100); // QEMU binds the chardev early in boot; retry briefly.
      }
    }
  }

  private pushUart(text: string): void {
    this.uartLog.push(text);
    if (this.uartLog.length > UART_LOG_LIMIT) this.uartLog.shift();
  }

  private setStatus(s: SimStatus): void {
    this.status = s;
    this.emit('status', s);
  }
}

function assertReadable(path: string, message: string): void {
  try {
    accessSync(path, constants.R_OK);
  } catch {
    throw new Error(`${message}: ${path}`);
  }
}

/** Reserve an ephemeral loopback port, then release it for QEMU to bind. */
function allocateEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('[BB-104] failed to allocate an ephemeral QMP port'));
        return;
      }
      server.close(() => resolve(addr.port));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
