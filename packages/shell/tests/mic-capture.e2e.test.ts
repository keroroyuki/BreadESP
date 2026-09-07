// PRD: §4.2, §6.7, §F-PER-7 — dev-plan task P3.2 acceptance (end-to-end):
// boots mic.elf on the breadesp-dbus QEMU; the firmware arms an I2S0 RX DMA
// in-link ring and polls the buffers. Instead of the synth waveform, the mic
// instance is fed host-capture-shaped chunks — 48kHz mono Float32 pushed via
// PeripheralManager.feedCapture, exactly what the renderer's MicCapture engine
// sends over per:captureChunk — which the model resamples to the configured
// 33.3kHz and injects over the reverse channel. The firmware observes non-zero
// samples and prints MIC OK, proving the capture -> resample -> inject ->
// device -> firmware chain.
// Skips when the device-enabled QEMU binary is absent (tests/helpers/dbus-qemu.ts).
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Netlist } from '@breadesp/netlist';
import type { I2sInjection } from '@breadesp/peripherals';
import { registerBuiltins } from '@breadesp/peripherals';
import { DBusChannel } from '../src/qemu/DBusChannel.js';
import { QemuRunner } from '../src/qemu/QemuRunner.js';
import { PeripheralManager } from '../src/peripherals/PeripheralManager.js';
import { needDbusQemuBin, resolveDbusQemuBin } from './helpers/dbus-qemu.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const FIXTURE_ELF = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'mic.elf');

const QEMU_DBUS_BIN = resolveDbusQemuBin();

registerBuiltins();

// The renderer captures at the AudioContext's native rate (48kHz typical);
// the mic model resamples to the firmware's 33.3kHz before injecting.
const HOST_RATE = 48000;
const FEED_MS = 20;

const NETLIST: Netlist = {
  version: 1,
  chip: 'esp32',
  peripherals: [
    {
      instanceId: 'mic1',
      kind: 'mic',
      // waveform 'silence' proves the samples come from capture, not synth.
      props: { waveform: 'silence', sampleRate: 33333, chunkMs: 20 },
    },
  ],
  wires: [],
};

describe.skipIf(QEMU_DBUS_BIN === null)('mic local capture e2e (P3.2 acceptance, real QEMU-ESP32)', () => {
  it('firmware reads host-captured (resampled) samples from the I2S RX DMA ring', async () => {
    const manager = new PeripheralManager();

    const dbus = new DBusChannel();
    dbus.onTransaction(() => {}); // RX injection needs no forward-path handling
    await dbus.listen({}); // ephemeral TCP port on 127.0.0.1

    // mic -> device: PeripheralManager 'inject' events ride the reverse channel.
    manager.on('inject', (inj: I2sInjection) => { dbus.sendInject(inj); });
    manager.applyNetlist(NETLIST);

    // Feed host-capture-shaped chunks: FEED_MS of 440Hz sine at 48kHz per push,
    // exactly the payload shape the renderer's MicCapture engine produces.
    let phase = 0;
    const feed = setInterval(() => {
      const frames = (HOST_RATE * FEED_MS) / 1000;
      const samples: number[] = [];
      for (let i = 0; i < frames; i++) {
        samples.push(0.5 * Math.sin(2 * Math.PI * phase));
        phase = (phase + 440 / HOST_RATE) % 1;
      }
      manager.feedCapture('mic1', { rate: HOST_RATE, samples });
    }, FEED_MS);

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

      // MIC OK proves 8 captured-and-resampled chunks arrived through the RX
      // DMA ring; the synth fallback ('silence') could never produce them.
      const t0 = Date.now();
      for (;;) {
        const uart = runner.getUartLog();
        if (uart.includes('MIC OK')) break;
        if (Date.now() - t0 > 30000) {
          throw new Error(
            `expected UART 'MIC OK' within 30s. status=${runner.getStatus()} uart=${JSON.stringify(uart)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      const uart = runner.getUartLog();
      expect(uart).toContain('MIC RDY');
      expect(uart.indexOf('MIC RDY')).toBeLessThan(uart.indexOf('MIC OK'));
    } finally {
      clearInterval(feed);
      await runner.stop().catch(() => {});
      await dbus.close();
      manager.dispose();
    }
  }, 60000);
});
