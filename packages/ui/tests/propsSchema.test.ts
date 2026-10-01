// T4.2 — props schema contract: explicit schemas for the tunable built-ins
// (bounds imported from the peripherals LIMITS constants), generic
// degradation over defaults ∪ instance props for every other kind.
import { describe, it, expect } from 'vitest';
import { KNOB_LIMITS, MIC_LIMITS, SHT30_LIMITS } from '@breadesp/peripherals';
import {
  clampNumberField,
  fieldsForInstance,
  type NumberField,
} from '../src/components/PropsPanel/propsSchema';

describe('explicit schemas', () => {
  it('sht30 exposes temperature/humidity/address with the model bounds', () => {
    const fields = fieldsForInstance('sht30', { temperatureC: 30 });
    const keys = fields.map((f) => f.key);
    expect(keys).toEqual(['temperatureC', 'humidityRh', 'address']);
    const temp = fields[0] as NumberField & { value: unknown };
    expect(temp.min).toBe(SHT30_LIMITS.temperatureC.min);
    expect(temp.max).toBe(SHT30_LIMITS.temperatureC.max);
    expect(temp.value).toBe(30);
    // address falls back to the factory default when the instance omits it
    const addr = fields[2] as NumberField & { value: unknown; fallback: unknown };
    expect(addr.value).toBe(0x44);
    expect(addr.fallback).toBe(0x44);
  });

  it('mic exposes a waveform select driven by MIC_LIMITS.waveforms', () => {
    const fields = fieldsForInstance('mic', { waveform: 'square' });
    const wf = fields.find((f) => f.key === 'waveform');
    expect(wf?.type).toBe('select');
    if (wf?.type === 'select') {
      expect(wf.choices.map((c) => c.value)).toEqual([...MIC_LIMITS.waveforms]);
    }
    expect(wf?.value).toBe('square');
  });

  it('mic frequency bounds come from MIC_LIMITS', () => {
    const fields = fieldsForInstance('mic');
    const freq = fields.find((f) => f.key === 'freqHz') as NumberField;
    expect(freq.min).toBe(MIC_LIMITS.freqHz.min);
    expect(freq.max).toBe(MIC_LIMITS.freqHz.max);
  });

  it('knob exposes stepMs with the model bounds', () => {
    const fields = fieldsForInstance('knob', { stepMs: 20 });
    const step = fields[0] as NumberField & { value: unknown };
    expect(step.key).toBe('stepMs');
    expect(step.value).toBe(20);
    expect(step.min).toBe(KNOB_LIMITS.stepMs.min);
    expect(step.max).toBe(KNOB_LIMITS.stepMs.max);
  });

  it('oscilloscope exposes windowMs and maxEdges', () => {
    const fields = fieldsForInstance('oscilloscope', { windowMs: 500 });
    expect(fields.map((f) => f.key)).toEqual(['windowMs', 'maxEdges']);
    expect(fields[0].value).toBe(500);
  });
});

describe('generic degradation (unknown / no-schema kinds)', () => {
  it('a kind without defaults or props yields an empty form', () => {
    expect(fieldsForInstance('led')).toEqual([]);
  });

  it('derives fields from the factory defaults when the instance has no props', () => {
    // ssd1306 ships a default I2C address but has no explicit schema.
    const fields = fieldsForInstance('ssd1306');
    expect(fields.map((f) => f.key)).toEqual(['address']);
    expect(fields[0].type).toBe('number');
    expect(fields[0].fallback).toBe(0x3c);
  });

  it('merges instance props over the defaults and keeps factory order first', () => {
    const fields = fieldsForInstance('ssd1306', { address: 0x3d, contrast: 128 });
    const keys = fields.map((f) => f.key);
    expect(keys).toEqual(['address', 'contrast']); // default key first, extras sorted
    expect(fields[0].value).toBe(0x3d);
    expect(fields[0].fallback).toBe(0x3c);
  });

  it('maps booleans to a true/false select', () => {
    const fields = fieldsForInstance('led', { inverted: true });
    const f = fields.find((x) => x.key === 'inverted');
    expect(f?.type).toBe('select');
    if (f?.type === 'select') {
      expect(f.choices.map((c) => c.value)).toEqual(['true', 'false']);
    }
  });

  it('maps strings to a plain text field', () => {
    const fields = fieldsForInstance('led', { label: 'PWR' });
    const f = fields.find((x) => x.key === 'label');
    expect(f?.type).toBe('string');
    expect(f?.value).toBe('PWR');
  });
});

describe('clampNumberField', () => {
  const field: NumberField = {
    type: 'number', key: 'temperatureC', label: 't', integer: false,
    min: -40, max: 125, step: 0.5,
  };

  it('keeps in-range values untouched', () => {
    expect(clampNumberField(field, 25)).toBe(25);
  });

  it('clamps below the minimum', () => {
    expect(clampNumberField(field, -100)).toBe(-40);
  });

  it('clamps above the maximum', () => {
    expect(clampNumberField(field, 300)).toBe(125);
  });

  it('rounds integer fields before clamping', () => {
    const intField: NumberField = { ...field, integer: true, min: 8, max: 0x77 };
    expect(clampNumberField(intField, 68.6)).toBe(69);
  });
});
