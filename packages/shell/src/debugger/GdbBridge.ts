// PRD: §F-DBG-5, §F-DBG-1 — GDB bridge over GDB/MI (dev-plan task P0.5).
// Spawns xtensa-esp32-elf-gdb with `--interpreter=mi2`, attaches to QEMU's
// gdb stub via `-target-select remote`, and exposes breakpoint insert/delete
// plus continue/step as tokenized MI commands. Asynchronous CPU stops
// (breakpoint hits, single steps) surface as `stopped` events.
//
// Events: 'stopped' (StoppedInfo), 'running', 'console'/'target' (MI stream
// records), 'log' (GDB log stream + stderr), 'notify' (MI `=` records),
// 'exit' (process exit code).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { EventEmitter } from 'node:events';
import { parseMiLine, type MiRecord, type MiTuple, type MiValue } from './MiParser.js';

export interface BreakpointInfo { id: number; address: string; enabled: boolean; }

export interface FrameInfo {
  addr: string;
  func?: string;
  file?: string;
  line?: string;
}

/** Payload of the MI `*stopped` async record (PRD §F-DBG-2). */
export interface StoppedInfo {
  /** 'breakpoint-hit' | 'end-stepping-range' | ... — null when GDB omits it. */
  reason: string | null;
  breakpointNumber?: string;
  frame: FrameInfo | null;
  threadId: string | null;
  stoppedThreads: string[];
}

export interface GdbStartOptions {
  gdbBin: string;
  elfPath: string;
  targetHost: string;
  port: number;
  /** Per-command deadline in ms (default 10s). */
  commandTimeoutMs?: number;
  /** Test seam: full argv override (element 0 = executable) for mock-subprocess integration tests (dev-plan §7.2). */
  argsBuilder?: (opts: GdbStartOptions) => string[];
}

interface PendingCommand {
  cmd: string;
  resolve: (rec: MiRecord) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PromptWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 1500;

export class GdbBridge extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private token = 0;
  private pending = new Map<string, PendingCommand>();
  private promptWaiters: PromptWaiter[] = [];
  private lineBuf = '';
  private commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;
  private exited = false;

