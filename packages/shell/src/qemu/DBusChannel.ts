// PRD: §4.2, §6.7 — DBus forward channel receiver. Listens for the QEMU custom
// device (breadesp-dbus, packages/sim-core/device/breadesp_dbus.c) which connects
// out to us and pushes length-prefixed JSON frames:
//
//   frame   := <uint32 LE payload-length> <payload>
//   payload := {"v":1,"tx":[<BusTransaction>,...]}
//
// Each transaction is deserialized (PRD §6.3 field mapping: the device emits
// virtual-clock nanoseconds, the SDK contract wants virtual milliseconds) and
// handed to the registered handler. TCP loopback by default so Windows hosts
// work (Node cannot serve AF_UNIX there); unix socket on POSIX.
import { createServer, type Server, type Socket } from 'node:net';
import type { BusTransaction } from '@breadesp/peripherals';

export type TransactionHandler = (tx: BusTransaction) => void;

export interface DBusListenOptions {
  /** TCP listen host (loopback by default, PRD §9 sandbox). */
  host?: string;
  /** TCP listen port; 0 picks a free ephemeral port (exposed via DBusChannel.port). */
  port?: number;
  /** Unix domain socket path to listen on (POSIX hosts only). */
  socket?: string;
}

/** Raw frame payload as serialized by the device (PRD §6.7). */
interface RawFrame {
  v?: number;
  tx?: RawTransaction[];
}

interface RawTransaction {
  kind?: string;
  bus?: number;
  target?: number;
  dir?: string;
  data?: number[];
  length?: number;
  ts?: number;
}

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export class DBusChannel {
  private handler?: TransactionHandler;
  private server?: Server;
  private sockets = new Set<Socket>();
  private buffer: Buffer = Buffer.alloc(0);
  #port = 0;
  #socketPath?: string;

  /** TCP port actually bound (0 before listen, or when a unix socket is used). */
  get port(): number {
    return this.#port;
  }

  onTransaction(handler: TransactionHandler): void {
    this.handler = handler;
  }

  /**
   * Start listening for the QEMU device connection. The device connects during
   * its realize (qio_channel_socket_connect_sync), so listening must happen
   * before the QEMU process is spawned.
   */
  async listen(options: DBusListenOptions = {}): Promise<void> {
    if (!this.handler) throw new Error('dbus: register onTransaction() before listen()');
    if (this.server) throw new Error('dbus: channel already listening');

    const { host, port, socket } = options;
    if (socket !== undefined && port !== undefined) {
      throw new Error('dbus: listen on either socket or host+port, not both');
    }

    this.server = createServer((conn) => {
      this.sockets.add(conn);
      conn.on('data', (chunk: Buffer) => this.onData(conn, chunk));
      const drop = () => {
        this.sockets.delete(conn);
        this.buffer = Buffer.alloc(0);
      };
      conn.on('close', drop);
      conn.on('error', drop);
    });

    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (err: Error) => {
        this.server = undefined;
        rejectListen(new Error(`dbus: listen failed: ${err.message}`));
      };
      this.server!.once('error', onError);
      if (socket !== undefined) {
        this.server!.listen(socket, () => {
          this.#socketPath = socket;
          this.server!.off('error', onError);
          resolveListen();
        });
      } else {
        this.server!.listen(port ?? 0, host ?? '127.0.0.1', () => {
          const addr = this.server!.address();
          this.#port = typeof addr === 'object' && addr !== null ? addr.port : 0;
          this.server!.off('error', onError);
          resolveListen();
        });
      }
    });
  }

  /** Parse complete frames out of the connection buffer and dispatch them. */
  private onData(conn: Socket, chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    for (;;) {
      if (this.buffer.length < 4) return;
      const payloadLen = this.buffer.readUInt32LE(0);
      if (payloadLen > MAX_FRAME_BYTES) {
        conn.destroy();
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.buffer.length < 4 + payloadLen) return;

      const payload = this.buffer.subarray(4, 4 + payloadLen);
      this.buffer = this.buffer.subarray(4 + payloadLen);
      let frame: RawFrame;
      try {
        frame = JSON.parse(payload.toString('utf8')) as RawFrame;
      } catch {
        continue; // tolerate a malformed frame; the protocol has no recovery channel
      }
      if (frame.v !== PROTOCOL_VERSION) continue;
      for (const raw of frame.tx ?? []) {
        const tx = deserializeTransaction(raw);
        if (tx) this.handler?.(tx);
      }
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const sock of this.sockets) sock.destroy();
    this.sockets.clear();
    this.buffer = Buffer.alloc(0);
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // A listening server with live connections only closes once they end:
      // force-close the tracked sockets first so this cannot hang.
      const socketPath = this.#socketPath;
      if (socketPath !== undefined) {
        import('node:fs').then((fs) => fs.promises.unlink(socketPath).catch(() => {}));
      }
    });
  }
}

/** Map a device-serialized transaction (PRD §6.7) onto the SDK BusTransaction. */
function deserializeTransaction(raw: RawTransaction): BusTransaction | null {
  if (typeof raw.kind !== 'string' || typeof raw.bus !== 'number' || typeof raw.dir !== 'string' || typeof raw.ts !== 'number') {
    return null;
  }
  if (raw.dir !== 'read' && raw.dir !== 'write') return null;
  const tx: BusTransaction = {
    kind: raw.kind as BusTransaction['kind'],
    bus: raw.bus,
    dir: raw.dir,
    // The device timestamps with QEMU virtual-clock nanoseconds; the contract
    // (PRD §6.3) is logical milliseconds.
    ts: raw.ts / 1_000_000,
    data: raw.dir === 'write'
      ? Uint8Array.from(Array.isArray(raw.data) ? raw.data : [])
      : new Uint8Array(0),
  };
  if (raw.target !== undefined) tx.target = raw.target;
  if (raw.dir === 'read' && raw.length !== undefined) tx.length = raw.length;
  return tx;
}
