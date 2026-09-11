// PRD: §6.2, §F-BB-3 — SHT30 temperature/humidity sensor model (dev-plan P3.4):
// I2C command writes addressed at the instance push the 6-byte measurement (or
// 3-byte status) readout upstream via ctx.emitInput as an i2c-out reply, served
// by the device mailbox to firmware reads. CRC-8 and the conversion formulas
// follow the Sensirion datasheet and are pinned against its worked examples.
import { describe, expect, it } from 'vitest';
import type { BusTransaction, Peripheral, PeripheralContext, PeripheralInjection, RenderSnapshot } from '../src/types';
import {
  sht30ConfigFromProps, sht30Crc8, sht30Factory, sht30FormatReading, sht30MeasurementBytes, sht30StatusBytes, SHT30_LIMITS,
} from '../src/sht30';

function fixture(props?: Record<string, unknown>, withEmitInput = true) {
  const injections: PeripheralInjection[] = [];
  const logs: { level: string; msg: string }[] = [];
  const snapshots: RenderSnapshot[] = [];
  const ctx: PeripheralContext = {
    emitSnapshot: (s) => snapshots.push(s),
    ...(withEmitInput ? { emitInput: (inj: PeripheralInjection) => injections.push(inj) } : {}),
    log: (level, msg) => logs.push({ level, msg }),
    onTick: () => () => {},
  };
  return { per: sht30Factory.create(ctx, { instanceId: 'sht1', ...props }), injections, logs, snapshots };
}

function i2cWrite(cmd: number, addr = 0x44, bus = 0): BusTransaction {
  return { kind: 'i2c', bus, target: addr, dir: 'write', data: Uint8Array.from([cmd >> 8, cmd & 0xff]), ts: 1 };
}

describe('sht30ConfigFromProps (P3.4)', () => {
  it('applies documented defaults for absent props', () => {
    expect(sht30ConfigFromProps()).toEqual({ address: 0x44, temperatureC: 25, humidityRh: 50 });
  });

  it('accepts explicit props', () => {
    expect(sht30ConfigFromProps({ address: 0x45, temperatureC: 21.5, humidityRh: 63 }))
      .toEqual({ address: 0x45, temperatureC: 21.5, humidityRh: 63 });
  });

  it('falls back / clamps on invalid props', () => {
    expect(sht30ConfigFromProps({ address: 68.5 }).address).toBe(0x44); // non-integer
    expect(sht30ConfigFromProps({ address: 0x02 }).address).toBe(0x44); // reserved band
    expect(sht30ConfigFromProps({ address: 'hot' }).address).toBe(0x44);
    expect(sht30ConfigFromProps({ temperatureC: 200 }).temperatureC).toBe(SHT30_LIMITS.temperatureC.max);
    expect(sht30ConfigFromProps({ temperatureC: -100 }).temperatureC).toBe(SHT30_LIMITS.temperatureC.min);
    expect(sht30ConfigFromProps({ humidityRh: 140 }).humidityRh).toBe(100);
    expect(sht30ConfigFromProps({ humidityRh: Number.NaN }).humidityRh).toBe(50);
  });
});

describe('sht30Crc8 (datasheet §4.12)', () => {
  it('matches the datasheet worked example 0xBEEF -> 0x92', () => {
    expect(sht30Crc8(0xbe, 0xef)).toBe(0x92);
  });

  it('is 0x81 for two zero bytes with the 0xFF init', () => {
    expect(sht30Crc8(0x00, 0x00)).toBe(0x81); // pinned value, guards the init constant
  });
});

describe('sht30MeasurementBytes (datasheet §4.13)', () => {
  it('encodes 25.0°C / 50%RH as the pinned golden vector', () => {
    // Same vector the sht.elf golden firmware expects (scripts/make-sht-elf.mjs).
    expect(sht30MeasurementBytes({ address: 0x44, temperatureC: 25, humidityRh: 50 }))
      .toEqual([0x66, 0x66, 0x93, 0x80, 0x00, 0xa2]);
  });

  it('round-trips through the datasheet conversion formulas', () => {
    const bytes = sht30MeasurementBytes({ address: 0x44, temperatureC: 21.5, humidityRh: 63 });
    const rawT = (bytes[0] << 8) | bytes[1];
    const rawH = (bytes[3] << 8) | bytes[4];
    expect(-45 + 175 * (rawT / 65535)).toBeCloseTo(21.5, 1);
    expect(100 * (rawH / 65535)).toBeCloseTo(63, 1);
    expect(bytes[2]).toBe(sht30Crc8(bytes[0], bytes[1]));
    expect(bytes[5]).toBe(sht30Crc8(bytes[3], bytes[4]));
  });

  it('encodes the clamping extremes without overflow', () => {
    // -40°C (the config minimum) is 5/175 of full scale, not the formula zero (-45).
    expect(sht30MeasurementBytes({ address: 0x44, temperatureC: -40, humidityRh: 0 }))
      .toEqual([0x07, 0x50, sht30Crc8(0x07, 0x50), 0x00, 0x00, sht30Crc8(0, 0)]);
    const max = sht30MeasurementBytes({ address: 0x44, temperatureC: 125, humidityRh: 100 });
    expect((max[0] << 8) | max[1]).toBe(63663); // round((125+45)/175 * 65535)
    expect((max[3] << 8) | max[4]).toBe(65535);
  });
});

