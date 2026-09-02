// PRD: §6.7 — DBusChannel frame protocol: length-prefixed JSON frames pushed by
// the breadesp-dbus QEMU device. Unit tests use a fake device client (raw socket)
// so no QEMU binary is needed.
import { afterAll, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import type { BusTransaction } from '@breadesp/peripherals';
import { DBusChannel } from '../src/qemu/DBusChannel.js';

const openSockets: Socket[] = [];
const openChannels: DBusChannel[] = [];

afterAll(async () => {
  for (const sock of openSockets) sock.destroy();
  await Promise.all(openChannels.map((c) => c.close().catch(() => {})));
});

/** Build the wire frame the device emits: <uint32 LE len> <payload>. */
function frame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Connect a fake breadesp-dbus device to the listening channel. */
function fakeDevice(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => resolve(sock));
    sock.on('error', reject);
    openSockets.push(sock);
  });
}

interface Fixture {
  channel: DBusChannel;
  txs: BusTransaction[];
  device: Socket;
}

async function fixture(payloads: string[]): Promise<Fixture> {
  const channel = new DBusChannel();
  const txs: BusTransaction[] = [];
  channel.onTransaction((tx) => txs.push(tx));
  await channel.listen({});
  openChannels.push(channel);
  // The device connects at realize, then pushes frames on the same socket.
  const device = await fakeDevice(channel.port);
  for (const p of payloads) device.write(frame(p));
  return { channel, txs, device };
}

describe('DBusChannel (PRD §6.7 frame protocol)', () => {
  it('deserializes i2c and gpio transactions from a single frame', async () => {
    const { txs } = await fixture([
      '{"v":1,"tx":[' +
        '{"kind":"i2c","bus":0,"target":60,"dir":"write","ts":1042000,"data":[0,174]},' +
        '{"kind":"gpio","bus":0,"target":2,"dir":"write","ts":2097000,"data":[1]}' +
      ']}',
    ]);
    await waitUntil(() => txs.length >= 2);
    // ts: the device emits virtual-clock nanoseconds, the contract is milliseconds.
    expect(txs).toEqual([
      {
        kind: 'i2c', bus: 0, target: 0x3c, dir: 'write',
        ts: 1.042, data: Uint8Array.from([0x00, 0xae]),
      },
      {
        kind: 'gpio', bus: 0, target: 2, dir: 'write',
        ts: 2.097, data: Uint8Array.from([1]),
      },
    ]);
  });

  it('deserializes a pwm transaction (P2.3 LEDC tone frame)', async () => {
    const { txs } = await fixture([
      '{"v":1,"tx":[' +
        '{"kind":"pwm","bus":0,"target":4,"dir":"write","ts":3000000,"data":[224,171,0,0,244,1]}' +
      ']}',
    ]);
    await waitUntil(() => txs.length >= 1);
    expect(txs).toEqual([
      {
        kind: 'pwm', bus: 0, target: 4, dir: 'write',
        ts: 3, data: Uint8Array.from([0xe0, 0xab, 0, 0, 0xf4, 0x01]),
      },
    ]);
  });

  it('deserializes an i2s transaction (P2.4 DMA PCM frame)', async () => {
    const { txs } = await fixture([
      '{"v":1,"tx":[' +
        '{"kind":"i2s","bus":0,"dir":"write","ts":4000000,"data":[103,65,0,0,16,2,1,0,0,128]}' +
      ']}',
    ]);
    await waitUntil(() => txs.length >= 1);
    expect(txs).toEqual([
      {
        kind: 'i2s', bus: 0, dir: 'write',
        ts: 4, data: Uint8Array.from([0x67, 0x41, 0, 0, 16, 2, 1, 0, 0, 128]),
      },
    ]);
  });

  it('reassembles frames split across TCP segment boundaries', async () => {
    const payload =
      '{"v":1,"tx":[{"kind":"i2c","bus":0,"target":60,"dir":"read","length":4,"ts":500000}]}';
    const whole = frame(payload);
    const { txs, channel, device } = await fixture([]);
    // Byte-dribble: separate macrotasks so the chunks arrive as distinct events.
    device.write(whole.subarray(0, 1));
    await delay(10);
    device.write(whole.subarray(1, 3));
    await delay(10);
    device.write(whole.subarray(3));
    await waitUntil(() => txs.length > 0);
    expect(txs).toEqual([
      {
        kind: 'i2c', bus: 0, target: 0x3c, dir: 'read',
        ts: 0.5, data: new Uint8Array(0), length: 4,
      },
    ]);
    expect(channel.port).toBeGreaterThan(0);
  });

  it('tolerates a malformed payload and keeps processing later frames', async () => {
    const { txs } = await fixture([
      '{"v":1,"tx":[{"kind":"gpio",', // truncated JSON: dropped, stream continues
      '{"v":1,"tx":[{"kind":"gpio","bus":0,"target":2,"dir":"write","ts":1000,"data":[0]}]}',
    ]);
    await waitUntil(() => txs.length >= 1);
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ kind: 'gpio', target: 2, ts: 0.001 });
  });

  it('drops frames with an unknown protocol version', async () => {
    const { txs } = await fixture([
      '{"v":2,"tx":[{"kind":"gpio","bus":0,"target":2,"dir":"write","ts":1,"data":[0]}]}',
    ]);
    expect(txs).toHaveLength(0);
  });

  it('drops transactions with missing required fields', async () => {
    const { txs } = await fixture([
      '{"v":1,"tx":[{"kind":"i2c","bus":0,"dir":"write","ts":1,"data":[]},' +
      '{"kind":"i2c","bus":0,"target":60,"dir":"none","ts":1}]}',
    ]);
    expect(txs).toHaveLength(0);
  });

  it('requires the handler before listening and rejects double listen', async () => {
    const channel = new DBusChannel();
    await expect(channel.listen({})).rejects.toThrow(/onTransaction/);
    channel.onTransaction(() => {});
    await channel.listen({});
    openChannels.push(channel);
    await expect(channel.listen({})).rejects.toThrow(/already listening/);
  });

  it('destroys the connection on an oversized length prefix', async () => {
    const { txs, device } = await fixture([]);
    const bad = Buffer.alloc(4);
    bad.writeUInt32LE(0xffffffff, 0);
    device.write(bad);
    device.write(Buffer.alloc(8, 0x78));
    await new Promise((r) => setTimeout(r, 50));
    expect(txs).toHaveLength(0);
    expect(device.destroyed).toBe(true);
  });
});

function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) resolve();
      else if (Date.now() - t0 > timeoutMs) reject(new Error('waitUntil timeout'));
      else setTimeout(tick, 10);
    };
    tick();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
