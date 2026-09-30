// PRD: §F-DBG-6 — DAP debug backend wiring QEMU + GDB for VS Code (P4.5).
// 'launch' spawns a frozen QEMU (`-S`) via QemuRunner and attaches GDB to its
// gdb stub; 'attach' connects GDB to an already running sim (e.g. the Electron
// app's VM) by port. Execution control goes through GDB exclusively once it is
// attached: `continue` is a GDB/MI command (the stub resumes the vCPU), NOT a
// QMP `cont` — issuing both would leave the guest running while GDB still
// believes it is stopped. QemuRunner therefore stays in 'loaded' status for
// the whole session and only provides the UART stream and process teardown.
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import type { ChipKind } from '@breadesp/netlist';
import type { QemuArgsInput } from '@breadesp/sim-core';
import { QemuRunner } from '../../qemu/QemuRunner.js';
import { GdbBridge, type GdbStartOptions, type StoppedInfo } from '../GdbBridge.js';

/** A DAP `setBreakpoints`/`setFunctionBreakpoints` entry worth inserting. */
export interface BackendBreakpointRequest {
  line?: number;
  name?: string;
  condition?: string;
}

/** DAP breakpoint result as reported back to the client. */
export interface BackendBreakpoint {
  id: number;
  verified: boolean;
  line?: number;
  message?: string;
}

/** DAP `stackTrace` frame. */
export interface BackendStackFrame {
  id: number;
  name: string;
  file: string | null;
  line: number;
}

/** DAP `variables` entry (flat — nested structs are not expanded). */
export interface BackendVariable {
  name: string;
  value: string;
}

export interface DapLaunchArgs {
  request: 'launch';
  elfPath: string;
  chip?: ChipKind;
  qemuBin?: string;
  gdbBin?: string;
  stopOnEntry?: boolean;
}

export interface DapAttachArgs {
  request: 'attach';
  host?: string;
  port: number;
  /** Symbol file for GDB; required — an attach without symbols is blind. */
  elfPath: string;
  /** Target chip; selects the Xtensa dynconfig for gdb register layout. */
  chip?: ChipKind;
  gdbBin?: string;
  stopOnEntry?: boolean;
}

export type DapBackendArgs = DapLaunchArgs | DapAttachArgs;

/** Output stream categories forwarded as DAP `output` events. */
export type OutputCategory = 'stdout' | 'stderr' | 'console' | 'log';

export interface DapBackendEvents {
  /** The target stopped; `info.reason` is the raw GDB reason (may be null). */
  stopped(info: StoppedInfo): void;
  /** The target resumed. */
  continued(): void;
  output(category: OutputCategory, text: string): void;
  /** Debug side is gone (GDB exited or QEMU died/quit). Emitted once. */
  terminated(): void;
}

export interface QemuGdbBackendOptions {
  /** Test seam: full GDB argv override (element 0 = executable). */
  gdbArgsBuilder?: (opts: GdbStartOptions) => string[];
  /** Test seam: full QEMU argv override (element 0 = executable). */
  qemuArgsBuilder?: (input: QemuArgsInput) => string[];
  /** Test seam: qemu manifest resolver override. */
  qemuBinResolver?: () => string | null;
  /** Per-MI-command deadline in ms (default 10s). */
  commandTimeoutMs?: number;
  /** GDB attach retry window for QEMU machine init (default 10s). */
  attachDeadlineMs?: number;
}

export interface DapBackend {
  on<E extends keyof DapBackendEvents>(event: E, listener: DapBackendEvents[E]): this;
  launch(args: DapLaunchArgs): Promise<void>;
  attach(args: DapAttachArgs): Promise<void>;
  /** Whether configurationDone should resume the target or report entry-stop. */
  shouldAutoResume(): boolean;
  isRunning(): boolean;
  resume(): Promise<void>;
  pause(): Promise<void>;
  stepIn(): Promise<void>;
  stepOver(): Promise<void>;
  stepOut(): Promise<void>;
  stackFrames(): Promise<BackendStackFrame[]>;
  locals(frameId: number): Promise<BackendVariable[]>;
  registers(): Promise<BackendVariable[]>;
  evaluate(expression: string, frameId?: number): Promise<string>;
  setSourceBreakpoints(sourcePath: string, wanted: BackendBreakpointRequest[]): Promise<BackendBreakpoint[]>;
  setFunctionBreakpoints(wanted: BackendBreakpointRequest[]): Promise<BackendBreakpoint[]>;
  disconnect(terminateDebuggee: boolean): Promise<void>;
}

const DEFAULT_ATTACH_DEADLINE_MS = 10_000;
const ATTACH_RETRY_MS = 200;

