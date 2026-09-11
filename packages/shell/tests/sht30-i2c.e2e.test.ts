// PRD: §4.2, §6.7, §F-BB-3 — dev-plan task P3.4 acceptance (end-to-end, SHT30):
// boots sht.elf on the breadesp-dbus QEMU; the firmware issues a SHT30
// measurement command (0x2C06) to 0x44 on I2C0, then retries 6-byte reads until
// the readout matches the expected 25.0°C/50%RH vector. The command write
// reaches the sht30 model via the forward channel; the model's i2c-out reply
// (PeripheralManager -> DBusChannel.sendInject) fills the device mailbox the
// I2C sniffer serves to the firmware's master reads. Match prints SHT OK.
// Skips when the device-enabled QEMU binary is absent (tests/helpers/dbus-qemu.ts).
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Netlist } from '@breadesp/netlist';
import type { PeripheralInjection } from '@breadesp/peripherals';
import { registerBuiltins } from '@breadesp/peripherals';
import { DBusChannel } from '../src/qemu/DBusChannel.js';
import { QemuRunner } from '../src/qemu/QemuRunner.js';
import { PeripheralManager } from '../src/peripherals/PeripheralManager.js';
import { needDbusQemuBin, resolveDbusQemuBin } from './helpers/dbus-qemu.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const FIXTURE_ELF = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'sht.elf');

const QEMU_DBUS_BIN = resolveDbusQemuBin();

registerBuiltins();

// I2C routes by 7-bit address (props.address), not by wires (NetlistResolver
// i2c rule); 25.0°C / 50%RH matches the vector sht.elf expects.
const NETLIST: Netlist = {
  version: 1,
  chip: 'esp32',
  peripherals: [{ instanceId: 'sht1', kind: 'sht30', props: { temperatureC: 25, humidityRh: 50 } }],
  wires: [],
};

describe.skipIf(QEMU_DBUS_BIN === null)('SHT30 I2C read reply e2e (P3.4 acceptance, real QEMU-ESP32)', () => {
  it('firmware reads the model-supplied measurement through the I2C reply mailbox', async () => {
    const manager = new PeripheralManager();

    const dbus = new DBusChannel();
    const managerTx = (tx: Parameters<PeripheralManager['route']>[0]) => manager.route(tx);
    dbus.onTransaction(managerTx); // forward path: command writes reach the model
    await dbus.listen({}); // ephemeral TCP port on 127.0.0.1

    // sht30 -> device: i2c-out replies ride the reverse channel.
    manager.on('inject', (inj: PeripheralInjection) => { dbus.sendInject(inj); });
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

      const t0 = Date.now();
      for (;;) {
        const uart = runner.getUartLog();
        if (uart.includes('SHT OK')) break;
        if (uart.includes('SHT FAIL')) {
          throw new Error(`firmware exhausted its read retries: ${JSON.stringify(uart)}`);
        }
        if (Date.now() - t0 > 30000) {
          throw new Error(`expected UART 'SHT OK' within 30s. status=${runner.getStatus()} uart=${JSON.stringify(uart)}`);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(runner.getUartLog()).not.toContain('SHT FAIL');
    } finally {
      await runner.stop().catch(() => {});
      await dbus.close();
      manager.dispose();
    }
  }, 60000);
});
