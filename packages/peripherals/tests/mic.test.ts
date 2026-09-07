// PRD: §F-PER-7, §6.2, §6.7 — Microphone model (dev-plan P3.1): props-driven
// waveform generation emits I2sInjection chunks (interleaved LE PCM) through
// ctx.emitInput towards the device's I2S RX DMA injector.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusTransaction, I2sInjection, Peripheral, PeripheralContext } from '../src/types';
import { drainResampled, generatePcmChunk, micConfigFromProps, micFactory, waveformSample } from '../src/mic';

function fixture(props?: Record<string, unknown>): {
  per: Peripheral;
  injections: I2sInjection[];
  logs: { level: string; msg: string }[];
} {
  const injections: I2sInjection[] = [];
  const logs: { level: string; msg: string }[] = [];
  const ctx: PeripheralContext = {
    emitSnapshot: () => {},
    emitInput: (inj) => injections.push(inj),
    log: (level, msg) => logs.push({ level, msg }),
    onTick: () => () => {},
  };
  return { per: micFactory.create(ctx, { instanceId: 'mic1', ...props }), injections, logs };
}

/** Decode s16le mono PCM bytes into signed samples. */
function s16(data: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < data.length; i += 2) {
    let v = data[i] | (data[i + 1] << 8);
    if (v >= 0x8000) v -= 0x10000;
    out.push(v);
  }
  return out;
}

describe('micConfigFromProps (PRD §F-PER-7)', () => {
  it('applies documented defaults for absent props', () => {
    const cfg = micConfigFromProps();
    expect(cfg).toEqual({
      waveform: 'sine', freqHz: 440, amplitude: 0.5, sampleRate: 16000,
      bits: 16, channels: 1, bus: 0, chunkMs: 20,
    });
  });

  it('accepts explicit props', () => {
    const cfg = micConfigFromProps({ waveform: 'noise', freqHz: 1000, amplitude: 0.25, sampleRate: 44100, bits: 24, channels: 2, bus: 1, chunkMs: 50 });
    expect(cfg).toEqual({
      waveform: 'noise', freqHz: 1000, amplitude: 0.25, sampleRate: 44100,
      bits: 24, channels: 2, bus: 1, chunkMs: 50,
    });
  });

  it('falls back on unknown waveform, odd bit width and out-of-range values', () => {
    const cfg = micConfigFromProps({ waveform: 'triangle', bits: 12, channels: 3, bus: 7, sampleRate: 10, amplitude: 5, freqHz: -3 });
    expect(cfg.waveform).toBe('sine');
    expect(cfg.bits).toBe(16);
    expect(cfg.channels).toBe(1);
    expect(cfg.bus).toBe(0);
    expect(cfg.sampleRate).toBe(1000);
    expect(cfg.amplitude).toBe(1);
    expect(cfg.freqHz).toBe(1);
  });

  it('rejects non-finite numbers', () => {
    const cfg = micConfigFromProps({ sampleRate: NaN, freqHz: Infinity });
    expect(cfg.sampleRate).toBe(16000);
    expect(cfg.freqHz).toBe(440);
  });
});

