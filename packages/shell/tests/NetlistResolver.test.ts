// PRD: §4.2, §6.5 — NetlistResolver routing rules: I2C by 7-bit address
// (props.address with factory-default fallback), GPIO by MCU pin via wires.
import { describe, expect, it } from 'vitest';
import type { Netlist, Wire } from '@breadesp/netlist';
import type { BusTransaction } from '@breadesp/peripherals';
import { registerBuiltins } from '@breadesp/peripherals';
import { NetlistResolver } from '../src/netlist/NetlistResolver.js';

registerBuiltins();

function wire(id: string, from: { instanceId: string; pin: string }, to: { instanceId: string; pin: string }): Wire {
  return { id, from, to };
}

function netlist(peripherals: Netlist['peripherals'], wires: Wire[] = []): Netlist {
  return { version: 1, chip: 'esp32', peripherals, wires };
}

function i2cWrite(target: number, bus = 0): BusTransaction {
  return { kind: 'i2c', bus, target, dir: 'write', data: Uint8Array.from([0x00, 0xae]), ts: 1 };
}

function gpioWrite(pin: number): BusTransaction {
  return { kind: 'gpio', bus: 0, target: pin, dir: 'write', data: Uint8Array.from([1]), ts: 1 };
}

describe('NetlistResolver (PRD §4.2/§6.5 routing)', () => {
  it('routes an I2C transaction to the instance claiming that address', () => {
    const r = new NetlistResolver(netlist([
      { instanceId: 'oled1', kind: 'ssd1306', props: { address: 0x3c } },
      { instanceId: 'oled2', kind: 'ssd1306', props: { address: 0x3d } },
    ]));
    expect(r.resolve(i2cWrite(0x3c))).toEqual([{ instanceId: 'oled1', pin: 'SDA' }]);
  });

  it('routes I2C regardless of the controller number (bus not in the netlist yet)', () => {
    const r = new NetlistResolver(netlist([{ instanceId: 'oled1', kind: 'ssd1306', props: { address: 0x3c } }]));
    expect(r.resolve(i2cWrite(0x3c, 1))).toEqual([{ instanceId: 'oled1', pin: 'SDA' }]);
  });

  it('falls back to the factory default address when props.address is omitted', () => {
    const r = new NetlistResolver(netlist([{ instanceId: 'oled1', kind: 'ssd1306' }]));
    expect(r.resolve(i2cWrite(0x3c))).toEqual([{ instanceId: 'oled1', pin: 'SDA' }]);
  });

  it('routes I2C reads as well as writes', () => {
    const r = new NetlistResolver(netlist([{ instanceId: 'oled1', kind: 'ssd1306', props: { address: 0x3c } }]));
    const tx: BusTransaction = { kind: 'i2c', bus: 0, target: 0x3c, dir: 'read', data: new Uint8Array(0), length: 4, ts: 1 };
    expect(r.resolve(tx)).toEqual([{ instanceId: 'oled1', pin: 'SDA' }]);
  });

  it('returns [] for an address no instance claims', () => {
    const r = new NetlistResolver(netlist([{ instanceId: 'oled1', kind: 'ssd1306', props: { address: 0x3c } }]));
    expect(r.resolve(i2cWrite(0x3d))).toEqual([]);
  });

  it('ignores non-I2C instances without a usable address', () => {
    const r = new NetlistResolver(netlist([{ instanceId: 'led1', kind: 'led' }]));
    expect(r.resolve(i2cWrite(0x3c))).toEqual([]);
  });

  it('routes a GPIO transaction to the peripheral wired to that MCU pin', () => {
    const r = new NetlistResolver(netlist(
      [{ instanceId: 'led1', kind: 'led' }],
      [wire('w1', { instanceId: 'led1', pin: 'A' }, { instanceId: 'mcu', pin: 'GPIO2' })],
    ));
    expect(r.resolve(gpioWrite(2))).toEqual([{ instanceId: 'led1', pin: 'A' }]);
  });

  it('accepts the mcu endpoint on either side of the wire', () => {
    const r = new NetlistResolver(netlist(
      [{ instanceId: 'led1', kind: 'led' }],
      [wire('w1', { instanceId: 'mcu', pin: 'GPIO2' }, { instanceId: 'led1', pin: 'A' })],
    ));
    expect(r.resolve(gpioWrite(2))).toEqual([{ instanceId: 'led1', pin: 'A' }]);
  });

  it('delivers to every peripheral sharing the same MCU pin', () => {
    const r = new NetlistResolver(netlist(
      [{ instanceId: 'led1', kind: 'led' }, { instanceId: 'led2', kind: 'led' }],
      [
        wire('w1', { instanceId: 'led1', pin: 'A' }, { instanceId: 'mcu', pin: 'GPIO2' }),
        wire('w2', { instanceId: 'led2', pin: 'A' }, { instanceId: 'mcu', pin: 'GPIO2' }),
      ],
    ));
    const targets = r.resolve(gpioWrite(2));
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.instanceId).sort()).toEqual(['led1', 'led2']);
  });

  it('returns [] for an unwired GPIO pin', () => {
    const r = new NetlistResolver(netlist(
      [{ instanceId: 'led1', kind: 'led' }],
      [wire('w1', { instanceId: 'led1', pin: 'A' }, { instanceId: 'mcu', pin: 'GPIO2' })],
    ));
    expect(r.resolve(gpioWrite(3))).toEqual([]);
  });

  it('ignores peripheral-to-peripheral wires (no MCU pin)', () => {
    const r = new NetlistResolver(netlist(
      [{ instanceId: 'led1', kind: 'led' }, { instanceId: 'btn1', kind: 'button' }],
      [wire('w1', { instanceId: 'led1', pin: 'A' }, { instanceId: 'btn1', pin: '1' })],
    ));
    expect(r.resolve(gpioWrite(2))).toEqual([]);
  });

  it('does not route spi/pwm/i2s/adc transactions yet', () => {
    const r = new NetlistResolver(netlist(
      [{ instanceId: 'oled1', kind: 'ssd1306', props: { address: 0x3c } }],
      [wire('w1', { instanceId: 'oled1', pin: 'SDA' }, { instanceId: 'mcu', pin: 'GPIO21' })],
    ));
    for (const kind of ['spi', 'pwm', 'i2s', 'adc'] as const) {
      const tx: BusTransaction = { kind, bus: 0, target: 1, dir: 'write', data: new Uint8Array(1), ts: 1 };
      expect(r.resolve(tx)).toEqual([]);
    }
  });

  it('rebuilds routing when the netlist is replaced', () => {
    const r = new NetlistResolver(netlist(
      [{ instanceId: 'led1', kind: 'led' }],
      [wire('w1', { instanceId: 'led1', pin: 'A' }, { instanceId: 'mcu', pin: 'GPIO2' })],
    ));
    expect(r.resolve(gpioWrite(2))).toHaveLength(1);

    r.setNetlist(netlist(
      [{ instanceId: 'led1', kind: 'led' }],
      [wire('w1', { instanceId: 'led1', pin: 'A' }, { instanceId: 'mcu', pin: 'GPIO3' })],
    ));
    expect(r.resolve(gpioWrite(2))).toEqual([]);
    expect(r.resolve(gpioWrite(3))).toEqual([{ instanceId: 'led1', pin: 'A' }]);
  });

  it('routes nothing for an empty netlist', () => {
    const r = new NetlistResolver(netlist([]));
    expect(r.resolve(i2cWrite(0x3c))).toEqual([]);
    expect(r.resolve(gpioWrite(2))).toEqual([]);
  });
});