export class QemuGdbBackend extends EventEmitter implements DapBackend {
  private readonly gdb = new GdbBridge();
  private readonly runner = new QemuRunner();
  private readonly opts: QemuGdbBackendOptions;
  private mode: 'launch' | 'attach' | null = null;
  private stopOnEntry = false;
  private running = false;
  private terminated = false;
  /** GDB breakpoint ids per DAP breakpoint set (source path or '#functions'). */
  private readonly bpSets = new Map<string, number[]>();

  constructor(opts: QemuGdbBackendOptions = {}) {
    super();
    this.opts = opts;
    this.runner.on('uart', (text: string) => this.emit('output', 'stdout', text));
    this.runner.on('log', (text: string) => this.emit('output', 'stderr', text));
    this.runner.on('status', (status: string) => {
      if (status === 'stopped' || status === 'error') this.markTerminated();
    });
    this.gdb.on('stopped', (info: StoppedInfo) => {
      this.running = false;
      this.emit('stopped', info);
    });
    this.gdb.on('running', () => {
      this.running = true;
      this.emit('continued');
    });
    this.gdb.on('console', (text: string) => this.emit('output', 'console', text));
    this.gdb.on('log', (text: string) => this.emit('output', 'log', text));
    this.gdb.on('exit', () => {
      this.running = false;
      this.markTerminated();
    });
  }

  /** Launch mode: spawn a frozen QEMU VM and attach GDB to its gdb stub. */
  async launch(args: DapLaunchArgs): Promise<void> {
    this.assertIdle();
    const qemuBin = args.qemuBin ?? (this.opts.qemuBinResolver?.() ?? resolveQemuBinFromManifest());
    if (qemuBin === null || qemuBin === undefined) {
      throw new Error('[BB-100] QEMU binary not found; pass launch arg qemuBin or run pnpm fetch-qemu');
    }
    const chip: ChipKind = args.chip ?? 'esp32';
    await this.runner.load({
      firmwareElf: args.elfPath,
      chip,
      qemuBin,
      argsBuilder: this.opts.qemuArgsBuilder,
    });
    const port = this.runner.getGdbPort();
    if (port === null) throw new Error('[BB-104] QEMU did not expose a gdb stub port');
    await this.attachGdb({ elfPath: args.elfPath, targetHost: '127.0.0.1', port, gdbBin: args.gdbBin, chip });
    this.mode = 'launch';
    this.stopOnEntry = args.stopOnEntry ?? false;
  }

  /** Attach mode: connect GDB to a foreign sim's gdb stub by host/port. */
  async attach(args: DapAttachArgs): Promise<void> {
    this.assertIdle();
    if (typeof args.port !== 'number' || !Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
      throw new Error('[BB-132] attach requires an integer port in [1, 65535]');
    }
    await this.attachGdb({
      elfPath: args.elfPath,
      targetHost: args.host ?? '127.0.0.1',
      port: args.port,
      gdbBin: args.gdbBin,
      chip: args.chip ?? 'esp32',
    });
    this.mode = 'attach';
    this.stopOnEntry = args.stopOnEntry ?? false;
  }

