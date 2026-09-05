// PRD: §4.2, §6.7, §F-PER-7 — dev-plan task P3.1 acceptance (end-to-end):
// boots mic.elf on the breadesp-dbus QEMU; the firmware arms an I2S0 RX DMA
// in-link ring and polls the buffers. A mic peripheral instance injects a
// 440Hz sine (s16le mono, matched to the firmware's decoded 33.3kHz) through
// PeripheralManager -> DBusChannel.sendInject -> the device's reverse channel,
// whose RX walker writes the samples into the guest buffers. The firmware
// observes non-zero samples, counts 8 chunks and prints MIC OK.
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

// mic.elf receives on I2S0 (33.3kHz 16-bit mono per its CLKM/SRATE config);
// the mic claims controller 0 by factory default and injects at the matching rate.
const NETLIST: Netlist = {
  version: 1,
  chip: 'esp32',
  peripherals: [
    {
      instanceId: 'mic1',
      kind: 'mic',
      props: { waveform: 'sine', freqHz: 440, amplitude: 0.5, sampleRate: 33333, chunkMs: 20 },
    },
  ],
  wires: [],
};

describe.skipIf(QEMU_DBUS_BIN === null)('mic I2S RX e2e (P3.1 acceptance, real QEMU-ESP32)', () => {
  it('firmware reads the injected samples from the I2S RX DMA ring', async () => {
    const manager = new PeripheralManager();

    const dbus = new DBusChannel();
    dbus.onTransaction(() => {}); // RX injection needs no forward-path handling
    await dbus.listen({}); // ephemeral TCP port on 127.0.0.1

    // mic -> device: PeripheralManager 'inject' events ride the reverse channel.
    manager.on('inject', (inj: I2sInjection) => { dbus.sendInject(inj); });
    manager.applyNetlist(NETLIST);

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

      // Wait for the firmware's completion marker: MIC RDY proves the boot,
      // MIC OK proves 8 injected chunks arrived through the RX DMA ring.
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
      await runner.stop().catch(() => {});
      await dbus.close();
      manager.dispose();
    }
  }, 60000);
});
