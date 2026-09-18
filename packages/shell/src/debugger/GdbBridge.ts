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
import type { ChipKind } from '@breadesp/netlist';
import { parseMiLine, type MiRecord, type MiTuple, type MiValue } from './MiParser.js';
import { resolveDynconfigEnv } from './XtensaDynconfig.js';

export interface BreakpointInfo { id: number; address: string; enabled: boolean; }

/** 'breakpoint' — code location; 'watchpoint' — hardware data watch. */
export type BreakpointKind = 'breakpoint' | 'watchpoint';

/** Watchpoint trigger mode (PRD §F-DBG-4): write (default), read or access. */
export type WatchMode = 'write' | 'read' | 'access';

/** One row of the debug panel's breakpoints list (PRD §F-DBG-1, P4.4 F-DBG-4). */
export interface BreakpointRow {
  id: number;
  kind: BreakpointKind;
  address: string | null;
  /** Original location as entered, e.g. "app_main" or "*0x40080048"; the watched expression for watchpoints. */
  location: string | null;
  enabled: boolean;
  /** Condition expression (conditional breakpoints, PRD §F-DBG-4); null when none. */
  cond: string | null;
}

/** One frame variable of the current stop (PRD §F-DBG-3: 局部变量). */
export interface VarInfo {
  name: string;
  /** 'arg' when GDB flags it as an argument, otherwise 'local'. */
  scope: 'arg' | 'local';
  /** GDB's rendering of the value; null when not evaluated (complex type). */
  value: string | null;
}

