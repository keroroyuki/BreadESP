// PRD: §F-BB-3 — sensorDraft (dev-plan task P3.4): the SHT30 canvas node's
// +/- buttons compute clamped netlist-props patches, delegating all
// normalization to the model's own config parser/limits (single source of
// truth, mirroring wavegenDraft for the mic).
import { describe, expect, it } from 'vitest';
import { SHT30_LIMITS } from '@breadesp/peripherals';
import { adjustSht30, SHT30_STEP } from '../src/components/Breadboard/sensorDraft';

describe('adjustSht30 (P3.4)', () => {
  it('steps temperature by ±1 °C from the current props', () => {
    expect(adjustSht30({ temperatureC: 25, humidityRh: 50 }, 'temperatureC', 1)).toEqual({ temperatureC: 26 });
    expect(adjustSht30({ temperatureC: 25, humidityRh: 50 }, 'temperatureC', -1)).toEqual({ temperatureC: 24 });
  });

  it('steps humidity by ±5 %RH from the current props', () => {
    expect(adjustSht30({}, 'humidityRh', 1)).toEqual({ humidityRh: 55 });
    expect(adjustSht30({}, 'humidityRh', -1)).toEqual({ humidityRh: 45 });
  });

  it('starts from the model defaults when props are absent', () => {
    expect(adjustSht30(undefined, 'temperatureC', 1)).toEqual({ temperatureC: 26 });
  });

  it('normalizes invalid stored props before stepping (model fallback)', () => {
    // A hand-edited netlist with garbage props still yields a sane adjustment.
    expect(adjustSht30({ temperatureC: 'hot' }, 'temperatureC', 1)).toEqual({ temperatureC: 26 });
    expect(adjustSht30({ humidityRh: Number.NaN }, 'humidityRh', -1)).toEqual({ humidityRh: 45 });
  });

  it('saturates at the model limits instead of overflowing', () => {
    expect(adjustSht30({ temperatureC: SHT30_LIMITS.temperatureC.max }, 'temperatureC', 1))
      .toEqual({ temperatureC: SHT30_LIMITS.temperatureC.max });
    expect(adjustSht30({ temperatureC: SHT30_LIMITS.temperatureC.min }, 'temperatureC', -1))
      .toEqual({ temperatureC: SHT30_LIMITS.temperatureC.min });
    expect(adjustSht30({ humidityRh: 100 }, 'humidityRh', 1)).toEqual({ humidityRh: 100 });
    expect(adjustSht30({ humidityRh: 0 }, 'humidityRh', -1)).toEqual({ humidityRh: 0 });
  });

  it('keeps fractional readings steppable (model precision is preserved)', () => {
    expect(adjustSht30({ temperatureC: 21.5 }, 'temperatureC', 1)).toEqual({ temperatureC: 22.5 });
  });

  it('documents the step sizes the UI buttons apply', () => {
    expect(SHT30_STEP).toEqual({ temperatureC: 1, humidityRh: 5 });
  });
});
