// PRD: §4.2, §6.7, §F-BB-3 — dev-plan task P3.4 acceptance (end-to-end, knob):
// boots knob.elf on the breadesp-dbus QEMU; the firmware polls GPIO_IN and
// decodes a quadrature pair on A=GPIO4 / B=GPIO16 into a signed transition
// count. Rotating the UI-side knob model plays Gray transitions through
// PeripheralManager -> DBusChannel.sendInject ({"kind":"gpio-in",...}) onto the
// device's GPIO_IN overlay. Two CW detents print KNOB CW; two CCW detents back
// print KNOB ZERO.
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
const FIXTURE_ELF = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'knob.elf');

const QEMU_DBUS_BIN = resolveDbusQemuBin();

registerBuiltins();

// knob1 A -> GPIO4, B -> GPIO16 (the pins knob.elf decodes).
const NETLIST: Netlist = {
  version: 1,
  chip: 'esp32',
  peripherals: [{ instanceId: 'knob1', kind: 'knob', props: { stepMs: 5 } }],
  wires: [
    { id: 'w1', from: { instanceId: 'knob1', pin: 'A' }, to: { instanceId: 'mcu', pin: 'GPIO4' } },
    { id: 'w2', from: { instanceId: 'mcu', pin: 'GPIO16' }, to: { instanceId: 'knob1', pin: 'B' } },
  ],
};

async function waitForUart(runner: QemuRunner, marker: string, timeoutMs: number): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const uart = runner.getUartLog();
    if (uart.includes(marker)) return uart;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`expected UART '${marker}' within ${timeoutMs}ms. status=${runner.getStatus()} uart=${JSON.stringify(uart)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(QEMU_DBUS_BIN === null)('knob GPIO input e2e (P3.4 acceptance, real QEMU-ESP32)', () => {
  it('firmware decodes the injected quadrature sequence into detent counts', async () => {
    const manager = new PeripheralManager();

    const dbus = new DBusChannel();
    dbus.onTransaction(() => {}); // this scenario only injects, nothing forwarded is consumed
    await dbus.listen({}); // ephemeral TCP port on 127.0.0.1

    // knob -> device: PeripheralManager 'inject' events ride the reverse channel.
    manager.on('inject', (inj: PeripheralInjection) => { dbus.sendInject(inj); });

    const runner = new QemuRunner();
    try {
      // The device connects out during its realize, so listening must precede load().
      await runner.load({
        firmwareElf: FIXTURE_ELF,
        chip: 'esp32',
        qemuBin: needDbusQemuBin(),
        dbus: { port: dbus.port },
      });
      // Apply the netlist before start. The constructor's rest-state sync runs
      // before the device connects (realize happens in load), so those two
      // frames are dropped — harmless: the device reset state is the same (0,0).
      manager.applyNetlist(NETLIST);
      await runner.start();

      // Two clockwise detents -> +8 transitions -> KNOB CW.
      manager.driveRotate('knob1', 2);
      await waitForUart(runner, 'KNOB CW', 30000);

      // Two counter-clockwise detents -> back to 0 -> KNOB ZERO.
      manager.driveRotate('knob1', -2);
      const uart = await waitForUart(runner, 'KNOB ZERO', 30000);
      expect(uart.indexOf('KNOB CW')).toBeLessThan(uart.indexOf('KNOB ZERO'));
    } finally {
      await runner.stop().catch(() => {});
      await dbus.close();
      manager.dispose();
    }
  }, 60000);
});