export interface FrameInfo {
  addr: string;
  func?: string;
  file?: string;
  /** Absolute source path as resolved by GDB's debug info, when known. */
  fullname?: string;
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
  /** Target chip; selects the esp-gdb Xtensa dynconfig when available (P4.5). */
  chip?: ChipKind;
  /** Per-command deadline in ms (default 10s). */
  commandTimeoutMs?: number;
  /**
   * Extra environment for the GDB process. Xtensa dynconfig selection
   * (XTENSA_GNU_CONFIG) is derived from `chip` automatically; explicit
   * entries here take precedence.
   */
  env?: Record<string, string | undefined>;
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
    const dynconfigEnv = opts.chip !== undefined ? resolveDynconfigEnv(opts.gdbBin, opts.chip) : undefined;
    const env = { ...dynconfigEnv, ...opts.env };
    const child = spawn(bin, rest, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: Object.keys(env).length > 0 ? { ...process.env, ...env } : process.env,
    });
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
    const rec = await this.send(`-break-insert ${quoteMiArg(at)}`);
    return parseBkpt(rec, '-break-insert');
  }

  /**
   * Insert a breakpoint whose stop is gated on a condition expression
   * (PRD §F-DBG-4 conditional breakpoints) via `-break-insert -c "cond" loc`.
   */
  async setConditionalBreakpoint(at: string, condition: string): Promise<BreakpointInfo> {
    const location = quoteMiArg(at);
    const cond = quoteMiArg(condition);
    const rec = await this.send(`-break-insert -c ${cond} ${location}`);
    return parseBkpt(rec, '-break-insert');
  }

  /** Set or clear (empty string) the condition of an existing breakpoint (PRD §F-DBG-4). */
  async conditionBreakpoint(id: number, condition: string): Promise<void> {
    await this.send(`-break-condition ${id} ${condition}`.trim());
  }

  /**
   * Insert a hardware watchpoint on an expression (PRD §F-DBG-4) via
   * `-break-watch [-r|-a] expr`. The stop lands as a `stopped` event with
   * reason 'read-watchpoint-trigger' / 'watchpoint-trigger' /
   * 'access-watchpoint-trigger' depending on the mode.
   */
  async setWatchpoint(expr: string, mode: WatchMode = 'write'): Promise<BreakpointInfo> {
    const flag = mode === 'read' ? '-r ' : mode === 'access' ? '-a ' : '';
    const rec = await this.send(`-break-watch ${flag}${quoteMiArg(expr)}`);
    // Result key varies with the mode: wpt / hw-rwpt / hw-awpt.
    const bkpt = asRecord(rec.payload?.wpt ?? rec.payload?.['hw-rwpt'] ?? rec.payload?.['hw-awpt']);
    const id = Number(bkpt.number);
    if (!Number.isFinite(id)) {
      throw new Error(`[BB-113] -break-watch returned no watchpoint number: ${JSON.stringify(rec.payload ?? {})}`);
    }
    return { id, address: '', enabled: true };
  }

  /** Delete one breakpoint by its GDB number (PRD §F-DBG-1); also removes watchpoints. */
  async removeBreakpoint(id: number): Promise<void> {
    await this.send(`-break-delete ${id}`);
  }

  /** Delete several breakpoints in one `-break-delete` (P4.5 DAP set replacement). */
  async removeBreakpoints(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.send(`-break-delete ${ids.join(' ')}`);
  }

  /** Resume the target; resolves on `^running` — the stop arrives as a `stopped` event. */
  async continue(): Promise<void> {
    await this.send('-exec-continue');
  }

  /** One machine-instruction step; the stop arrives as a `stopped` event (PRD §F-SIM-1). */
  async step(): Promise<void> {
    await this.send('-exec-step-instruction');
  }

  /** Step over the next instruction (PRD §F-DBG-2 单步跨过). */
  async stepOver(): Promise<void> {
    await this.send('-exec-next-instruction');
  }

  /**
   * Run until the current frame returns (-exec-finish, P4.5 DAP step-out);
   * the stop arrives as a `stopped` event with reason 'function-finished'.
   */
  async stepOut(): Promise<void> {
    await this.send('-exec-finish');
  }

  /**
   * Interrupt a running target (-exec-interrupt, P4.5 DAP pause). The stop
   * arrives as a `stopped` event; GDB reports it as signal-received (SIGINT)
   * rather than an exec-async reason on some stubs, hence the mapping happens
   * on the DAP layer, not here.
   */
  async interrupt(): Promise<void> {
    await this.send('-exec-interrupt');
  }

  /**
   * Call-stack frames of the current stop, innermost first, via
   * `-stack-list-frames` (P4.5 DAP stackTrace). Levels are the MI `level`
   * fields; DWARF-backed fixtures carry func/file/fullname/line.
   */
  async stackFrames(): Promise<FrameInfo[]> {
    const rec = await this.send('-stack-list-frames');
    // MI wraps each element as `frame={...}` inside the results list, the same
    // shape -break-list uses with `bkpt={...}` — unwrap before reading fields.
    return asList(rec.payload?.stack).map((entry) => {
      const t = asRecord(asRecord(entry).frame);
      return {
        addr: miString(t.addr),
        func: miStringOpt(t.func),
        file: miStringOpt(t.file),
        fullname: miStringOpt(t.fullname),
        line: miStringOpt(t.line),
      };
    });
  }

  /**
   * Frame variables of the current stop (PRD §F-DBG-3 局部变量) via
   * `-stack-list-variables --simple-values`; complex-typed entries arrive
   * name-only. Requires DWARF for the containing function (fixtures since P1.9).
   */
  async vars(): Promise<VarInfo[]> {
    const rec = await this.send('-stack-list-variables --simple-values');
    const list = asList(rec.payload?.variables);
    return list.map((entry) => {
      const t = asRecord(entry);
      return {
        name: miString(t.name),
        scope: miString(t.arg) === '1' ? 'arg' : 'local',
        value: t.value !== undefined ? miString(t.value) : null,
      };
    });
  }

  /**
   * All target registers as `name -> hex value` (PRD §F-DBG-3 寄存器).
   * `-data-list-register-names` and `-data-list-register-values x` share the
   * same index space; empty name slots are skipped.
   */
  async regs(): Promise<Record<string, string>> {
    const namesRec = await this.send('-data-list-register-names');
    const names = asList(namesRec.payload?.['register-names']).map(miString);
    const valuesRec = await this.send('-data-list-register-values x');
    const values = new Map<number, string>();
    for (const entry of asList(valuesRec.payload?.['register-values'])) {
      const t = asRecord(entry);
      values.set(Number(miString(t.number)), miString(t.value));
    }
    const regs: Record<string, string> = {};
    names.forEach((name, i) => {
      if (name === '') return;
      const v = values.get(i);
      if (v !== undefined) regs[name] = v;
    });
    return regs;
  }

  /**
   * Evaluate one expression in the current frame context (PRD §F-DBG-3 全局变量:
   * globals/memory like `led_state` or `*(unsigned int*)0x3ff44004`).
   */
  async evaluate(expr: string): Promise<string> {
    const quoted = `"${expr.replace(/"/g, '\\"')}"`;
    const rec = await this.send(`-data-evaluate-expression ${quoted}`);
    return miString(rec.payload?.value);
  }

  /** Current breakpoints and watchpoints from `-break-list` (PRD §F-DBG-1, P4.4). */
  async listBreakpoints(): Promise<BreakpointRow[]> {
    const rec = await this.send('-break-list');
    // MI shape: ^done,BreakpointTable={nr_rows="1",...,body=[bkpt={...}]} —
    // `body` lives INSIDE BreakpointTable (wire-verified against esp-gdb 16.3).
    const table = asRecord(rec.payload?.BreakpointTable);
    const body = asList(table.body);
    return body.map((entry) => {
      const bkpt = asRecord(asRecord(entry).bkpt);
      const type = miString(bkpt.type);
      // Watchpoint rows carry the expression in `what` and usually no addr.
      const what = bkpt.what !== undefined ? miString(bkpt.what) : null;
      return {
        id: Number(bkpt.number),
        kind: type === 'breakpoint' ? 'breakpoint' : 'watchpoint',
        address: bkpt.addr !== undefined && what === null ? miString(bkpt.addr) : null,
        location: bkpt['original-location'] !== undefined ? miString(bkpt['original-location']) : what,
        enabled: miString(bkpt.enabled) !== 'n',
        cond: bkpt.cond !== undefined ? miString(bkpt.cond) || null : null,
      };
    });
  }

  /**
   * Delete every breakpoint (PRD §F-DBG-1 清空断点). MI's `-break-delete`
   * rejects an empty argument list, so the ids are enumerated first.
   */
  async clearBreakpoints(): Promise<void> {
    const ids = (await this.listBreakpoints()).map((b) => b.id);
    if (ids.length > 0) await this.send(`-break-delete ${ids.join(' ')}`);
  }

  /** Whether a GDB process is attached and alive (IPC dbg:status, P1.9). */
  isConnected(): boolean {
    return this.proc !== null && !this.exited;
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

/** Quote one MI argument; quoting is only needed when whitespace/embedded quotes appear. */
function quoteMiArg(arg: string): string {
  return /\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/** Narrow a `-break-insert` result record into BreakpointInfo. */
function parseBkpt(rec: MiRecord, cmd: string): BreakpointInfo {
  const bkpt = asRecord(rec.payload?.bkpt);
  const id = Number(bkpt.number);
  if (!Number.isFinite(id)) {
    throw new Error(`[BB-113] ${cmd} returned no breakpoint number: ${JSON.stringify(rec.payload ?? {})}`);
  }
  return {
    id,
    address: miString(bkpt.addr),
    enabled: miString(bkpt.enabled) !== 'n',
  };
}

/** Narrow an MI value to a tuple, tolerating absent/malformed payloads. */
function asRecord(v: MiValue | undefined): MiTuple {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as MiTuple : {};
}

/** Narrow an MI value to a list, tolerating absent/malformed payloads. */
function asList(v: MiValue | undefined): MiValue[] {
  return Array.isArray(v) ? v : [];
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