describe('generatePcmChunk (pure PCM synthesis)', () => {
  it('produces chunkMs worth of interleaved bytes', () => {
    const cfg = micConfigFromProps({ sampleRate: 16000, chunkMs: 20 });
    const chunk = generatePcmChunk(cfg, 0);
    expect(chunk.data.length).toBe(320 * 2); // 320 frames * 1ch * 2B
    const stereo = generatePcmChunk(micConfigFromProps({ sampleRate: 16000, chunkMs: 10, channels: 2 }), 0);
    expect(stereo.data.length).toBe(160 * 2 * 2);
  });

  it('sine: bounded by amplitude, non-trivial, phase-continuous across chunks', () => {
    const cfg = micConfigFromProps({ waveform: 'sine', freqHz: 1000, amplitude: 0.5, sampleRate: 8000, chunkMs: 1 });
    const a = generatePcmChunk(cfg, 0);
    const b = generatePcmChunk(cfg, a.nextPhase);
    const samples = [...s16(a.data), ...s16(b.data)];
    const peak = Math.max(...samples.map(Math.abs));
    expect(peak).toBeGreaterThan(0.45 * 32767);
    expect(peak).toBeLessThanOrEqual(0.5 * 32768); // encodeSample rounds 0.5*(2^15-1) up
    // 8 frames/period at 1kHz/8kHz: sample 1 of a full sine run is +peak.
    expect(samples[1]).toBe(Math.round(0.5 * 32767 * Math.SQRT1_2));
    // Phase carry: chunk b continues the same period (frame 9 ≡ frame 1).
    expect(s16(b.data)[1]).toBe(samples[9]);
  });

  it('square: symmetric rails at ±amplitude (within encode rounding)', () => {
    const cfg = micConfigFromProps({ waveform: 'square', amplitude: 0.25, freqHz: 100, sampleRate: 8000, chunkMs: 10 });
    const samples = s16(generatePcmChunk(cfg, 0).data);
    const rail = Math.round(0.25 * 32766); // encodeSample scales by fullScale-1
    expect(Math.max(...samples)).toBe(rail);
    expect(Math.abs(Math.min(...samples))).toBeGreaterThanOrEqual(rail - 1);
    expect(Math.abs(Math.min(...samples))).toBeLessThanOrEqual(rail);
    expect(new Set(samples.map((s) => Math.sign(s)))).toEqual(new Set([1, -1]));
  });

  it('noise: deterministic for the default seed, bounded by amplitude', () => {
    const cfg = micConfigFromProps({ waveform: 'noise', amplitude: 0.5, sampleRate: 8000, chunkMs: 2 });
    const a = generatePcmChunk(cfg, 0);
    const b = generatePcmChunk(cfg, 0);
    expect(a.data).toEqual(b.data);
    const samples = s16(a.data);
    expect(Math.max(...samples.map(Math.abs))).toBeLessThanOrEqual(0.5 * 32767);
    expect(new Set(samples).size).toBeGreaterThan(10); // actually random-looking
  });

  it('silence: all-zero bytes', () => {
    const cfg = micConfigFromProps({ waveform: 'silence', chunkMs: 5 });
    expect(generatePcmChunk(cfg, 0).data.every((b) => b === 0)).toBe(true);
  });

  it('encodes 8/24/32-bit widths little-endian with sign', () => {
    const cfg8 = micConfigFromProps({ bits: 8, amplitude: 1, chunkMs: 1, sampleRate: 1000 });
    expect(generatePcmChunk(cfg8, 0.25).data[0]).toBe(127); // sine peak
    const cfg24 = micConfigFromProps({ bits: 24, amplitude: 1, chunkMs: 1, sampleRate: 1000 });
    expect(generatePcmChunk(cfg24, 0.25).data.slice(0, 3)).toEqual([0xff, 0xff, 0x7f]);
    const cfg32 = micConfigFromProps({ bits: 32, amplitude: 1, chunkMs: 1, sampleRate: 1000 });
    const d = generatePcmChunk(cfg32, 0.75).data.slice(0, 4); // sine trough
    expect(d).toEqual([0x01, 0x00, 0x00, 0x80]); // -(2^31-1)
  });
});

describe('waveformSample', () => {
  const base = micConfigFromProps({ amplitude: 0.5 });
  it('silence and square edges', () => {
    expect(waveformSample({ ...base, waveform: 'silence' }, 0.3, () => 0)).toBe(0);
    expect(waveformSample({ ...base, waveform: 'square' }, 0.49, () => 0)).toBe(0.5);
    expect(waveformSample({ ...base, waveform: 'square' }, 0.5, () => 0)).toBe(-0.5);
  });
});

