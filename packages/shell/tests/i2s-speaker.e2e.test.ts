// PRD: §4.2, §6.3, §6.5 — dev-plan task P2.4 acceptance (end-to-end): boots
// speaker.elf on the breadesp-dbus QEMU; the firmware streams a 1041.7Hz sine
// (16 frames/period, s16le stereo, 16.667kHz) through the I2S0 TX DMA ring.
// The device's I2S shadow decodes the clock config, walks the descriptor ring
// at the PCM byte rate and forwards i2s transactions; NetlistResolver routes
// them to spk1 by controller claim, and the speaker model emits mono Float32
// 'audio' snapshots.
// Skips when the device-enabled QEMU binary is absent (tests/helpers/dbus-qemu.ts).
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Netlist } from '@breadesp/netlist';
import type { RenderSnapshot } from '@breadesp/peripherals';
import { registerBuiltins } from '@breadesp/peripherals';
import { DBusChannel } from '../src/qemu/DBusChannel.js';
import { QemuRunner } from '../src/qemu/QemuRunner.js';
import { PeripheralManager } from '../src/peripherals/PeripheralManager.js';
import { needDbusQemuBin, resolveDbusQemuBin } from './helpers/dbus-qemu.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const FIXTURE_ELF = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'speaker.elf');

const QEMU_DBUS_BIN = resolveDbusQemuBin();

registerBuiltins();

// speaker.elf drives I2S0; the speaker claims controller 0 by factory default.
const NETLIST: Netlist = {
  version: 1,
  chip: 'esp32',
  peripherals: [{ instanceId: 'spk1', kind: 'speaker' }],
  wires: [],
};

interface AudioPayload {
  samples: number[];
  sampleRate: number;
}

function audioOf(s: RenderSnapshot): AudioPayload {
  if (s.type !== 'audio' || !('samples' in s.payload)) {
    throw new Error(`expected audio snapshot, got ${JSON.stringify(s)}`);
  }
  return s.payload as AudioPayload;
}

/** Mean frequency estimate via rising zero crossings (Hz). */
function estimateFreq(samples: number[], sampleRate: number): number {
  let crossings = 0;
  let first = -1;
  let last = -1;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] < 0 && samples[i] >= 0) {
      crossings++;
      if (first < 0) first = i;
      last = i;
    }
  }
  if (crossings < 2 || last <= first) return 0;
  return ((crossings - 1) * sampleRate) / (last - first);
}

describe.skipIf(QEMU_DBUS_BIN === null)('speaker I2S e2e (P2.4 acceptance, real QEMU-ESP32)', () => {
  it('streams the DMA sine into audio snapshots at the decoded rate', async () => {
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

      // Wait until enough audio streamed in for a stable frequency estimate.
      const t0 = Date.now();
      let chunks: AudioPayload[] = [];
      let samples: number[] = [];
      for (;;) {
        chunks = snapshots
          .filter((s) => s.instanceId === 'spk1' && s.type === 'audio')
          .map(audioOf);
        samples = chunks.flatMap((c) => c.samples);
        if (samples.length >= 4096) break;
        if (Date.now() - t0 > 30000) {
          throw new Error(
            `expected spk1 audio snapshots (>=4096 samples), got ${samples.length}. `
              + `status=${runner.getStatus()} uart=${JSON.stringify(runner.getUartLog())} `
              + `snapshots=${snapshots.length}`,
          );
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      // The decoded sample rate: 160MHz/25/12/32 = 16666.7Hz.
      const rate = chunks.at(-1)!.sampleRate;
      expect(rate).toBeGreaterThan(15_800);
      expect(rate).toBeLessThan(17_500);

      // The sine frequency: 16666.7/16 = 1041.7Hz (5% tolerance band).
      const freq = estimateFreq(samples, rate);
      expect(freq).toBeGreaterThan(1041.7 * 0.95);
      expect(freq).toBeLessThan(1041.7 * 1.05);

      // Non-trivial amplitude (0.6 full-scale sine, not silence or clipping).
      const peak = Math.max(...samples.map(Math.abs));
      expect(peak).toBeGreaterThan(0.4);
      expect(peak).toBeLessThan(0.7);

      // Only the claiming instance produced snapshots (no broadcast leakage).
      expect(new Set(snapshots.map((s) => s.instanceId))).toEqual(new Set(['spk1']));

      // Firmware marker on UART0 (independent of the routing path).
      expect(runner.getUartLog()).toContain('SPK SINE');
    } finally {
      await runner.stop().catch(() => {});
      await dbus.close();
      manager.dispose();
    }
  }, 60000);
});
