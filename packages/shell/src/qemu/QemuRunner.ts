// PRD: §4.2, §F-SIM, §F-SER-1 — QEMU-ESP32 subprocess lifecycle.
// load() arms a paused VM (`-S`) with a loopback QMP control channel; start() resumes
// execution via QMP `cont`. QEMU stdout is the UART0 stream (PRD §F-SER-1); stderr
// carries QEMU diagnostics and is re-emitted as `log` events.
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { buildQemuArgs, type QemuArgsInput, type QemuDbusChannel } from '@breadesp/sim-core';
import type { ChipKind } from '@breadesp/netlist';
import { QmpClient } from './QmpClient.js';

export type SimStatus = 'idle' | 'loaded' | 'running' | 'paused' | 'stopped' | 'error';

/** PRD §F-SIM-2 — accepted simulation speed multiplier range. */
export const MIN_SPEED = 0.1;
export const MAX_SPEED = 10;

export interface QemuRunnerOptions {
  /**
   * Test seam: throttle duty-cycle quantum in ms (default 200). Each quantum
   * the VM runs `speed × quantum` and is halted for the remainder.
   */
  throttleQuantumMs?: number;
}

export interface QemuLoadInput {
  firmwareElf: string;
  chip: ChipKind;
  qemuBin: string;
  gdbPort?: number;
  /**
   * DBus forward channel (PRD §6.7): unix socket path or TCP host/port. TCP is
   * the portable choice — Node cannot serve AF_UNIX on Windows hosts.
   */
  dbus?: QemuDbusChannel;
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
  private gdbPort: number | null = null;
  private firmwareElf: string | null = null;
  private chip: ChipKind | null = null;
  private stopping = false;
  private exitWaiter: Promise<number | null> = Promise.resolve(null);
  /** PRD §F-SIM-2 — logical-clock throttle multiplier (see setSpeed). */
  private speed = 1;
  private readonly throttleQuantumMs: number;
  private throttleTimer: NodeJS.Timeout | null = null;
  /** Generation guard retiring in-flight throttle phases on rearm/clear. */
  private throttleGen = 0;
  /** True while the VM sits in a throttle halt window (QMP `stop` sent). */
  private throttleHalted = false;

  constructor(opts: QemuRunnerOptions = {}) {
    super();
    this.throttleQuantumMs = opts.throttleQuantumMs ?? 200;
  }

  getStatus(): SimStatus { return this.status; }

  /** Current speed multiplier (PRD §F-SIM-2). 1 = wall clock. */
  getSpeed(): number { return this.speed; }

  /**
   * Set the simulation speed multiplier (PRD §F-SIM-2, dev-plan task P2.6).
   * QMP offers no CPU clock control, so factors below 1 throttle the logical
   * clock by duty-cycling the vCPU: every quantum the VM runs
   * `speed × quantum` and is halted (QMP `stop`) for the rest, which freezes
   * QEMU's virtual clock and therefore every dbus timestamp. Factors above 1
   * are accepted but saturate at wall-clock speed — QEMU cannot execute the
   * guest faster than the host. Emits 'speed' with the applied factor.
   */
  setSpeed(factor: number): void {
    if (typeof factor !== 'number' || !Number.isFinite(factor)
        || factor < MIN_SPEED || factor > MAX_SPEED) {
      throw new Error(
        `[BB-116] speed factor must be a finite number in [${MIN_SPEED}, ${MAX_SPEED}], got ${String(factor)}`,
      );
    }
    this.speed = factor;
    this.emit('speed', factor);
    this.rearmThrottle();
  }

  /** QMP control port of the current/last process, if any. */
  getQmpPort(): number | null { return this.qmpPort; }

  /**
   * GDB stub port of the current/last process (dev-plan task P1.9). Always
   * allocated by load(): the debug panel attaches at any time via dbg:connect
   * without the renderer having to reserve a port itself.
   */
  getGdbPort(): number | null { return this.gdbPort; }

  /** Firmware ELF path of the current/last load (dbg:connect passes it to GDB). */
  getFirmwareElf(): string | null { return this.firmwareElf; }