describe('mic model — injection wiring (PRD §6.2 emitInput)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('emits one I2sInjection per chunkMs with the configured format', () => {
    const { per, injections } = fixture({ sampleRate: 16000, chunkMs: 20, bus: 1 });
    vi.advanceTimersByTime(65);
    expect(injections.length).toBe(3);
    const inj = injections[0];
    expect(inj.bus).toBe(1);
    expect(inj.rate).toBe(16000);
    expect(inj.bits).toBe(16);
    expect(inj.channels).toBe(1);
    expect(inj.data.length).toBe(640);
    per.dispose();
  });

  it('keeps the tone phase-continuous across chunks', () => {
    const { per, injections } = fixture({ freqHz: 1000, sampleRate: 8000, chunkMs: 1, amplitude: 0.5 });
    vi.advanceTimersByTime(3);
    const bytes = injections.flatMap((i) => i.data);
    const samples = s16(bytes);
    expect(samples[9]).toBe(samples[1]); // frame 9 ≡ frame 1 of the 8-frame period
    per.dispose();
  });

  it('stops emitting after dispose()', () => {
    const { per, injections } = fixture();
    vi.advanceTimersByTime(25);
    const n = injections.length;
    per.dispose();
    vi.advanceTimersByTime(100);
    expect(injections.length).toBe(n);
  });

  it('ignores MCU-originated transactions (input-only peripheral)', () => {
    const { per } = fixture();
    const tx: BusTransaction = { kind: 'i2s', bus: 0, dir: 'write', ts: 0, data: new Uint8Array(8) };
    expect(() => per.onTransaction(tx)).not.toThrow();
    per.dispose();
  });

  it('warns once and drops samples when the context has no injection channel', () => {
    const logs: { level: string; msg: string }[] = [];
    const ctx: PeripheralContext = {
      emitSnapshot: () => {},
      log: (level, msg) => logs.push({ level, msg }),
      onTick: () => () => {},
    };
    const per = micFactory.create(ctx, { instanceId: 'mic1' });
    vi.advanceTimersByTime(100);
    expect(logs.filter((l) => l.level === 'warn').length).toBe(1);
    expect(logs[0].msg).toContain('mic1');
    per.dispose();
  });
});

describe('mic factory metadata', () => {
  it('exposes the i2s-data-out pin and defaults bus 0', () => {
    expect(micFactory.pins.some((p) => p.role === 'i2s-data-out')).toBe(true);
    expect(micFactory.defaults?.bus).toBe(0);
    expect(micFactory.version).toBe('1.0.0');
  });
});

// --- P3.2: local mic capture -> resample -> injection (PRD §F-PER-7) ---

describe('drainResampled (pure capture resampler)', () => {
  it('passes samples through at equal rates and advances the position', () => {
    const r = drainResampled([0.1, 0.2, 0.3], 0, 16000, 16000, 2);
    expect(r.samples).toEqual([0.1, 0.2]);
    expect(r.nextPos).toBe(2);
    // Continuing from nextPos consumes the rest without repeating.
    const rest = drainResampled([0.1, 0.2, 0.3], r.nextPos, 16000, 16000, 5);
    expect(rest.samples).toEqual([0.3]);
  });

  it('downsamples 2:1 by stepping over every other source sample', () => {
    const r = drainResampled([0, 0.9, 0.5, 0.9], 0, 32000, 16000, 2);
    expect(r.samples).toEqual([0, 0.5]); // integer positions -> frac 0, exact picks
    expect(r.nextPos).toBe(4);
  });

  it('upsamples 1:2 with linear interpolation between samples', () => {
    const r = drainResampled([0, 1], 0, 8000, 16000, 8);
    expect(r.samples).toEqual([0, 0.5, 1]); // stops when the read position runs dry
  });

  it('produces nothing when the buffer is starved', () => {
    expect(drainResampled([], 0, 48000, 16000, 10).samples).toEqual([]);
    expect(drainResampled([1], 1, 48000, 16000, 10).samples).toEqual([]);
  });

  it('interpolates fractional positions for non-integer rate ratios', () => {
    // 48k -> 24k is exact; 8k -> 12k (step 2/3) exercises the fractional arm.
    const r = drainResampled([0, 3, 6], 0, 8000, 12000, 2);
    expect(r.samples[0]).toBe(0);
    expect(r.samples[1]).toBeCloseTo(2, 10); // pos 2/3: 0*(1/3) + 3*(2/3)
  });
});

