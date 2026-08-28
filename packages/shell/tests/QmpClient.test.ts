// PRD: §4.2 — QMP client behaviour: handshake, request correlation, error surfacing.
import { afterAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:net';
import { createServer } from 'node:net';
import { QmpClient, QmpError } from '../src/qemu/QmpClient.js';

const GREETING = JSON.stringify({ QMP: { version: { qemu: { micro: 0, minor: 2, major: 9 } }, capabilities: [] } }) + '\n';

interface FakeQmp {
  server: Server;
  port: number;
  /** Commands received (in order). */
  commands: string[];
  /** When true, the server answers only the handshake, then goes quiet. */
  silentAfterHandshake: boolean;
  /** When true, the server never sends the greeting. */
  muteGreeting: boolean;
}

async function startFakeQmp(opts: { silentAfterHandshake?: boolean; muteGreeting?: boolean } = {}): Promise<FakeQmp> {
  const commands: string[] = [];
  const silentAfterHandshake = opts.silentAfterHandshake === true;
  const muteGreeting = opts.muteGreeting === true;

  const server = createServer((socket) => {
    if (!muteGreeting) socket.write(GREETING);
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          // JSON.parse boundary: the client speaks QMP (JSON lines) by contract.
          const msg = JSON.parse(line) as { execute: string; id?: number };
          commands.push(msg.execute);
          if (silentAfterHandshake && msg.execute !== 'qmp_capabilities') continue;
          const reply = msg.execute === 'boom'
            ? { error: { class: 'CommandNotFound', desc: 'The command boom has not been found' }, id: msg.id }
            : { return: {}, id: msg.id };
          socket.write(JSON.stringify(reply) + '\n');
        } catch { /* ignore malformed */ }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('fake QMP server failed to report its TCP port');
  }
  return { server, port: addr.port, commands, silentAfterHandshake, muteGreeting };
}

const fakes: FakeQmp[] = [];
async function fake(opts: { silentAfterHandshake?: boolean; muteGreeting?: boolean } = {}): Promise<FakeQmp> {
  const f = await startFakeQmp(opts);
  fakes.push(f);
  return f;
}

afterAll(async () => {
  for (const f of fakes) await new Promise<void>((resolve) => f.server.close(() => resolve()));
});

describe('QmpClient', () => {
  it('completes the handshake and correlates requests by id', async () => {
    const f = await fake();
    const client = new QmpClient();
    await client.connect({ port: f.port, timeoutMs: 2000 });
    await client.cont();
    expect(f.commands).toEqual(['qmp_capabilities', 'cont']);
    client.close();
  });

  it('resolves stop/quit like any command', async () => {
    const f = await fake();
    const client = new QmpClient();
    await client.connect({ port: f.port, timeoutMs: 2000 });
    await client.stop();
    await client.quit();
    expect(f.commands).toEqual(['qmp_capabilities', 'stop', 'quit']);
    client.close();
  });

  it('rejects with the QMP error description on QMP-level failures', async () => {
    const f = await fake();
    const client = new QmpClient();
    await client.connect({ port: f.port, timeoutMs: 2000 });
    await expect(client.request('boom')).rejects.toThrow(QmpError);
    await expect(client.request('boom')).rejects.toThrow(/The command boom has not been found/);
    client.close();
  });

  it('times out when the greeting never arrives', async () => {
    const f = await fake({ muteGreeting: true });
    const client = new QmpClient();
    await expect(client.connect({ port: f.port, timeoutMs: 200 })).rejects.toThrow(/\[BB-104\] QMP greeting timeout/);
    client.close();
  });

  it('rejects in-flight requests when the socket is closed', async () => {
    const f = await fake({ silentAfterHandshake: true });
    const client = new QmpClient();
    await client.connect({ port: f.port, timeoutMs: 2000 });
    const pending = client.request('cont');
    client.close();
    await expect(pending).rejects.toThrow(/\[BB-104\]/);
  });

  it('rejects requests issued before connecting', async () => {
    const client = new QmpClient();
    await expect(client.request('cont')).rejects.toThrow(/\[BB-104\] QMP not connected/);
  });
});