  /**
   * Chip of the current/last load (P4.5): dbg:connect / DAP attach pass it to
   * GDB for the Xtensa dynconfig selection (esp-gdb register layout).
   */
  getChip(): ChipKind | null { return this.chip; }

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
    // GDB stub is always on (P1.9): the debug panel connects lazily via dbg:connect.
    const gdbPort = input.gdbPort ?? await allocateEphemeralPort();
    const argsInput: QemuArgsInput = {
      qemuBin: input.qemuBin,
      firmwareElf: input.firmwareElf,
      chip: input.chip,
      gdbPort,
      dbus: input.dbus,
      qmpPort,
      noNetwork: true, // PRD §9 sandbox
    };
    const argv = input.argsBuilder !== undefined ? input.argsBuilder(argsInput) : buildQemuArgs(argsInput);
    const [bin, ...rest] = argv;

    const child = spawn(bin, rest, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = child;
    this.qmpPort = qmpPort;
    this.gdbPort = gdbPort;
    this.firmwareElf = input.firmwareElf;
    this.chip = input.chip;
    this.uartLog.length = 0;

    this.exitWaiter = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        this.qmp.close();
        this.clearThrottle();
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
    this.rearmThrottle(); // speed < 1 resumes under the duty cycle (P2.6)
  }

  /** Pause the virtual CPU via QMP `stop`. */
  async pause(): Promise<void> {
    if (!this.proc || this.status !== 'running') throw new Error('[BB-103] QEMU is not running');
    this.clearThrottle(); // a user pause supersedes any throttle halt window
    this.throttleHalted = false;
    await this.qmp.stop();
    this.setStatus('paused');
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
    this.clearThrottle();
    this.throttleHalted = false;
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

  /**
   * (Re)arm the duty-cycle throttle for the current speed/status. A no-op
   * unless the VM is running below 1x. When the VM currently sits in a halt
   * window the next phase is scheduled from where the cycle left off, and a
   * speed restored to >= 1 resumes the halted VM immediately.
   */
  private rearmThrottle(): void {
    this.clearThrottle();
    if (this.status !== 'running') return;
    if (this.speed >= 1) {
      if (this.throttleHalted) {
        this.throttleHalted = false;
        void this.throttleQmp('cont');
      }
      return;
    }
    const gen = this.throttleGen;
    if (this.throttleHalted) {
      this.throttleTimer = setTimeout(() => { void this.throttleRunPhase(gen); },
        (1 - this.speed) * this.throttleQuantumMs);
    } else {
      this.throttleTimer = setTimeout(() => { void this.throttleHaltPhase(gen); },
        this.speed * this.throttleQuantumMs);
    }
  }

  private clearThrottle(): void {
    // Bumping the generation retires any in-flight phase: a stale phase that
    // already sent QMP `stop` undoes it with `cont` instead of scheduling on.
    this.throttleGen++;
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
  }

  /** End of a run window: halt the vCPU and schedule the next run window. */
  private async throttleHaltPhase(gen: number): Promise<void> {
    if (gen !== this.throttleGen || this.status !== 'running' || this.speed >= 1) return;
    if (!await this.throttleQmp('stop')) return;
    if (gen !== this.throttleGen || this.status !== 'running' || this.speed >= 1) {
      // Retired mid-flight (setSpeed/pause raced us): the VM must not stay
      // halted unless a user pause owns it — undo the stop and bow out.
      if (this.status === 'running') void this.throttleQmp('cont');
      return;
    }
    this.throttleHalted = true;
    this.throttleTimer = setTimeout(() => { void this.throttleRunPhase(gen); },
      (1 - this.speed) * this.throttleQuantumMs);
  }

  /** End of a halt window: resume the vCPU and schedule the next halt. */
  private async throttleRunPhase(gen: number): Promise<void> {
    if (gen !== this.throttleGen || this.status !== 'running' || this.speed >= 1) return;
    this.throttleHalted = false;
    if (!await this.throttleQmp('cont')) return;
    if (gen !== this.throttleGen || this.status !== 'running' || this.speed >= 1) return;
    this.throttleTimer = setTimeout(() => { void this.throttleHaltPhase(gen); },
      this.speed * this.throttleQuantumMs);
  }

  /**
   * Throttle QMP call with failure containment: a wedged control channel
   * logs once and disarms the cycle instead of throwing from a timer.
   */
  private async throttleQmp(command: 'stop' | 'cont'): Promise<boolean> {
    try {
      if (command === 'stop') await this.qmp.stop();
      else await this.qmp.cont();
      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.emit('log', `[qemu] speed throttle ${command} failed: ${reason}`);
      return false;
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
