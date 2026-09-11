// PRD: §4.2, §6.5 — NetlistResolver routing rules: I2C by 7-bit address
// (props.address with factory-default fallback), SPI by CS line index
// (props.cs with factory-default fallback, dev-plan P2.1), GPIO by MCU pin
// via wires.
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

function spiWrite(cs: number, bus = 0): BusTransaction {
  return { kind: 'spi', bus, target: cs, dir: 'write', data: Uint8Array.from([0x2a]), ts: 1 };
}

function pwmWrite(pin: number): BusTransaction {
  // LEDC-decoded tone on a GPIO (dev-plan P2.3): freq centi-Hz + duty permille.
  return { kind: 'pwm', bus: 0, target: pin, dir: 'write', data: Uint8Array.from([0xe0, 0xab, 0, 0, 0xf4, 0x01]), ts: 1 };
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

  it('routes an SPI transaction to the instance claiming that CS line', () => {
    const r = new NetlistResolver(netlist([
      { instanceId: 'tft1', kind: 'st7789', props: { cs: 1 } },
      { instanceId: 'tft2', kind: 'st7789', props: { cs: 2 } },
    ]));
    expect(r.resolve(spiWrite(1))).toEqual([{ instanceId: 'tft1', pin: 'CS' }]);
  });

  it('routes SPI regardless of the controller number (bus not in the netlist)', () => {
    const r = new NetlistResolver(netlist([{ instanceId: 'tft1', kind: 'st7789', props: { cs: 1 } }]));
    expect(r.resolve(spiWrite(1, 1))).toEqual([{ instanceId: 'tft1', pin: 'CS' }]);
  });

  it('falls back to the factory default CS when props.cs is omitted', () => {
    const r = new NetlistResolver(netlist([{ instanceId: 'tft1', kind: 'st7789' }]));
    expect(r.resolve(spiWrite(0))).toEqual([{ instanceId: 'tft1', pin: 'CS' }]);
  });

  it('returns [] for a CS line no instance claims', () => {
    const r = new NetlistResolver(netlist([{ instanceId: 'tft1', kind: 'st7789', props: { cs: 1 } }]));
    expect(r.resolve(spiWrite(2))).toEqual([]);
  });

  it('rejects an out-of-range SPI CS claim (0-2 only)', () => {
    const r = new NetlistResolver(netlist([{ instanceId: 'tft1', kind: 'st7789', props: { cs: 3 } }]));
    expect(r.resolve(spiWrite(3))).toEqual([]);
  });

  it('does not route SPI to a kind without an spi-cs pin role', () => {
    // e.g. an LED with a stray numeric 'cs' prop must not claim SPI traffic.
    const r = new NetlistResolver(netlist([{ instanceId: 'led1', kind: 'led', props: { cs: 1 } }]));
    expect(r.resolve(spiWrite(1))).toEqual([]);
  });

  it('routes a pwm transaction by GPIO wire like a gpio write (P2.3)', () => {
    const r = new NetlistResolver(netlist(
      [{ instanceId: 'buzz1', kind: 'buzzer' }],
      [wire('w1', { instanceId: 'buzz1', pin: '+' }, { instanceId: 'mcu', pin: 'GPIO4' })],
    ));
    expect(r.resolve(pwmWrite(4))).toEqual([{ instanceId: 'buzz1', pin: '+' }]);
    expect(r.resolve(pwmWrite(5))).toEqual([]); // unwired pin
  });

  it('routes an i2s transaction to the instance claiming that controller (P2.4)', () => {
    const r = new NetlistResolver(netlist([
      { instanceId: 'spk1', kind: 'speaker', props: { bus: 1 } },
      { instanceId: 'spk2', kind: 'speaker' }, // factory default bus 0
    ]));
    const tx = (bus: number): BusTransaction => ({ kind: 'i2s', bus, dir: 'write', data: new Uint8Array(8), ts: 1 });
    expect(r.resolve(tx(1))).toEqual([{ instanceId: 'spk1', pin: 'DIN' }]);
    expect(r.resolve(tx(0))).toEqual([{ instanceId: 'spk2', pin: 'DIN' }]);
  });

  it('falls back to the factory default I2S bus when props.bus is omitted', () => {
    const r = new NetlistResolver(netlist([{ instanceId: 'spk1', kind: 'speaker' }]));
    const tx: BusTransaction = { kind: 'i2s', bus: 0, dir: 'write', data: new Uint8Array(8), ts: 1 };
    expect(r.resolve(tx)).toEqual([{ instanceId: 'spk1', pin: 'DIN' }]);
  });

  it('returns [] for an I2S bus no instance claims and rejects out-of-range claims', () => {
    const r = new NetlistResolver(netlist([{ instanceId: 'spk1', kind: 'speaker', props: { bus: 5 } }]));
    const tx: BusTransaction = { kind: 'i2s', bus: 0, dir: 'write', data: new Uint8Array(8), ts: 1 };
    expect(r.resolve(tx)).toEqual([]);
  });

  it('does not route i2s to a kind without an i2s-data-in pin role', () => {
    // e.g. an LED with a stray numeric 'bus' prop must not claim I2S traffic.
    const r = new NetlistResolver(netlist([{ instanceId: 'led1', kind: 'led', props: { bus: 0 } }]));
    const tx: BusTransaction = { kind: 'i2s', bus: 0, dir: 'write', data: new Uint8Array(8), ts: 1 };
    expect(r.resolve(tx)).toEqual([]);
  });

  it('does not route adc transactions yet', () => {
    const r = new NetlistResolver(netlist(
      [{ instanceId: 'oled1', kind: 'ssd1306', props: { address: 0x3c } }],
      [wire('w1', { instanceId: 'oled1', pin: 'SDA' }, { instanceId: 'mcu', pin: 'GPIO21' })],
    ));
    const tx: BusTransaction = { kind: 'adc', bus: 0, target: 1, dir: 'write', data: new Uint8Array(1), ts: 1 };
    expect(r.resolve(tx)).toEqual([]);
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

  // P3.4: reverse lookup for input injection (knob quadrature, button level).
  describe('resolveGpioInput (P3.4)', () => {
    it('resolves a peripheral pin to its wired MCU GPIO number, either wire direction', () => {
      const r = new NetlistResolver(netlist(
        [{ instanceId: 'knob1', kind: 'knob' }],
        [
          wire('w1', { instanceId: 'knob1', pin: 'A' }, { instanceId: 'mcu', pin: 'GPIO4' }),
          wire('w2', { instanceId: 'mcu', pin: 'GPIO16' }, { instanceId: 'knob1', pin: 'B' }),
        ],
      ));
      expect(r.resolveGpioInput('knob1', 'A')).toBe(4);
      expect(r.resolveGpioInput('knob1', 'B')).toBe(16);
    });

    it('returns undefined for unwired pins, unknown instances and non-GPIO rails', () => {
      const r = new NetlistResolver(netlist(
        [{ instanceId: 'knob1', kind: 'knob' }],
        [wire('w1', { instanceId: 'knob1', pin: 'GND' }, { instanceId: 'mcu', pin: 'GND' })],
      ));
      expect(r.resolveGpioInput('knob1', 'A')).toBeUndefined();
      expect(r.resolveGpioInput('knob9', 'A')).toBeUndefined();
      expect(r.resolveGpioInput('knob1', 'GND')).toBeUndefined(); // rail, not GPIO<n>
    });

    it('rebuilds the reverse index on setNetlist', () => {
      const r = new NetlistResolver(netlist(
        [{ instanceId: 'knob1', kind: 'knob' }],
        [wire('w1', { instanceId: 'knob1', pin: 'A' }, { instanceId: 'mcu', pin: 'GPIO4' })],
      ));
      expect(r.resolveGpioInput('knob1', 'A')).toBe(4);
      r.setNetlist(netlist([{ instanceId: 'knob1', kind: 'knob' }]));
      expect(r.resolveGpioInput('knob1', 'A')).toBeUndefined();
    });
  });
});