describe('mic model — local capture (P3.2, PRD §F-PER-7)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** s16 decode of every emitted chunk concatenated. */
  const decoded = (injections: I2sInjection[]): number[] => s16(injections.flatMap((i) => i.data));

  it('routes captured chunks into injections while capture is live', () => {
    const { per, injections } = fixture({ sampleRate: 16000, chunkMs: 20 });
    per.acceptCapture!({ rate: 16000, samples: new Array<number>(1600).fill(0.5) });
    vi.advanceTimersByTime(20);
    expect(injections.length).toBe(1);
    expect(injections[0]).toMatchObject({ bus: 0, rate: 16000, bits: 16, channels: 1 });
    expect(injections[0].data.length).toBe(640); // 320 frames of capture, not synth
    // Capture rides the same 20ms cadence: a full chunk of 0.5 -> 16384 s16.
    expect(decoded(injections).every((s) => s === 16384)).toBe(true);
    per.dispose();
  });

  it('resamples the host rate down to the configured sample rate', () => {
    const { per, injections } = fixture({ sampleRate: 16000, chunkMs: 20 });
    per.acceptCapture!({ rate: 48000, samples: new Array<number>(4800).fill(0.25) });
    vi.advanceTimersByTime(20);
    expect(injections.length).toBe(1);
    expect(injections[0].rate).toBe(16000); // the firmware-facing format is unchanged
    // 48k -> 16k steps over integer positions: the constant survives exactly.
    expect(decoded(injections).every((s) => s === 8192)).toBe(true);
    per.dispose();
  });

  it('emits nothing while the capture buffer is starved', () => {
    const { per, injections } = fixture({ sampleRate: 16000, chunkMs: 20 });
    per.acceptCapture!({ rate: 16000, samples: new Array<number>(10).fill(0.5) });
    vi.advanceTimersByTime(20);
    expect(injections.length).toBe(1);
    expect(injections[0].data.length).toBe(20); // partial chunk: only the 10 fed frames
    vi.advanceTimersByTime(100); // still "live" (< 500ms stale) but nothing left
    expect(injections.length).toBe(1); // starved capture never injects silence
    per.dispose();
  });

  it('falls back to the synth waveform after the feed goes stale', () => {
    const { per, injections } = fixture({ sampleRate: 16000, chunkMs: 20, waveform: 'silence' });
    // Exactly one chunk of capture: the buffer runs dry at the first tick.
    per.acceptCapture!({ rate: 16000, samples: new Array<number>(320).fill(0.5) });
    vi.advanceTimersByTime(20);
    expect(injections.length).toBe(1);
    expect(decoded(injections).every((s) => s === 16384)).toBe(true); // capture won
    vi.advanceTimersByTime(600); // > 500ms stale window
    const after = injections.slice(1);
    expect(after.length).toBeGreaterThan(0);
    // Synth (silence) resumed: every later chunk is a full-length zero chunk.
    expect(after.every((i) => i.data.length === 640)).toBe(true);
    expect(decoded(after).every((s) => s === 0)).toBe(true);
    per.dispose();
  });

  it('drops the unplayed capture buffer when the feed goes stale', () => {
    const { per, injections } = fixture({ sampleRate: 16000, chunkMs: 20 });
    per.acceptCapture!({ rate: 16000, samples: new Array<number>(1600).fill(1) });
    vi.advanceTimersByTime(600); // stale -> buffer cleared, silence synth runs
    injections.length = 0;
    per.acceptCapture!({ rate: 16000, samples: new Array<number>(10).fill(0.5) });
    vi.advanceTimersByTime(20);
    // Only the fresh 10 frames arrive — the pre-stale 1600 were discarded.
    expect(injections.length).toBe(1);
    expect(injections[0].data.length).toBe(20);
    per.dispose();
  });

  it('resets the buffer when the capture source rate changes', () => {
    const { per, injections } = fixture({ sampleRate: 16000, chunkMs: 20 });
    per.acceptCapture!({ rate: 16000, samples: new Array<number>(1600).fill(1) });
    per.acceptCapture!({ rate: 48000, samples: new Array<number>(96).fill(0.5) });
    vi.advanceTimersByTime(20);
    // Buffer restarted at 48k: only the 96 new samples drain (2ms worth).
    expect(injections.length).toBe(1);
    expect(injections[0].data.length).toBe(32 * 2); // 96 / 3 = 32 frames
    expect(decoded(injections).every((s) => s === 16384)).toBe(true);
    per.dispose();
  });

  it('caps the buffer at 1s of source audio (drop-oldest) and warns once', () => {
    const { per, injections, logs } = fixture({ sampleRate: 16000, chunkMs: 20 });
    per.acceptCapture!({ rate: 16000, samples: new Array<number>(20000).fill(0.25) });
    per.acceptCapture!({ rate: 16000, samples: new Array<number>(20000).fill(1) });
    vi.advanceTimersByTime(20);
    // 40s fed, <=1s kept: the oldest (0.25) is gone, only the newest plays.
    expect(decoded(injections).every((s) => s === 32767)).toBe(true);
    const warns = logs.filter((l) => l.level === 'warn' && l.msg.includes('overflow'));
    expect(warns.length).toBe(1);
    per.acceptCapture!({ rate: 16000, samples: new Array<number>(20000).fill(1) });
    expect(logs.filter((l) => l.msg.includes('overflow')).length).toBe(1); // one-shot
    per.dispose();
  });

  it('drops malformed chunks without activating capture', () => {
    const { per, injections } = fixture({ sampleRate: 16000, chunkMs: 20, waveform: 'silence' });
    per.acceptCapture!({ rate: NaN, samples: [0.5] });
    per.acceptCapture!({ rate: -16000, samples: [0.5] });
    per.acceptCapture!({ rate: 16000, samples: [0.5, Number.NaN] });
    vi.advanceTimersByTime(20);
    expect(injections.length).toBe(1);
    expect(injections[0].data.length).toBe(640); // synth silence, not a capture drain
    expect(decoded(injections).every((s) => s === 0)).toBe(true);
    per.dispose();
  });

  it('clamps out-of-range capture samples at full scale', () => {
    const { per, injections } = fixture({ sampleRate: 16000, chunkMs: 20 });
    per.acceptCapture!({ rate: 16000, samples: [5, -5] });
    vi.advanceTimersByTime(20);
    const [a, b] = decoded(injections);
    expect(a).toBe(32767);
    expect(b).toBe(-32767);
    per.dispose();
  });

  it('duplicates mono capture into stereo when configured', () => {
    const { per, injections } = fixture({ sampleRate: 16000, chunkMs: 20, channels: 2 });
    per.acceptCapture!({ rate: 16000, samples: new Array<number>(1600).fill(0.5) });
    vi.advanceTimersByTime(20);
    expect(injections[0].channels).toBe(2);
    expect(injections[0].data.length).toBe(640 * 2);
    const frames = s16(injections[0].data);
    for (let i = 0; i < frames.length; i += 2) {
      expect(frames[i]).toBe(16384);
      expect(frames[i + 1]).toBe(16384);
    }
    per.dispose();
  });

  it('stops draining after dispose mid-capture', () => {
    const { per, injections } = fixture({ sampleRate: 16000, chunkMs: 20 });
    per.acceptCapture!({ rate: 16000, samples: new Array<number>(16000).fill(0.5) });
    vi.advanceTimersByTime(20);
    const n = injections.length;
    per.dispose();
    vi.advanceTimersByTime(100);
    expect(injections.length).toBe(n);
  });
});
