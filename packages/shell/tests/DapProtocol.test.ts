// PRD: §F-DBG-6 — DAP wire framing unit tests (dev-plan task P4.5): Content-
// Length roundtrip, chunk boundaries (partial headers, split bodies, coalesced
// frames), unknown headers, and malformed input handling.
import { describe, expect, it } from 'vitest';
import { DapFrameDecoder, encodeDapMessage } from '../src/debugger/dap/DapProtocol.js';

describe('DapProtocol', () => {
  it('encodes a frame with an exact Content-Length', () => {
    const frame = encodeDapMessage({ seq: 1, type: 'request', command: 'initialize' });
    const text = frame.toString('utf8');
    const m = /^Content-Length: (\d+)\r\n\r\n/.exec(text);
    expect(m).not.toBeNull();
    expect(Buffer.byteLength(text.slice(m![0].length), 'utf8')).toBe(Number(m![1]));
  });

  it('decodes a single frame written at once', () => {
    const decoder = new DapFrameDecoder();
    const messages = decoder.push(encodeDapMessage({ seq: 1, type: 'request', command: 'initialize' }));
    expect(messages).toEqual([{ seq: 1, type: 'request', command: 'initialize' }]);
  });

  it('assembles a message split across many chunks (byte-granular)', () => {
    const decoder = new DapFrameDecoder();
    const frame = encodeDapMessage({ seq: 2, type: 'event', event: 'output' });
    const collected: object[] = [];
    for (const byte of frame) {
      collected.push(...decoder.push(Buffer.from([byte])));
    }
    expect(collected).toEqual([{ seq: 2, type: 'event', event: 'output' }]);
  });

  it('coalesces several frames delivered in one chunk', () => {
    const decoder = new DapFrameDecoder();
    const a = encodeDapMessage({ seq: 1, command: 'a' });
    const b = encodeDapMessage({ seq: 2, command: 'b' });
    const messages = decoder.push(Buffer.concat([a, b]));
    expect(messages).toEqual([{ seq: 1, command: 'a' }, { seq: 2, command: 'b' }]);
  });

  it('tolerates unknown and case-insensitive headers', () => {
    const decoder = new DapFrameDecoder();
    const body = Buffer.from('{"seq":3}', 'utf8');
    const frame = Buffer.concat([
      Buffer.from('Content-Type: application/vscode-jsonrpc; charset=utf8\r\n', 'ascii'),
      Buffer.from('content-length: ', 'ascii'),
      Buffer.from(`${body.length}\r\n\r\n`, 'ascii'),
      body,
    ]);
    expect(decoder.push(frame)).toEqual([{ seq: 3 }]);
  });

  it('counts the body length in UTF-8 bytes, not characters', () => {
    const decoder = new DapFrameDecoder();
    // "µ" is 2 bytes in UTF-8: a char-count body would desync the stream.
    const messages = decoder.push(encodeDapMessage({ seq: 4, note: 'µµµ' }));
    expect(messages).toEqual([{ seq: 4, note: 'µµµ' }]);
  });

  it('leaves a partial frame in the buffer without emitting', () => {
    const decoder = new DapFrameDecoder();
    const frame = encodeDapMessage({ seq: 5 });
    const head = decoder.push(frame.subarray(0, 10));
    expect(head).toEqual([]);
    const rest = decoder.push(frame.subarray(10));
    expect(rest).toEqual([{ seq: 5 }]);
  });

  it('throws on a missing Content-Length header', () => {
    const decoder = new DapFrameDecoder();
    expect(() => decoder.push(Buffer.from('X-Junk: 1\r\n\r\n{}'))).toThrow(/\[BB-132\].*Content-Length/);
  });

  it('throws on a non-numeric Content-Length', () => {
    const decoder = new DapFrameDecoder();
    expect(() => decoder.push(Buffer.from('Content-Length: abc\r\n\r\n{}'))).toThrow(/\[BB-132\].*malformed/);
  });
});
