// PRD: §F-DBG-6 — DAP session server (dev-plan task P4.5). Speaks the Debug
// Adapter Protocol over any byte transport (stdio or TCP) and bridges it onto
// a DapBackend (QemuGdbBackend). The command surface is the VS Code debug
// basics set: breakpoints (source + function, with conditions), stack frames,
// scopes/variables, evaluate, continue/step/pause and disconnect. Framing is
// DAP's Content-Length scheme; protocol errors ([BB-132]) surface as DAP
// error responses, backend errors keep their [BB-1xx] messages.
import { createServer, type Server } from 'node:net';
import { DapFrameDecoder, encodeDapMessage } from './DapProtocol.js';
import type {
  BackendVariable,
  DapAttachArgs,
  DapBackend,
  DapLaunchArgs,
} from './QemuGdbBackend.js';

interface DapRequestMessage {
  seq: number;
  type: 'request';
  command: string;
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
}

interface DapIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/** A request that must fail with a readable DAP error message. */
class DapRequestError extends Error {}

/** DAP `initialize` capabilities of this adapter (VS Code debug basics). */
const CAPABILITIES = {
  supportsConfigurationDoneRequest: true,
  supportsFunctionBreakpoints: true,
  supportsConditionalBreakpoints: true,
  supportsEvaluateForHovers: true,
  supportsSetVariable: false,
  supportsRestartRequest: false,
  supportsTerminateRequest: true,
  supportTerminateDebuggee: true,
  supportSuspendDebuggee: false,
  exceptionBreakpointFilters: [],
};

/** Map a raw GDB stop reason onto the DAP stopped-reason enum. */
export function mapStopReason(rawReason: string | null): string {
  switch (rawReason) {
    case 'breakpoint-hit':
      return 'breakpoint';
    case 'end-stepping-range':
    case 'function-finished':
      return 'step';
    case 'watchpoint-trigger':
    case 'read-watchpoint-trigger':
    case 'access-watchpoint-trigger':
      return 'data breakpoint';
    case 'entry':
      return 'entry';
    default:
      // signal-received (SIGINT from pause), unknown stubs, missing reason.
      return 'pause';
  }
}

export interface DapServerOptions {
  /** Diagnostic sink (protocol trace); never the DAP transport itself. */
  log?: (message: string) => void;
}

export class DapServer {
  constructor(
    private readonly backendFactory: () => DapBackend,
    private readonly opts: DapServerOptions = {},
  ) {}

  /** Serve one DAP session over the given transport. */
  serve(io: DapIo): void {
    const session = new DapSession(io, this.backendFactory(), this.opts.log);
    session.start();
  }

