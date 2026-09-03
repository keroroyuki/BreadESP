// PRD: §4.2, §6.3, §F-PER-8 — dev-plan task P2.5 acceptance (end-to-end):
// boots blink.elf on the breadesp-dbus QEMU; the firmware toggles GPIO2
// forever via OUT_W1TS/OUT_W1TC. The device's GPIO shadow emits a gpio
// transaction per level change, NetlistResolver routes them over the GPIO2
// wire to scope1's CH1, and the oscilloscope model emits 'waveform' snapshots
// whose edges reconstruct the blink square wave.
// Skips when the device-enabled QEMU binary is absent (tests/helpers/dbus-qemu.ts).
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Netlist } from '@breadesp/netlist';
import type { RenderSnapshot, WaveformPayload } from '@breadesp/peripherals';
import { registerBuiltins } from '@breadesp/peripherals';
import { DBusChannel } from '../src/qemu/DBusChannel.js';
import { QemuRunner } from '../src/qemu/QemuRunner.js';
import { PeripheralManager } from '../src/peripherals/PeripheralManager.js';
import { needDbusQemuBin, resolveDbusQemuBin } from './helpers/dbus-qemu.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const FIXTURE_ELF = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'blink.elf');

const QEMU_DBUS_BIN = resolveDbusQemuBin();

registerBuiltins();

// blink.elf toggles GPIO2; the scope's CH1 probe is wired to it. The busy-loop
// half-period is ~0.4s of virtual time (DELAY_ITER=0x02ffffff at 240MHz), so
// the window is widened to 5s to hold enough edges for the period measurement.
const NETLIST: Netlist = {
  version: 1,
  chip: 'esp32',
  peripherals: [{ instanceId: 'scope1', kind: 'oscilloscope', props: { windowMs: 5000 } }],
  wires: [
    { id: 'w-ch1', from: { instanceId: 'scope1', pin: 'CH1' }, to: { instanceId: 'mcu', pin: 'GPIO2' } },
  ],
};

function waveformOf(s: RenderSnapshot): WaveformPayload {
  if (s.type !== 'waveform' || !('channels' in s.payload)) {
    throw new Error(`expected waveform snapshot, got ${JSON.stringify(s)}`);
  }
  return s.payload as WaveformPayload;
}

describe.skipIf(QEMU_DBUS_BIN === null)('oscilloscope GPIO e2e (P2.5 acceptance, real QEMU-ESP32)', () => {
  it('captures the GPIO2 blink as a regular square wave on CH1', async () => {
    const snapshots: RenderSnapshot[] = [];
    const manager = new PeripheralManager();
    manager.on('snapshot', (s: RenderSnapshot) => snapshots.push(s));
    manager.applyNetlist(NETLIST);

    const dbus = new DBusChannel();
    dbus.onTransaction((tx) => manager.route(tx));
    await dbus.listen({}); // ephemeral TCP port on 127.0.0.1

    const runner = new QemuRunner();
    try {
      // The device connects out during its realize, so listening must precede load().
      await runner.load({
        firmwareElf: FIXTURE_ELF,
        chip: 'esp32',
        qemuBin: needDbusQemuBin(),
        dbus: { port: dbus.port },
      });
      await runner.start();

      // Wait until a waveform window holds enough edges to measure the period.
      const t0 = Date.now();
      let wf: WaveformPayload | undefined;
      for (;;) {
        const wfs = snapshots
          .filter((s) => s.instanceId === 'scope1' && s.type === 'waveform')
          .map(waveformOf);
        wf = wfs.at(-1);
        const edges = wf?.channels.find((c) => c.label === 'CH1')?.edges ?? [];
        if (edges.length >= 6) break;
        if (Date.now() - t0 > 30000) {
          throw new Error(
            `expected scope1 CH1 waveform with >=6 edges, got ${JSON.stringify(wf)}. `
              + `status=${runner.getStatus()} uart=${JSON.stringify(runner.getUartLog())} `
              + `snapshots=${snapshots.length}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      const ch1 = wf!.channels.find((c) => c.label === 'CH1')!;
      // Every edge sits inside the window, levels strictly alternate.
      for (const e of ch1.edges) {
        expect(e.t).toBeGreaterThanOrEqual(0);
        expect(e.t).toBeLessThanOrEqual(wf!.windowMs);
      }
      for (let i = 1; i < ch1.edges.length; i++) {
        expect(ch1.edges[i].level).not.toBe(ch1.edges[i - 1].level);
      }
      // The blink busy loop is symmetric: edge spacing is regular. Virtual
      // timestamps quantize, so allow a 10% band around the median spacing.
      const ts = ch1.edges.map((e) => e.t);
      const deltas = ts.slice(1).map((t, i) => t - ts[i]).filter((d) => d > 0);
      const median = deltas.sort((a, b) => a - b)[Math.floor(deltas.length / 2)];
      expect(median).toBeGreaterThan(0);
      for (const d of deltas) {
        expect(Math.abs(d - median) / median).toBeLessThan(0.1);
      }

      // Only the wired instance produced snapshots (no broadcast leakage).
      expect(new Set(snapshots.map((s) => s.instanceId))).toEqual(new Set(['scope1']));

      // Firmware marker on UART0 (independent of the routing path).
      expect(runner.getUartLog()).toContain('Hello ESP32');
    } finally {
      await runner.stop().catch(() => {});
      await dbus.close();
      manager.dispose();
    }
  }, 60000);
});