describe('sht30StatusBytes (datasheet §4.10)', () => {
  it('reports the reset value 0x8010 with heater off', () => {
    expect(sht30StatusBytes(false)).toEqual([0x80, 0x10, sht30Crc8(0x80, 0x10)]);
  });

  it('sets bit 2 with the heater on', () => {
    expect(sht30StatusBytes(true)).toEqual([0x80, 0x14, sht30Crc8(0x80, 0x14)]);
  });
});

describe('sht30 model (P3.4)', () => {
  it('replies to a clock-stretched measurement command with the 6-byte readout', () => {
    const { per, injections } = fixture({ temperatureC: 21.5, humidityRh: 63 });
    per.onTransaction(i2cWrite(0x2c06));
    expect(injections).toEqual([{
      kind: 'i2c-out', bus: 0, target: 0x44,
      data: sht30MeasurementBytes({ address: 0x44, temperatureC: 21.5, humidityRh: 63 }),
    }]);
  });

  it('replies on the bus the command arrived on', () => {
    const { per, injections } = fixture();
    per.onTransaction(i2cWrite(0x2400, 0x44, 1)); // no-stretch high repeatability, I2C1
    expect(injections[0]).toMatchObject({ kind: 'i2c-out', bus: 1, target: 0x44 });
  });

  it('answers every measurement command variant', () => {
    const { per, injections } = fixture();
    for (const cmd of [0x2c06, 0x2c0d, 0x2c10, 0x2400, 0x240b, 0x2416]) {
      per.onTransaction(i2cWrite(cmd));
    }
    expect(injections).toHaveLength(6);
    expect(injections.every((i) => i.kind === 'i2c-out' && i.data.length === 6)).toBe(true);
  });

  it('reflects prop changes in the next measurement (netlist rebuild equivalent)', () => {
    const hot = fixture({ temperatureC: 80, humidityRh: 10 });
    hot.per.onTransaction(i2cWrite(0x2c06));
    expect(hot.injections[0]).toMatchObject({ data: sht30MeasurementBytes({ address: 0x44, temperatureC: 80, humidityRh: 10 }) });
  });

  it('serves the status register and tracks the heater bit', () => {
    const { per, injections } = fixture();
    per.onTransaction(i2cWrite(0x306d)); // heater on
    per.onTransaction(i2cWrite(0xf32d)); // read status
    expect(injections[0]).toMatchObject({ kind: 'i2c-out', data: sht30StatusBytes(true) });
    per.onTransaction(i2cWrite(0x3066)); // heater off
    per.onTransaction(i2cWrite(0x30a2)); // soft reset
    per.onTransaction(i2cWrite(0xf32d));
    expect(injections.at(-1)).toMatchObject({ data: sht30StatusBytes(false) });
  });

  it('ignores foreign traffic (other address, reads, non-i2c, sub-word writes)', () => {
    const { per, injections, logs } = fixture();
    per.onTransaction(i2cWrite(0x2c06, 0x3c)); // the OLED's address
    per.onTransaction({ kind: 'i2c', bus: 0, target: 0x44, dir: 'read', data: new Uint8Array(0), length: 6, ts: 1 });
    per.onTransaction({ kind: 'gpio', bus: 0, target: 4, dir: 'write', data: Uint8Array.from([1]), ts: 1 });
    per.onTransaction({ kind: 'i2c', bus: 0, target: 0x44, dir: 'write', data: Uint8Array.from([0x2c]), ts: 1 });
    expect(injections).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  it('warns once on unknown commands (periodic mode is not modeled)', () => {
    const { per, logs } = fixture();
    per.onTransaction(i2cWrite(0x202f)); // periodic mode, 1 mps high
    per.onTransaction(i2cWrite(0xffff));
    expect(logs.filter((l) => l.level === 'warn')).toHaveLength(1);
  });

  it('warns once when the context has no injection channel', () => {
    const { per, logs } = fixture({}, false);
    per.onTransaction(i2cWrite(0x2c06));
    per.onTransaction(i2cWrite(0x2c06));
    expect(logs.filter((l) => l.msg.includes('no injection channel'))).toHaveLength(1);
  });

  it('emits a text snapshot with the current reading on create and measure', () => {
    const { per, snapshots } = fixture({ temperatureC: 21.5, humidityRh: 63 });
    expect(snapshots[0]).toEqual({ instanceId: 'sht1', type: 'text', payload: { text: '21.5 °C · 63 %RH' } });
    per.onTransaction(i2cWrite(0x2c06));
    expect(snapshots).toHaveLength(2);
  });

  it('exposes factory metadata with I2C pins and the default address', () => {
    expect(sht30Factory.kind).toBe('sht30');
    expect(sht30Factory.pins.map((p) => [p.id, p.role])).toEqual([
      ['SDA', 'i2c-sda'], ['SCL', 'i2c-scl'], ['VCC', 'power'], ['GND', 'gnd'],
    ]);
    expect(sht30Factory.defaults).toEqual({ address: 0x44 });
  });

  it('formats the reading line (UI single source of truth)', () => {
    expect(sht30FormatReading({ address: 0x44, temperatureC: -40, humidityRh: 0 })).toBe('-40.0 °C · 0 %RH');
  });
});