  /**
   * Socket mode: one session per TCP connection on 127.0.0.1:port. This is
   * what a VS Code launch.json `debugServer` entry points at.
   */
  async listen(port: number): Promise<Server> {
    const server = createServer((socket) => {
      socket.on('error', () => this.opts.log?.('client socket error; session dropped'));
      this.serve({ input: socket, output: socket });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    return server;
  }
}

class DapSession {
  private seq = 1;
  private decoder = new DapFrameDecoder();
  private initialized = false;
  private launched = false;
  private terminatedSent = false;
  /** variablesReference registry: 0 means "no children" per DAP. */
  private readonly refs = new Map<number, { kind: 'locals' | 'registers'; frameId: number }>();
  private nextRef = 1;

  constructor(
    private readonly io: DapIo,
    private readonly backend: DapBackend,
    private readonly log?: (message: string) => void,
  ) {}

  start(): void {
    this.wireBackend();
    this.io.input.on('data', (chunk: Buffer) => this.feed(chunk));
    this.io.input.on('error', (err: Error) => this.log?.(`DAP transport error: ${err.message}`));
    this.io.input.on('end', () => {
      // Transport gone without an explicit disconnect — best-effort cleanup.
      void this.backend.disconnect(true).catch(() => {});
    });
  }

  private feed(chunk: Buffer): void {
    let messages: object[];
    try {
      messages = this.decoder.push(chunk);
    } catch (err) {
      // A malformed frame desyncs the stream; nothing sane can follow.
      const message = err instanceof Error ? err.message : String(err);
      this.log?.(`DAP framing error; terminating session: ${message}`);
      this.sendEvent('terminated', {});
      return;
    }
    for (const message of messages) {
      void this.handleMessage(message);
    }
  }

  private async handleMessage(message: object): Promise<void> {
    // Wire input boundary: the shape is narrowed by the guards right below.
    const req = message as DapRequestMessage;
    if (req.type !== 'request' || typeof req.command !== 'string') {
      this.log?.(`ignoring non-request DAP message: ${JSON.stringify(message).slice(0, 200)}`);
      return;
    }
    let body: object | undefined;
    try {
      body = await this.dispatch(req);
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      this.log?.(`DAP ${req.command} failed: ${messageText}`);
      this.sendResponse(req, false, undefined, messageText);
      return;
    }
    this.sendResponse(req, true, body);
    if (req.command === 'launch' || req.command === 'attach') {
      // DAP sequencing: the adapter announces readiness for the
      // configuration phase only after launch/attach succeeded.
      this.sendEvent('initialized', {});
    }
  }

  private async dispatch(req: DapRequestMessage): Promise<object | undefined> {
    const args = (req.arguments ?? {}) as Record<string, unknown>;
    switch (req.command) {
      case 'initialize': {
        if (this.initialized) throw new DapRequestError('session already initialized');
        this.initialized = true;
        return CAPABILITIES;
      }
      case 'launch': {
        this.guardInitialized();
        this.guardNotLaunched();
        // Mark the session live before the backend spawns anything: QEMU's
        // spawn banner and GDB's early log output arrive during launch() and
        // must flow as output events, not be silently dropped.
        this.launched = true;
        try {
          await this.backend.launch(parseLaunchArgs(args));
        } catch (err) {
          this.launched = false;
          throw err;
        }
        return {};
      }
      case 'attach': {
        this.guardInitialized();
        this.guardNotLaunched();
        this.launched = true;
        try {
          await this.backend.attach(parseAttachArgs(args));
        } catch (err) {
          this.launched = false;
          throw err;
        }
        return {};
      }
      case 'setBreakpoints': {
        this.guardLaunched();
        const source = asRecord(args.source);
        const path = source.path;
        if (typeof path !== 'string' || path === '') {
          throw new DapRequestError('[BB-132] setBreakpoints requires source.path');
        }
        const wanted = parseBreakpointRequests(args.breakpoints);
        const breakpoints = await this.backend.setSourceBreakpoints(path, wanted);
        return { breakpoints };
      }
      case 'setFunctionBreakpoints': {
        this.guardLaunched();
        const wanted = parseBreakpointRequests(args.breakpoints);
        const breakpoints = await this.backend.setFunctionBreakpoints(wanted);
        return { breakpoints };
      }
      case 'setExceptionBreakpoints':
        this.guardLaunched();
        return { breakpoints: [] };
      case 'configurationDone': {
        this.guardLaunched();
        if (this.backend.shouldAutoResume()) {
          await this.backend.resume();
        } else {
          this.sendEvent('stopped', { reason: 'entry', threadId: 1, allThreadsStopped: true });
        }
        return {};
      }
      case 'threads': {
        this.guardLaunched();
        return { threads: [{ id: 1, name: 'ESP32' }] };
      }
      case 'stackTrace': {
        this.guardLaunched();
        const frames = await this.backend.stackFrames();
        const start = typeof args.start === 'number' && args.start >= 0 ? args.start : 0;
        const levels = typeof args.levels === 'number' && args.levels > 0 ? args.levels : frames.length;
        const sliced = frames.slice(start, start + levels).map((f) => ({
          id: f.id,
          name: f.name,
          line: f.line,
          column: 1,
          ...(f.file !== null ? { source: { path: f.file, name: f.file.replace(/\\/g, '/').split('/').pop() } } : {}),
        }));
        return { stackFrames: sliced, totalFrames: frames.length };
      }
      case 'scopes': {
        this.guardLaunched();
        const frameId = requireNumber(args.frameId, 'scopes requires a frameId');
        const localsRef = this.allocRef('locals', frameId);
        const registersRef = this.allocRef('registers', frameId);
        return {
          scopes: [
            { name: 'Locals', variablesReference: localsRef, expensive: false, presentationHint: 'locals' },
            { name: 'Registers', variablesReference: registersRef, expensive: false, presentationHint: 'registers' },
          ],
        };
      }
      case 'variables': {
        this.guardLaunched();
        const variablesReference = requireNumber(args.variablesReference, 'variables requires variablesReference');
        const ref = this.refs.get(variablesReference);
        if (ref === undefined) {
          throw new DapRequestError(`unknown variablesReference ${variablesReference}`);
        }
        const variables: BackendVariable[] = ref.kind === 'registers'
          ? await this.backend.registers()
          : await this.backend.locals(ref.frameId);
        return { variables: variables.map((v) => ({ name: v.name, value: v.value, variablesReference: 0 })) };
      }
      case 'evaluate': {
        this.guardLaunched();
        const expression = args.expression;
        if (typeof expression !== 'string' || expression === '') {
          throw new DapRequestError('[BB-132] evaluate requires a non-empty expression');
        }
        const frameId = typeof args.frameId === 'number' ? args.frameId : undefined;
        const result = await this.backend.evaluate(expression, frameId);
        return { result, variablesReference: 0 };
      }
      case 'continue': {
        this.guardLaunched();
        await this.backend.resume();
        return { allThreadsContinued: true };
      }
      case 'next':
        this.guardLaunched();
        await this.backend.stepOver();
        return {};
      case 'stepIn':
        this.guardLaunched();
        await this.backend.stepIn();
        return {};
      case 'stepOut':
        this.guardLaunched();
        await this.backend.stepOut();
        return {};
      case 'pause':
        this.guardLaunched();
        await this.backend.pause();
        return {};
      case 'disconnect': {
        const terminateDebuggee = args.terminateDebuggee === undefined ? true : args.terminateDebuggee === true;
        await this.backend.disconnect(terminateDebuggee);
        return {};
      }
      case 'terminate':
        await this.backend.disconnect(true);
        return {};
      default:
        throw new DapRequestError(`unknown command '${req.command}'`);
    }
  }

  private wireBackend(): void {
    this.backend.on('stopped', (info) => {
      if (!this.launched) return;
      const body: Record<string, unknown> = {
        reason: mapStopReason(info.reason),
        threadId: 1,
        allThreadsStopped: true,
        text: info.reason ?? undefined,
        description: info.reason ?? undefined,
      };
      if (info.breakpointNumber !== undefined) body.hitBreakpointIds = [Number(info.breakpointNumber)];
      this.sendEvent('stopped', body);
    });
    this.backend.on('continued', () => {
      if (!this.launched) return;
      this.sendEvent('continued', { threadId: 1, allThreadsContinued: true });
    });
    this.backend.on('output', (category, text) => {
      if (!this.launched) return;
      this.sendEvent('output', { category, output: text });
    });
    this.backend.on('terminated', () => {
      if (!this.launched || this.terminatedSent) return;
      this.terminatedSent = true;
      this.sendEvent('exited', { exitCode: 0 });
      this.sendEvent('terminated', {});
    });
  }

  private allocRef(kind: 'locals' | 'registers', frameId: number): number {
    const ref = this.nextRef++;
    this.refs.set(ref, { kind, frameId });
    return ref;
  }

  private guardInitialized(): void {
    if (!this.initialized) throw new DapRequestError("session is not initialized; send 'initialize' first");
  }

  private guardLaunched(): void {
    this.guardInitialized();
    if (!this.launched) throw new DapRequestError("no debug session; send 'launch' or 'attach' first");
  }

  private guardNotLaunched(): void {
    if (this.launched) throw new DapRequestError('debug session already started');
  }

  private sendResponse(req: DapRequestMessage, success: boolean, body?: object, message?: string): void {
    this.write({
      seq: this.seq++,
      type: 'response',
      request_seq: req.seq,
      success,
      command: req.command,
      ...(message !== undefined ? { message } : {}),
      ...(body !== undefined ? { body } : {}),
    });
  }

  private sendEvent(event: string, body: object): void {
    this.write({ seq: this.seq++, type: 'event', event, body });
  }

  private write(message: object): void {
    this.io.output.write(encodeDapMessage(message));
  }
}

function parseLaunchArgs(args: Record<string, unknown>): DapLaunchArgs {
  const elfPath = args.elfPath ?? args.program;
  if (typeof elfPath !== 'string' || elfPath === '') {
    throw new DapRequestError('[BB-132] launch requires elfPath (string)');
  }
  if (args.port !== undefined) {
    throw new DapRequestError('[BB-132] launch does not take a port; use request=attach');
  }
  if (args.chip !== undefined && args.chip !== 'esp32' && args.chip !== 'esp32s3'
    && args.chip !== 'esp32c3' && args.chip !== 'esp32c6') {
    throw new DapRequestError(`[BB-132] unsupported chip ${JSON.stringify(args.chip)}`);
  }
  return {
    request: 'launch',
    elfPath,
    ...(args.chip !== undefined ? { chip: args.chip } : {}),
    ...(typeof args.qemuBin === 'string' ? { qemuBin: args.qemuBin } : {}),
    ...(typeof args.gdbBin === 'string' ? { gdbBin: args.gdbBin } : {}),
    ...(args.stopOnEntry !== undefined ? { stopOnEntry: args.stopOnEntry === true } : {}),
  };
}

function parseAttachArgs(args: Record<string, unknown>): DapAttachArgs {
  const elfPath = args.elfPath ?? args.program;
  if (typeof elfPath !== 'string' || elfPath === '') {
    throw new DapRequestError('[BB-132] attach requires elfPath (string)');
  }
  if (typeof args.port !== 'number' || !Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new DapRequestError('[BB-132] attach requires an integer port in [1, 65535]');
  }
  if (args.chip !== undefined && args.chip !== 'esp32' && args.chip !== 'esp32s3'
    && args.chip !== 'esp32c3' && args.chip !== 'esp32c6') {
    throw new DapRequestError(`[BB-132] unsupported chip ${JSON.stringify(args.chip)}`);
  }
  return {
    request: 'attach',
    port: args.port,
    elfPath,
    ...(args.chip !== undefined ? { chip: args.chip } : {}),
    ...(typeof args.host === 'string' ? { host: args.host } : {}),
    ...(typeof args.gdbBin === 'string' ? { gdbBin: args.gdbBin } : {}),
    ...(args.stopOnEntry !== undefined ? { stopOnEntry: args.stopOnEntry === true } : {}),
  };
}

function parseBreakpointRequests(raw: unknown): Array<{ line?: number; name?: string; condition?: string }> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new DapRequestError('[BB-132] breakpoints must be an array');
  }
  return raw.map((entry) => {
    const bp = asRecord(entry as Record<string, unknown>);
    const out: { line?: number; name?: string; condition?: string } = {};
    if (typeof bp.line === 'number') out.line = bp.line;
    if (typeof bp.name === 'string') out.name = bp.name;
    if (typeof bp.condition === 'string') out.condition = bp.condition;
    return out;
  });
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function requireNumber(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new DapRequestError(`[BB-132] ${what}`);
  return v;
}
