// PRD: §F-EXT-1, §6.4 — Generic canvas node body (dev-plan P5.1): any
// registered kind without a bespoke renderer maps its latest snapshot to a
// neutral lamp + one-line status, so third-party peripherals are visible and
// alive on the breadboard with zero per-kind UI code.
import { describe, expect, it } from 'vitest';
import type { RenderSnapshot } from '@breadesp/peripherals';
import { describeGenericSnapshot } from '../src/components/Breadboard/genericNode';

function snap(type: RenderSnapshot['type'], payload: RenderSnapshot['payload']): RenderSnapshot {
  return { instanceId: 'x-1', type, payload };
}

describe('describeGenericSnapshot', () => {
  it('reports "no data" before the first snapshot', () => {
    expect(describeGenericSnapshot(undefined)).toEqual({ lamp: null, text: 'no data' });
  });

  it('maps a level snapshot to lamp intensity and a percent label', () => {
    expect(describeGenericSnapshot(snap('level', { level: 0.5 }))).toEqual({ lamp: 0.5, text: '50%' });
    expect(describeGenericSnapshot(snap('level', { level: 1 }))).toEqual({ lamp: 1, text: '100%' });
  });

  it('clamps out-of-range and non-finite levels', () => {
    expect(describeGenericSnapshot(snap('level', { level: 7 })).lamp).toBe(1);
    expect(describeGenericSnapshot(snap('level', { level: -2 })).lamp).toBe(0);
    expect(describeGenericSnapshot(snap('level', { level: Number.NaN }))).toEqual({ lamp: 0, text: '0%' });
  });

  it('maps a sounding tone to a duty-driven lamp and a Hz label', () => {
    expect(describeGenericSnapshot(snap('tone', { freqHz: 440.4, duty: 0.5 }))).toEqual({ lamp: 0.5, text: '440 Hz' });
    expect(describeGenericSnapshot(snap('tone', { freqHz: 0, duty: 0 }))).toEqual({ lamp: 0, text: 'silent' });
  });

  it('maps a text snapshot to a truncated status line', () => {
    expect(describeGenericSnapshot(snap('text', { text: '25.0C 50%' }))).toEqual({ lamp: null, text: '25.0C 50%' });
    const long = describeGenericSnapshot(snap('text', { text: 'a'.repeat(40) }));
    expect(long.text.length).toBe(20);
    expect(long.text.endsWith('…')).toBe(true);
  });

  it('maps a pixels snapshot to a geometry label (live frame stays in ScreenView)', () => {
    expect(describeGenericSnapshot(snap('pixels', { width: 240, height: 240, format: 'rgb565', buffer: [] })))
      .toEqual({ lamp: null, text: '240x240 rgb565' });
  });

  it('maps an audio snapshot to a sample-rate label, lit while samples flow', () => {
    expect(describeGenericSnapshot(snap('audio', { samples: [0, 0.5], sampleRate: 16000 })))
      .toEqual({ lamp: 1, text: '16.0 kHz' });
    expect(describeGenericSnapshot(snap('audio', { samples: [], sampleRate: 16000 })).lamp).toBe(0);
  });

  it('maps a waveform snapshot to a channel count', () => {
    const payload = { startMs: 0, windowMs: 200, channels: [{ label: 'CH1', edges: [] }, { label: 'CH3', edges: [] }] };
    expect(describeGenericSnapshot(snap('waveform', payload))).toEqual({ lamp: null, text: '2 ch' });
    expect(describeGenericSnapshot(snap('waveform', { samples: [1, 2] }))).toEqual({ lamp: null, text: 'waveform' });
  });

  it('stays renderable for unknown future snapshot types', () => {
    const future = { instanceId: 'x-1', type: 'hologram', payload: {} } as unknown as RenderSnapshot;
    expect(describeGenericSnapshot(future)).toEqual({ lamp: null, text: 'hologram' });
  });
});
