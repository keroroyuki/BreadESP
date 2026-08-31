// PRD: §4.2, §6.3, §6.5 — dev-plan task P1.4 acceptance (end-to-end): boots
// i2c.elf on the breadesp-dbus QEMU, feeds DBusChannel transactions into
// PeripheralManager, and asserts the NetlistResolver routes the 0x3C I2C write
// to oled1 (pixels snapshot) and the GPIO2 toggles to led1 (level snapshots),
// in firmware program order. Skips when the device-enabled QEMU binary is
// absent (see tests/helpers/dbus-qemu.ts).
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
const FIXTURE_ELF = join(REPO_ROOT, 'packages', 'sim-core', 'fixtures', 'i2c.elf');

const QEMU_DBUS_BIN = resolveDbusQemuBin();

registerBuiltins();

// The netlist under test: an OLED at the default 0x3C address plus an LED wired
// to GPIO2 (the pin i2c.elf toggles). SDA/SCL wires are recorded for realism;
// I2C routing itself is address-based (PRD §6.5).
const NETLIST: Netlist = {
  version: 1,
  chip: 'esp32',
  peripherals: [
    { instanceId: 'oled1', kind: 'ssd1306', props: { address: 0x3c } },
    { instanceId: 'led1', kind: 'led' },
  ],
  wires: [
    { id: 'w-sda', from: { instanceId: 'oled1', pin: 'SDA' }, to: { instanceId: 'mcu', pin: 'GPIO21' } },
    { id: 'w-scl', from: { instanceId: 'oled1', pin: 'SCL' }, to: { instanceId: 'mcu', pin: 'GPIO22' } },
    { id: 'w-led', from: { instanceId: 'led1', pin: 'A' }, to: { instanceId: 'mcu', pin: 'GPIO2' } },
  ],
};

function isLevel(s: RenderSnapshot, level: number): boolean {
  return s.type === 'level' && 'level' in s.payload && s.payload.level === level;
}

function isPixels(s: RenderSnapshot): boolean {
  return s.type === 'pixels' && 'width' in s.payload;
}

describe.skipIf(QEMU_DBUS_BIN === null)('netlist routing e2e (P1.4 acceptance, real QEMU-ESP32)', () => {
  it('lands the OLED I2C transaction on oled1 and the GPIO2 toggles on led1', async () => {
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

      // i2c.elf program order: GPIO2 on -> I2C write 0x3C [0x00, 0xAE] -> GPIO2 off.
      const t0 = Date.now();
      let ledOn: RenderSnapshot | undefined;
      let pixels: RenderSnapshot | undefined;
      let ledOff: RenderSnapshot | undefined;
      for (;;) {
        ledOn = snapshots.find((s) => s.instanceId === 'led1' && isLevel(s, 1));
        pixels = snapshots.find((s) => s.instanceId === 'oled1' && isPixels(s));
        ledOff = snapshots.find((s) => s.instanceId === 'led1' && isLevel(s, 0));
        if (ledOn && pixels && ledOff) break;
        if (Date.now() - t0 > 30000) {
          throw new Error(
            `expected led1 on/off + oled1 pixels snapshots within 30s. status=${runner.getStatus()} ` +
              `uart=${JSON.stringify(runner.getUartLog())} snapshots=${JSON.stringify(snapshots.map((s) => [s.instanceId, s.type]))}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      // The 0x3C write rendered an SSD1306 frame on oled1.
      expect(pixels!.instanceId).toBe('oled1');
      expect(pixels!.payload).toMatchObject({ width: 128, height: 64, format: 'mono' });

      // Firmware program order survives routing: LED on -> OLED frame -> LED off.
      expect(snapshots.indexOf(ledOn!)).toBeLessThan(snapshots.indexOf(pixels!));
      expect(snapshots.indexOf(pixels!)).toBeLessThan(snapshots.indexOf(ledOff!));

      // Only wired instances produced snapshots (no broadcast leakage).
      expect(new Set(snapshots.map((s) => s.instanceId))).toEqual(new Set(['led1', 'oled1']));

      // Firmware completion marker on UART0 (independent of the routing path).
      expect(runner.getUartLog()).toContain('I2C OK');
    } finally {
      await runner.stop().catch(() => {});
      await dbus.close();
    }
  }, 60000);
});
