// PRD: §4.2, §6.7, §9 — dev-plan task P1.5 integration (dev-plan §7.2 layer):
// a burst of DBus frames flows DBusChannel -> PeripheralManager and surfaces as
// a 30fps-capped snapshot stream (leading frame + one coalesced trailing frame),
// proving the Bridge cannot flood the renderer with per-transaction snapshots.
// Uses a fake device socket (no QEMU binary needed).
import { afterAll, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import type { Netlist } from '@breadesp/netlist';
import type { RenderSnapshot } from '@breadesp/peripherals';
import { registerBuiltins } from '@breadesp/peripherals';
import { DBusChannel } from '../src/qemu/DBusChannel.js';
import { PeripheralManager } from '../src/peripherals/PeripheralManager.js';

registerBuiltins();

// OLED at the default 0x3C; I2C routing is address-based (PRD §6.5), no wires needed.
const NETLIST: Netlist = {
  version: 1,
  chip: 'esp32',
  peripherals: [{ instanceId: 'oled1', kind: 'ssd1306', props: { address: 0x3c } }],
  wires: [],
};

const openSockets: Socket[] = [];
const openChannels: DBusChannel[] = [];

afterAll(async () => {
  for (const sock of openSockets) sock.destroy();
  await Promise.all(openChannels.map((c) => c.close().catch(() => {})));
});

/** Build the wire frame the device emits: <uint32 LE len> <payload>. */
function frameOf(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

describe('DBusChannel -> PeripheralManager snapshot throttle (P1.5 integration)', () => {
  it('coalesces a 50-frame I2C burst into a 30fps snapshot stream', async () => {
    const manager = new PeripheralManager();
    const snapshots: RenderSnapshot[] = [];
    manager.on('snapshot', (s: RenderSnapshot) => snapshots.push(s));
    manager.applyNetlist(NETLIST);

    let routed = 0;
    const dbus = new DBusChannel();
    dbus.onTransaction((tx) => {
      routed++;
      manager.route(tx);
    });
    await dbus.listen({}); // ephemeral TCP port on 127.0.0.1
    openChannels.push(dbus);

    const device = await new Promise<Socket>((resolve, reject) => {
      const sock = connect(dbus.port, '127.0.0.1', () => resolve(sock));
      sock.on('error', reject);
      openSockets.push(sock);
    });

    try {
      // 50 device frames in a single write: one data event -> 50 synchronous
      // onTransaction calls -> 50 emitSnapshot calls in one macrotask.
      const oneFrame = frameOf('{"v":1,"tx":[{"kind":"i2c","bus":0,"target":60,"dir":"write","ts":100000,"data":[0,174]}]}');
      device.write(Buffer.concat(Array.from({ length: 50 }, () => oneFrame)));

      await delay(10);
      expect(routed).toBe(50); // every transaction was routed...
      expect(snapshots).toHaveLength(1); // ...but the burst collapsed into the leading frame

      await delay(120); // > one 33ms throttle window
      expect(snapshots.length).toBeGreaterThanOrEqual(2); // the trailing flush always lands
      expect(snapshots.length).toBeLessThanOrEqual(3); // ...and never exceeds 30fps cadence
      expect(snapshots.every((s) => s.instanceId === 'oled1' && s.type === 'pixels')).toBe(true);
    } finally {
      device.destroy();
    }
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}
