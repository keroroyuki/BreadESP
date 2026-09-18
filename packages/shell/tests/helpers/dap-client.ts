// In-memory DAP test client: frames requests onto a PassThrough pair exactly
// as a VS Code client would, and collects responses/events from the adapter.
// Shared by DapServer.integration.test.ts and the gated dap-launch e2e.
import { PassThrough } from 'node:stream';
import { DapFrameDecoder } from '../../src/debugger/dap/DapProtocol.js';

export interface DapMessage {
  type?: string;
  command?: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  event?: string;
  body?: Record<string, unknown>;
  [key: string]: unknown;
}

export class DapClient {
  readonly toServer = new PassThrough();
  readonly fromServer = new PassThrough();
  private readonly decoder = new DapFrameDecoder();
  private readonly messages: DapMessage[] = [];
  private nextSeq = 1;
  private eventCursor = 0;
  private waiters: Array<{ predicate: (m: DapMessage) => boolean; resolve: (m: DapMessage) => void }> = [];

  constructor() {
    this.fromServer.on('data', (chunk: Buffer) => {
      for (const message of this.decoder.push(chunk)) this.push(message as DapMessage);
    });
  }

  private push(message: DapMessage): void {
    this.messages.push(message);
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i].predicate(message)) {
        this.waiters[i].resolve(message);
        this.waiters.splice(i, 1);
      }
    }
  }

  /** Send a request; resolves with its response once it arrives. */
  request(command: string, args?: Record<string, unknown>, timeoutMs = 8000): Promise<DapMessage> {
    const seq = this.nextSeq++;
    const frame = { seq, type: 'request', command, arguments: args ?? {} };
    const payload = JSON.stringify(frame);
    this.toServer.write(
      Buffer.concat([
        Buffer.from(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n`, 'ascii'),
        Buffer.from(payload, 'utf8'),
      ]),
    );
    return this.waitFor((m) => m.type === 'response' && m.request_seq === seq, `response to ${command}`, timeoutMs);
  }

  waitFor(predicate: (m: DapMessage) => boolean, what: string, timeoutMs = 8000): Promise<DapMessage> {
    const existing = this.messages.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<DapMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs);
      this.waiters.push({
        predicate: (m) => {
          if (!predicate(m)) return false;
          clearTimeout(timer);
          return true;
        },
        resolve,
      });
    });
  }

  /** Wait for the next event with `event` name AFTER the cursor (sequential). */
  nextEvent(event: string, timeoutMs = 8000): Promise<DapMessage> {
    const idx = this.messages.findIndex((m, i) => i >= this.eventCursor && m.type === 'event' && m.event === event);
    if (idx >= 0) {
      this.eventCursor = idx + 1;
      return Promise.resolve(this.messages[idx]);
    }
    return new Promise<DapMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for event ${event}`)), timeoutMs);
      this.waiters.push({
        predicate: (m) => {
          if (!(m.type === 'event' && m.event === event)) return false;
          const at = this.messages.indexOf(m);
          if (at < this.eventCursor) return false;
          clearTimeout(timer);
          this.eventCursor = at + 1;
          return true;
        },
        resolve,
      });
    });
  }

  waitEvent(event: string, timeoutMs = 8000): Promise<DapMessage> {
    return this.waitFor((m) => m.type === 'event' && m.event === event, `event ${event}`, timeoutMs);
  }

  eventsNamed(event: string): DapMessage[] {
    return this.messages.filter((m) => m.type === 'event' && m.event === event);
  }

  /** All output-event text, optionally filtered by category. */
  outputText(category?: string): string {
    return this.eventsNamed('output')
      .filter((e) => category === undefined || (e.body as Record<string, unknown> | undefined)?.category === category)
      .map((e) => (e.body as Record<string, unknown>).output as string)
      .join('');
  }

  /** Send raw bytes (framing-error tests). */
  writeRaw(chunk: Buffer): void {
    this.toServer.write(chunk);
  }

  /** End the transport; the adapter tears its backend down on 'end'. */
  close(): void {
    this.toServer.end();
    this.fromServer.end();
  }
}
