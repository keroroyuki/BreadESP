// PRD: §F-PER-7 — Waveform generator draft/preview helpers (dev-plan task P3.3).
// The panel is a thin React wiring layer; all normalization (delegated to the
// mic model's own micConfigFromProps), patch shaping and preview geometry are
// pinned here, including the canvas binding via a recording 2d-context stub
// (traceBuilder precedent).
import { describe, expect, it } from 'vitest';
import { MIC_LIMITS } from '@breadesp/peripherals';
import { draftFromProps, draftPatch, previewTrace, renderWavePreview } from '../src/components/WaveGen/wavegenDraft';

describe('wavegenDraft.draftFromProps', () => {
  it('falls back to the model defaults for missing or invalid props', () => {
    expect(draftFromProps()).toEqual(draftFromProps({}));
    const d = draftFromProps({ waveform: 'triangle', freqHz: -5, amplitude: 9, bits: 12, channels: 3 });
    expect(d.waveform).toBe('sine');
    expect(d.freqHz).toBe(MIC_LIMITS.freqHz.min); // clamped, not trusted
    expect(d.amplitude).toBe(MIC_LIMITS.amplitude.max);
    expect(d.bits).toBe(16);
    expect(d.channels).toBe(1);
  });

  it('keeps valid persisted props verbatim', () => {
    const d = draftFromProps({
      waveform: 'square', freqHz: 880, amplitude: 0.25, sampleRate: 44100,
      bits: 24, channels: 2, bus: 1, chunkMs: 50,
    });
    expect(d).toMatchObject({
      waveform: 'square', freqHz: 880, amplitude: 0.25, sampleRate: 44100,
      bits: 24, channels: 2, bus: 1, chunkMs: 50,
    });
  });
});

describe('wavegenDraft.draftPatch', () => {
  it('emits exactly the six panel-editable keys (bus/chunkMs stay untouched)', () => {
    const patch = draftPatch(draftFromProps({ bus: 1, chunkMs: 50 }));
    expect(Object.keys(patch).sort()).toEqual([
      'amplitude', 'bits', 'channels', 'freqHz', 'sampleRate', 'waveform',
    ]);
    expect(patch.bus).toBeUndefined();
    expect(patch.chunkMs).toBeUndefined();
  });

  it('round-trips through draftFromProps', () => {
    const d = draftFromProps({ waveform: 'noise', freqHz: 1000, amplitude: 0.7, sampleRate: 32000, bits: 8, channels: 2 });
    const back = draftFromProps(draftPatch(d));
    expect(draftPatch(back)).toEqual(draftPatch(d));
  });
});

describe('wavegenDraft.previewTrace', () => {
  it('is deterministic, sized and bounded by amplitude', () => {
    const cfg = draftFromProps({ waveform: 'sine', freqHz: 440, amplitude: 0.5 });
    const a = previewTrace(cfg);
    expect(a).toEqual(previewTrace(cfg));
    expect(a).toHaveLength(96);
    for (const s of a) expect(Math.abs(s)).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it('draws one full sine period inside the window (peak reaches amplitude)', () => {
    // 200 Hz over a 5 ms window is exactly one period: zero endpoints, full swing.
    const s = previewTrace(draftFromProps({ waveform: 'sine', freqHz: 200, amplitude: 0.8 }), 5, 96);
    expect(Math.abs(s[0])).toBeLessThan(1e-9);
    expect(Math.max(...s)).toBeGreaterThan(0.7);
    expect(Math.min(...s)).toBeLessThan(-0.7);
  });

  it('draws square rails only (both polarities present)', () => {
    const s = previewTrace(draftFromProps({ waveform: 'square', freqHz: 440, amplitude: 0.3 }));
    for (const v of s) expect([0.3, -0.3]).toContain(v);
    expect(s).toContain(0.3);
    expect(s).toContain(-0.3);
  });

  it('noise varies across samples within amplitude; silence is flat zero', () => {
    const n = previewTrace(draftFromProps({ waveform: 'noise', amplitude: 0.6 }));
    expect(new Set(n.map((v) => v.toFixed(6))).size).toBeGreaterThan(10);
    for (const v of n) expect(Math.abs(v)).toBeLessThanOrEqual(0.6);
    expect(previewTrace(draftFromProps({ waveform: 'silence' })).every((v) => v === 0)).toBe(true);
  });

  it('shows more cycles for a higher frequency within the same time window', () => {
    const crossings = (s: number[]): number =>
      s.slice(1).filter((v, i) => v !== 0 && Math.sign(v) !== Math.sign(s[i])).length;
    const slow = previewTrace(draftFromProps({ waveform: 'sine', freqHz: 200, amplitude: 0.5 }));
    const fast = previewTrace(draftFromProps({ waveform: 'sine', freqHz: 2000, amplitude: 0.5 }));
    expect(crossings(fast)).toBeGreaterThan(crossings(slow));
  });
});

/** Recording 2d-context stub: captures stroke paths and fill counts. */
function recordingCanvas(): {
  canvas: HTMLCanvasElement;
  strokes: { x: number; y: number }[][];
  counts: { fills: number };
} {
  const strokes: { x: number; y: number }[][] = [];
  const counts = { fills: 0 };
  let current: { x: number; y: number }[] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    fillRect: () => { counts.fills++; },
    beginPath: () => { current = []; strokes.push(current); },
    moveTo: (x: number, y: number) => { current.push({ x, y }); },
    lineTo: (x: number, y: number) => { current.push({ x, y }); },
    stroke: () => {},
  };
  const canvas = { getContext: () => ctx, width: 260, height: 56 } as unknown as HTMLCanvasElement;
  return { canvas, strokes, counts };
}

describe('renderWavePreview canvas binding', () => {
  it('paints the background, the zero line and one full trace polyline', () => {
    const { canvas, strokes, counts } = recordingCanvas();
    const samples = previewTrace(draftFromProps({ waveform: 'sine', freqHz: 440, amplitude: 0.5 }));
    renderWavePreview(canvas, samples);
    expect(counts.fills).toBe(1);
    expect(strokes).toHaveLength(2); // zero line + trace
    const [zeroLine, trace] = strokes;
    expect(zeroLine).toEqual([{ x: 0, y: 28 }, { x: 260, y: 28 }]);
    expect(trace).toHaveLength(samples.length);
    // A 0.5-amplitude sample maps to a quarter-height excursion from center.
    expect(trace.every((p) => p.y >= 28 - 0.5 * 26 - 1e-6 && p.y <= 28 + 0.5 * 26 + 1e-6)).toBe(true);
  });

  it('clamps over-amplitude samples into the canvas', () => {
    const { canvas, strokes } = recordingCanvas();
    renderWavePreview(canvas, [2, -2, 2]);
    const trace = strokes[1];
    expect(trace.map((p) => p.y)).toEqual([2, 54, 2]); // ±(h/2 - 2) around center 28
  });

  it('draws only the background and zero line for a degenerate sample list', () => {
    const { canvas, strokes, counts } = recordingCanvas();
    renderWavePreview(canvas, [0.5]);
    expect(counts.fills).toBe(1);
    expect(strokes).toHaveLength(1);
  });

  it('returns silently when the 2d context is unavailable', () => {
    const canvas = { getContext: () => null, width: 260, height: 56 } as unknown as HTMLCanvasElement;
    expect(() => renderWavePreview(canvas, [0, 1])).not.toThrow();
  });
});
