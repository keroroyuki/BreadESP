// PRD: §F-DBG-6 — Debug Adapter Protocol wire framing (dev-plan task P4.5).
// DAP messages are JSON objects transported with HTTP-style headers; the only
// mandatory header is `Content-Length` (bytes of the UTF-8 body). Implemented
// by hand to keep the runtime dependency set of PRD §5 unchanged.
//
// References: https://microsoft.github.io/debug-adapter-protocol/

/** Serialize one DAP message into a complete wire frame. */
export function encodeDapMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const head = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([head, body]);
}

/**
 * Incremental decoder for the DAP wire format. Feed raw transport chunks in
 * (bytes, not chars — the body length counts UTF-8 bytes) and collect the
 * fully received messages. Throws on malformed headers; the session treats
 * that as fatal (the stream is unrecoverable without a resync point).
 */
export class DapFrameDecoder {
  private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  /** Append one transport chunk; returns every message that became complete. */
  push(chunk: Buffer): object[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const messages: object[] = [];
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return messages;
      const contentLength = parseContentLength(this.buf.subarray(0, headerEnd));
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + contentLength) return messages;
      const body = this.buf.subarray(bodyStart, bodyStart + contentLength);
      this.buf = this.buf.subarray(bodyStart + contentLength);
      messages.push(JSON.parse(body.toString('utf8')) as object);
    }
  }
}

/** Extract `Content-Length` from a header block; unknown headers are ignored. */
function parseContentLength(headerBlock: Buffer): number {
  const headers = headerBlock.toString('ascii').split('\r\n');
  for (const line of headers) {
    const sep = line.indexOf(':');
    if (sep < 0) continue;
    if (line.slice(0, sep).trim().toLowerCase() !== 'content-length') continue;
    const value = Number(line.slice(sep + 1).trim());
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`[BB-132] malformed DAP Content-Length header: ${JSON.stringify(line)}`);
    }
    return value;
  }
  throw new Error('[BB-132] DAP frame is missing its Content-Length header');
}
