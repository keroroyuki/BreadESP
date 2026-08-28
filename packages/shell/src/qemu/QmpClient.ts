// PRD: §4.2, §F-SIM — QMP control channel (start/pause the loaded VM).
// JSON messages, one per line, over a loopback TCP chardev
// (`-qmp tcp:127.0.0.1:<port>,server=on,wait=off`). TCP instead of AF_UNIX because
// Node cannot reach unix sockets on Windows hosts.
import { connect, type Socket } from 'node:net';

export interface QmpConnectOptions {
  port: number;
  /** Loopback by default; QMP must never be exposed off-host (PRD §9). */
  host?: string;
  /** Per-step timeout (greeting, capabilities, each request). */
  timeoutMs?: number;
}

interface QmpErrorBody {
  class: string;
  desc: string;
}

export class QmpError extends Error {
  constructor(message: string, readonly qmpClass: string | null) {
    super(message);
    this.name = 'QmpError';
  }
}

/** Thin QMP client: handshake + request/response correlation by id. */
export class QmpClient {
  private socket: Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private handshakeTimeoutMs = 5000;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  /** One-shot raw-line watchers, used for the handshake greeting. */
  private readonly lineWaiters: Array<(line: string) => void> = [];

  /** Connect, wait for the greeting, and issue `qmp_capabilities`. */
  async connect(opts: QmpConnectOptions): Promise<void> {
    if (this.socket) return;
    const timeoutMs = opts.timeoutMs ?? 5000;
    this.handshakeTimeoutMs = timeoutMs;
    const host = opts.host ?? '127.0.0.1';

    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ port: opts.port, host });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`[BB-104] QMP connect timeout to ${host}:${opts.port}`));
      }, timeoutMs);
      s.once('connect', () => { clearTimeout(timer); resolve(s); });
      s.once('error', (err) => { clearTimeout(timer); reject(err); });
    });

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (err: Error) => this.onSocketError(err));
    socket.on('close', () => this.onClose());
    this.socket = socket;

    // Greeting: {"QMP": {...}}\n — on failure, release the socket and stay disconnected.
    try {
      await this.waitForGreeting(timeoutMs);
      await this.request('qmp_capabilities');
    } catch (err) {
      this.close();
      throw err;
    }
  }

  /** Continue execution of a VM started with `-S`. */
  async cont(): Promise<void> { await this.request('cont'); }

  /** Pause the virtual CPU. */
  async stop(): Promise<void> { await this.request('stop'); }

  /** Ask QEMU to exit cleanly. */
  async quit(): Promise<void> { await this.request('quit'); }

  /** Send a command and resolve with its `return` payload; rejects on QMP error. */
  request(command: string, args?: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error('[BB-104] QMP not connected'));
    const id = this.nextId++;
    const line = JSON.stringify(args === undefined
      ? { execute: command, id }
      : { execute: command, arguments: args, id }) + '\n';
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[BB-104] QMP request timeout: ${command}`));
      }, this.handshakeTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(line, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`[BB-104] QMP write failed for ${command}: ${err.message}`));
        }
      });
    });
  }

  /** Close the socket; pending requests reject with a readable error. */
  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.removeAllListeners('data');
    socket.removeAllListeners('error');
    socket.removeAllListeners('close');
    socket.destroy();
    this.onClose();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      this.dispatchLine(line);
    }
  }

  private dispatchLine(line: string): void {
    for (const waiter of [...this.lineWaiters]) waiter(line);
    let msg: Record<string, unknown>;
    try {
      // JSON.parse boundary: QMP lines are JSON objects by protocol contract.
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // Ignore non-JSON chatter; QMP lines are JSON by contract.
    }
    const hasError = typeof msg.error === 'object' && msg.error !== null;
    if (!hasError && typeof msg.return === 'undefined') return; // Asynchronous event.
    const id = typeof msg.id === 'number' ? msg.id : null;
    if (id === null) return; // Response without correlation id.
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (hasError) {
      // QMP contract: error responses carry { class, desc } (§QMP spec).
      const e = msg.error as QmpErrorBody;
      entry.reject(new QmpError(`[BB-104] QMP error ${e.class}: ${e.desc}`, e.class));
    } else {
      entry.resolve(msg.return);
    }
  }

  /** Resolves once a raw line containing the QMP greeting arrives. */
  private waitForGreeting(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.lineWaiters.splice(this.lineWaiters.indexOf(waiter), 1);
        reject(new Error('[BB-104] QMP greeting timeout'));
      }, timeoutMs);
      const waiter = (line: string): void => {
        if (!line.includes('"QMP"')) return;
        this.lineWaiters.splice(this.lineWaiters.indexOf(waiter), 1);
        clearTimeout(timer);
        resolve();
      };
      this.lineWaiters.push(waiter);
    });
  }

  private onSocketError(err: Error): void {
    // Surface the failure to every in-flight request; the close handler resets state.
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`[BB-104] QMP socket error: ${err.message}`));
    }
    this.pending.clear();
  }

  private onClose(): void {
    this.socket = null;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('[BB-104] QMP socket closed with requests in flight'));
    }
    this.pending.clear();
  }
}