  shouldAutoResume(): boolean {
    return !this.stopOnEntry && !this.running;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Resume via GDB (`vCont;c`); the stub drives the vCPU from here on. */
  async resume(): Promise<void> {
    this.assertAttached();
    if (this.running) return;
    await this.gdb.continue();
  }

  async pause(): Promise<void> {
    this.assertAttached();
    await this.gdb.interrupt();
  }

  async stepIn(): Promise<void> {
    this.assertAttached();
    await this.gdb.step();
  }

  async stepOver(): Promise<void> {
    this.assertAttached();
    await this.gdb.stepOver();
  }

  async stepOut(): Promise<void> {
    this.assertAttached();
    await this.gdb.stepOut();
  }

  async stackFrames(): Promise<BackendStackFrame[]> {
    this.assertAttached();
    const frames = await this.gdb.stackFrames();
    return frames.map((f, level) => ({
      id: level,
      name: f.func ?? f.addr,
      file: f.fullname ?? f.file ?? null,
      line: f.line !== undefined && Number.isFinite(Number(f.line)) ? Number(f.line) : 1,
    }));
  }

  async locals(_frameId: number): Promise<BackendVariable[]> {
    this.assertAttached();
    const vars = await this.gdb.vars();
    return Promise.all(vars.map(async (v) => ({
      name: v.name,
      value: v.value ?? await this.evaluateOrUnavailable(v.name),
    })));
  }

  async registers(): Promise<BackendVariable[]> {
    this.assertAttached();
    const regs = await this.gdb.regs();
    return Object.entries(regs).map(([name, value]) => ({ name, value }));
  }

  async evaluate(expression: string, _frameId?: number): Promise<string> {
    this.assertAttached();
    return this.gdb.evaluate(expression);
  }

  /**
   * Replace the breakpoint set of one source file: delete the previous GDB
   * breakpoints of that source, then insert the new ones. Insert failures
   * (unknown location/symbol) degrade that entry to verified=false instead of
   * failing the whole request — DAP clients render those as unverified dots.
   */
  async setSourceBreakpoints(sourcePath: string, wanted: BackendBreakpointRequest[]): Promise<BackendBreakpoint[]> {
    this.assertAttached();
    const key = normalize(sourcePath);
    return this.replaceBreakpointSet(key, wanted, (bp) => {
      if (typeof bp.line !== 'number' || !Number.isInteger(bp.line) || bp.line < 1) {
        throw new Error(`[BB-132] source breakpoint needs an integer line, got ${String(bp.line)}`);
      }
      return `${sourcePath}:${bp.line}`;
    });
  }

  async setFunctionBreakpoints(wanted: BackendBreakpointRequest[]): Promise<BackendBreakpoint[]> {
    this.assertAttached();
    return this.replaceBreakpointSet('#functions', wanted, (bp) => {
      if (typeof bp.name !== 'string' || bp.name === '') {
        throw new Error('[BB-132] function breakpoint needs a non-empty name');
      }
      return bp.name;
    });
  }

  /** Shut GDB down; in launch mode also quit the VM when asked to terminate. */
  async disconnect(terminateDebuggee: boolean): Promise<void> {
    if (this.mode === null) return;
    const wasLaunch = this.mode === 'launch';
    this.mode = null;
    this.running = false;
    this.bpSets.clear();
    await this.gdb.stop().catch(() => {}); // GDB may already be gone
    if (wasLaunch && terminateDebuggee) {
      await this.runner.stop().catch(() => {});
    }
  }

  /**
   * Attach with a retry window: QEMU binds the gdb stub late in machine init,
   * so an immediate `-target-select` can legitimately lose the race.
   */
  private async attachGdb(attach: {
    elfPath: string;
    targetHost: string;
    port: number;
    gdbBin?: string;
    chip: ChipKind;
  }): Promise<void> {
    const gdbBin = attach.gdbBin ?? process.env.BREADESP_GDB_BIN;
    if (this.opts.gdbArgsBuilder === undefined && (gdbBin === undefined || !existsSync(gdbBin))) {
      throw new Error(`[BB-110] GDB binary not found or not executable: ${String(gdbBin)} (set launch arg gdbBin or BREADESP_GDB_BIN)`);
    }
    const deadline = Date.now() + (this.opts.attachDeadlineMs ?? DEFAULT_ATTACH_DEADLINE_MS);
    for (;;) {
      try {
        await this.gdb.start({
          gdbBin: gdbBin ?? '',
          elfPath: attach.elfPath,
          targetHost: attach.targetHost,
          port: attach.port,
          chip: attach.chip,
          commandTimeoutMs: this.opts.commandTimeoutMs,
          argsBuilder: this.opts.gdbArgsBuilder,
        });
        return;
      } catch (err) {
        if (Date.now() >= deadline) throw err;
        await this.gdb.stop().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, ATTACH_RETRY_MS));
      }
    }
  }

  private assertIdle(): void {
    if (this.mode !== null) throw new Error('[BB-132] debug session already started');
  }

  private assertAttached(): void {
    if (this.mode === null) throw new Error('[BB-115] debug session not started; launch or attach first');
  }

  private markTerminated(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.emit('terminated');
  }

  private async replaceBreakpointSet(
    key: string,
    wanted: BackendBreakpointRequest[],
    toLocation: (bp: BackendBreakpointRequest) => string,
  ): Promise<BackendBreakpoint[]> {
    const previous = this.bpSets.get(key) ?? [];
    if (previous.length > 0) await this.gdb.removeBreakpoints(previous);
    const results: BackendBreakpoint[] = [];
    const inserted: number[] = [];
    for (const bp of wanted) {
      const location = toLocation(bp);
      try {
        const info = bp.condition !== undefined && bp.condition !== ''
          ? await this.gdb.setConditionalBreakpoint(location, bp.condition)
          : await this.gdb.setBreakpoint(location);
        inserted.push(info.id);
        results.push({ id: info.id, verified: true, line: bp.line });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ id: -1, verified: false, line: bp.line, message });
      }
    }
    this.bpSets.set(key, inserted);
    return results;
  }

  private async evaluateOrUnavailable(name: string): Promise<string> {
    try {
      return await this.gdb.evaluate(name);
    } catch {
      return '<unavailable>';
    }
  }
}

/**
 * Walk up from this module to find the fetch-qemu manifest (repo-local QEMU).
 */
export function resolveQemuBinFromManifest(): string | null {
  let dir = dirname(__filename);
  for (let depth = 0; depth < 8; depth++) {
    const manifestPath = join(dir, 'packages', 'sim-core', 'bin', 'qemu.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { repoRelativePath?: string };
        if (manifest.repoRelativePath !== undefined) {
          const bin = join(dir, manifest.repoRelativePath);
          if (existsSync(bin)) return bin;
        }
      } catch {
        return null; // corrupt manifest — treat as absent
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
