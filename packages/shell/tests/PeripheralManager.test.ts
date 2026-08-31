// PRD: §4.2 — PeripheralManager routing integration (dev-plan §7.2): applyNetlist
// builds instances, route() delivers transactions through NetlistResolver only to
// the wired/matching peripheral. Uses the real builtin factories; routing outcome
// is observed via the 'snapshot' events each model emits.
import { describe, expect, it } from 'vitest';
import type { Netlist } from '@breadesp/netlist';
import type { BusTransaction, RenderSnapshot } from '@breadesp/peripherals';
import { registerBuiltins } from '@breadesp/peripherals';
import { PeripheralManager } from '../src/peripherals/PeripheralManager.js';

registerBuiltins();

const LED_ON_GPIO2: Netlist = {
  version: 1,
  chip: 'esp32',
  peripherals: [
    { instanceId: 'oled1', kind: 'ssd1306', props: { address: 0x3c } },
    { instanceId: 'led1', kind: 'led' },
  ],
  wires: [
    { id: 'w-sda', from: { instanceId: 'oled1', pin: 'SDA' }, to: { instanceId: 'mcu', pin: 'GPIO21' } },
    { id: 'w-led', from: { instanceId: 'led1', pin: 'A' }, to: { instanceId: 'mcu', pin: 'GPIO2' } },
  ],
};

function i2cWrite(): BusTransaction {
  // SSD1306-style frame: control byte 0x00 (command stream) + display-off 0xAE.
  return { kind: 'i2c', bus: 0, target: 0x3c, dir: 'write', data: Uint8Array.from([0x00, 0xae]), ts: 5 };
}

function gpioWrite(pin: number, level: 0 | 1): BusTransaction {
  return { kind: 'gpio', bus: 0, target: pin, dir: 'write', data: Uint8Array.from([level]), ts: 6 };
}

function managerWith(netlist: Netlist): { manager: PeripheralManager; snapshots: RenderSnapshot[] } {
  const manager = new PeripheralManager();
  const snapshots: RenderSnapshot[] = [];
  manager.on('snapshot', (s: RenderSnapshot) => snapshots.push(s));
  manager.applyNetlist(netlist);
  return { manager, snapshots };
}

function isLevel(s: RenderSnapshot, level: number): boolean {
  return s.type === 'level' && 'level' in s.payload && s.payload.level === level;
}

describe('PeripheralManager routing (PRD §4.2, dev-plan P1.4)', () => {
  it('delivers an I2C write to oled1 only (OLED transactions land on oled1)', () => {
    const { manager, snapshots } = managerWith(LED_ON_GPIO2);
    manager.route(i2cWrite());

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ instanceId: 'oled1', type: 'pixels' });
    expect(snapshots[0].payload).toMatchObject({ width: 128, height: 64, format: 'mono' });
  });

  it('delivers a GPIO write only to the peripheral wired to that pin', () => {
    const { manager, snapshots } = managerWith(LED_ON_GPIO2);
    manager.route(gpioWrite(2, 1));
    manager.route(gpioWrite(3, 1)); // unwired pin: no recipient

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ instanceId: 'led1', type: 'level' });
    expect(isLevel(snapshots[0], 1)).toBe(true);
  });

  it('keeps I2C traffic away from the LED and GPIO traffic away from the OLED', () => {
    const { manager, snapshots } = managerWith(LED_ON_GPIO2);
    manager.route(i2cWrite());
    manager.route(gpioWrite(2, 1));
    manager.route(gpioWrite(2, 0));

    const byInstance = snapshots.reduce<Record<string, string[]>>((acc, s) => {
      (acc[s.instanceId] ??= []).push(s.type);
      return acc;
    }, {});
    expect(byInstance['oled1']).toEqual(['pixels']);
    expect(byInstance['led1']).toEqual(['level', 'level']);
  });

  it('drops all routing when the netlist is re-applied without wires', () => {
    const { manager, snapshots } = managerWith(LED_ON_GPIO2);
    manager.route(gpioWrite(2, 1));
    expect(snapshots).toHaveLength(1);

    manager.applyNetlist({ version: 1, chip: 'esp32', peripherals: LED_ON_GPIO2.peripherals, wires: [] });
    manager.route(gpioWrite(2, 0));
    manager.route(i2cWrite());
    // GPIO lost its wire; the OLED keeps routing by address (wire matrix cannot
    // bind an MCU pin to an I2C controller, PRD §6.5).
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toMatchObject({ instanceId: 'oled1', type: 'pixels' });
  });

  it('throws on an unknown peripheral kind', () => {
    const manager = new PeripheralManager();
    expect(() =>
      manager.applyNetlist({ version: 1, chip: 'esp32', peripherals: [{ instanceId: 'x1', kind: 'nope' }], wires: [] }),
    ).toThrow('Unknown peripheral kind: nope');
  });

  it('routing before any netlist is applied is a no-op', () => {
    const manager = new PeripheralManager();
    expect(() => manager.route(i2cWrite())).not.toThrow();
  });
});