  /**
   * Spawn GDB in MI mode and attach to the QEMU gdb stub.
   * Resolves once the MI prompt appeared and `^connected` came back.
   */
  async start(opts: GdbStartOptions): Promise<void> {
    if (this.proc) await this.stop();
    if (opts.argsBuilder === undefined) {
      assertReadable(opts.gdbBin, '[BB-110] GDB binary not found or not executable');
    }
    this.commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.exited = false;
    this.lineBuf = '';

    // Full-argv seam mirroring QemuRunner.load: element 0 is the executable.
    // --nx: ignore user .gdbinit; --quiet: no banner; mi2 is the stable dialect.
    const argv = opts.argsBuilder !== undefined
      ? opts.argsBuilder(opts)
      : [opts.gdbBin, '--nx', '--interpreter=mi2', '--quiet', opts.elfPath];
    const [bin, ...rest] = argv;
    const child = spawn(bin, rest, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = child;

    child.on('error', (err) => this.onProcessGone(new Error(`[BB-111] GDB process error: ${err.message}`), -1));
    child.stdout.on('data', (chunk: Buffer) => this.feedOutput(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => this.emit('log', chunk.toString('utf8')));
    child.once('exit', (code) => {
      this.onProcessGone(
        new Error(`[BB-111] GDB exited before the command completed (exit code ${code ?? 'signal'})`),
        code ?? -1,
      );
    });

    await this.waitForPrompt();
    await this.send(`-target-select remote ${opts.targetHost}:${opts.port}`);
  }

  /** Insert a breakpoint at a symbol, `file:line` or `*ADDR` location (PRD §F-DBG-1). */
  async setBreakpoint(at: string): Promise<BreakpointInfo> {
    const location = /\s/.test(at) ? `"${at.replace(/"/g, '\\"')}"` : at;
    const rec = await this.send(`-break-insert ${location}`);
    const bkpt = asRecord(rec.payload?.bkpt);
    const id = Number(bkpt.number);
    if (!Number.isFinite(id)) {
      throw new Error(`[BB-113] -break-insert returned no breakpoint number: ${JSON.stringify(rec.payload ?? {})}`);
    }
    return {
      id,
      address: miString(bkpt.addr),
      enabled: miString(bkpt.enabled) !== 'n',
    };
  }

  /** Delete one breakpoint by its GDB number (PRD §F-DBG-1). */
  async removeBreakpoint(id: number): Promise<void> {
    await this.send(`-break-delete ${id}`);
  }

  /** Resume the target; resolves on `^running` — the stop arrives as a `stopped` event. */
  async continue(): Promise<void> {
    await this.send('-exec-continue');
  }

  /** One machine-instruction step; the stop arrives as a `stopped` event (PRD §F-SIM-1). */
  async step(): Promise<void> {
    await this.send('-exec-step-instruction');
  }

  /** Graceful shutdown: `-gdb-exit`, hard kill after a grace period. Idempotent. */
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc || this.exited) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => proc.kill(), STOP_GRACE_MS);
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
      try {
        // Raw write: the ^exit result has no payload we need, and the pending
        // map is torn down by the exit handler anyway.
        proc.stdin.write('0-gdb-exit\n');
      } catch {
        // stdin already closed; the exit event settles the wait.
      }
    });
  }

  /** Request vars/regs (TODO: implement MI commands). */
  async vars(): Promise<Record<string, unknown>> { /* TODO(PRD §F-DBG-3) */ return {}; }
  async regs(): Promise<Record<string, unknown>> { /* TODO(PRD §F-DBG-3) */ return {}; }

  /** Send one tokenized MI command; resolves/rejects with its result record. */
  private send(cmd: string): Promise<MiRecord> {
    const proc = this.proc;
    if (!proc || this.exited) {
      return Promise.reject(new Error('[BB-114] GDB is not running; call start() first'));
    }
    const token = String(++this.token);
    return new Promise<MiRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(token);
        reject(new Error(`[BB-112] GDB command timed out after ${this.commandTimeoutMs}ms: ${cmd}`));
      }, this.commandTimeoutMs);
      this.pending.set(token, { cmd, resolve, reject, timer });
      proc.stdin.write(`${token}${cmd}\n`, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(token);
          reject(new Error(`[BB-111] failed to write to GDB stdin: ${err.message}`));
        }
      });
    });
  }

  private feedOutput(text: string): void {
    this.lineBuf += text;
    let nl: number;
    while ((nl = this.lineBuf.indexOf('\n')) >= 0) {
      const line = this.lineBuf.slice(0, nl).trimEnd();
      this.lineBuf = this.lineBuf.slice(nl + 1);
      if (line === '(gdb)') {
        this.resolvePrompts();
        continue;
      }
      const rec = parseMiLine(line);
      if (rec) this.dispatch(rec);
    }
  }

  private dispatch(rec: MiRecord): void {
    if (rec.type === 'result') {
      const token = rec.token;
      const waiter = token !== undefined ? this.pending.get(token) : undefined;
      if (token === undefined || waiter === undefined) return; // unmatched result (e.g. ^exit) — ignore
      this.pending.delete(token);
      clearTimeout(waiter.timer);
      if (rec.klass === 'error') {
        waiter.reject(new Error(`[BB-113] GDB error for '${waiter.cmd}': ${miString(rec.payload?.msg)}`));
        return;
      }
      waiter.resolve(rec);
      return;
    }
    if (rec.type === 'async') {
      if (rec.asyncKind === 'exec' && rec.klass === 'stopped') {
        this.emit('stopped', toStoppedInfo(rec.payload));
      } else if (rec.asyncKind === 'exec' && rec.klass === 'running') {
        this.emit('running');
      } else {
        this.emit('notify', rec.klass, rec.payload ?? {});
      }
      return;
    }
    if (rec.type === 'console') this.emit('console', miString(rec.payload?.text));
    else if (rec.type === 'target') this.emit('target', miString(rec.payload?.text));
    else this.emit('log', miString(rec.payload?.text));
  }

  private waitForPrompt(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.promptWaiters = this.promptWaiters.filter((w) => w.timer !== timer);
        reject(new Error(`[BB-112] GDB did not reach its MI prompt within ${START_TIMEOUT_MS}ms`));
      }, START_TIMEOUT_MS);
      this.promptWaiters.push({ resolve, reject, timer });
    });
  }

  private resolvePrompts(): void {
    const waiters = this.promptWaiters;
    this.promptWaiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }

  private onProcessGone(err: Error, code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.proc = null;
    for (const [token, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
      this.pending.delete(token);
    }
    const waiters = this.promptWaiters;
    this.promptWaiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.emit('exit', code);
  }
}

function assertReadable(path: string, message: string): void {
  try {
    accessSync(path, constants.R_OK);
  } catch {
    throw new Error(`${message}: ${path}`);
  }
}

/** Narrow an MI value to a tuple, tolerating absent/malformed payloads. */
function asRecord(v: MiValue | undefined): MiTuple {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as MiTuple : {};
}

function miString(v: MiValue | undefined): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function miStringOpt(v: MiValue | undefined): string | undefined {
  return v === undefined ? undefined : miString(v);
}

function toStoppedInfo(payload: MiTuple | undefined): StoppedInfo {
  const p = payload ?? {};
  const frameRec = asRecord(p.frame);
  const rawThreads = p['stopped-threads'];
  const threads = Array.isArray(rawThreads)
    ? rawThreads.map(miString)
    : rawThreads !== undefined ? [miString(rawThreads)] : [];
  return {
    reason: p.reason !== undefined ? miString(p.reason) : null,
    breakpointNumber: p.bkptno !== undefined ? miString(p.bkptno) : undefined,
    frame: frameRec.addr !== undefined
      ? {
          addr: miString(frameRec.addr),
          func: miStringOpt(frameRec.func),
          file: miStringOpt(frameRec.file),
          line: miStringOpt(frameRec.line),
        }
      : null,
    threadId: p['thread-id'] !== undefined ? miString(p['thread-id']) : null,
    stoppedThreads: threads,
  };
}
