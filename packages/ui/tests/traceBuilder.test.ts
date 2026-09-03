// PRD: §F-PER-8, §6.4 — Oscilloscope trace geometry + canvas binding (P2.5).
// buildStepPoints is the step-trace decoder the panel draws; the canvas
// binding (renderScope) is a thin stroke/fill wrapper, so exercising the
// geometry against known edge lists plus a recording 2d-context mock covers
// the visible behavior.
import { describe, expect, it } from 'vitest';
import type { RenderSnapshot, WaveformChannel, WaveformPayload } from '@breadesp/peripherals';
import {
  buildStepPoints,
  channelColor,
  channelGeometry,
  gridLines,
  waveformOf,
  type TraceGeometry,
} from '../src/components/Oscilloscope/traceBuilder';
import { renderScope } from '../src/components/Oscilloscope/Oscilloscope';

const GEO: TraceGeometry = { x0: 10, yLow: 50, yHigh: 10, width: 200, windowMs: 100 };

function ch(label: string, edges: WaveformChannel['edges']): WaveformChannel {
  return { label, edges };
}

describe('traceBuilder.waveformOf', () => {
  it('accepts the P2.5 channels payload and rejects other shapes', () => {
    const payload: WaveformPayload = { startMs: 0, windowMs: 200, channels: [] };
    expect(waveformOf(payload)).toBe(payload);
    expect(waveformOf({ samples: [1, 2, 3] })).toBeNull(); // legacy analog variant
    expect(waveformOf({ level: 1 })).toBeNull();
    expect(waveformOf({ channels: 'nope', windowMs: 200 })).toBeNull();
    expect(waveformOf({ channels: [], windowMs: 0 })).toBeNull(); // degenerate time base
    expect(waveformOf(null)).toBeNull();
  });
});

describe('traceBuilder.buildStepPoints', () => {
  it('draws an edge-free channel as a flat low rail across the plot', () => {
    expect(buildStepPoints(ch('CH1', []), GEO)).toEqual([
      { x: 10, y: 50 },
      { x: 210, y: 50 },
    ]);
  });

  it('starts low before a first rising edge and steps up at the edge x', () => {
    const pts = buildStepPoints(ch('CH1', [{ t: 50, level: 1 }]), GEO);
    // x scale: 200px / 100ms -> edge at t=50 lands at x=110.
    expect(pts).toEqual([
      { x: 10, y: 50 },   // low rail from the left edge
      { x: 110, y: 50 },  // run up to the edge
      { x: 110, y: 10 },  // vertical transition
      { x: 210, y: 10 },  // trailing high run to the right edge
    ]);
  });

  it('starts high when the first edge is falling', () => {
    const pts = buildStepPoints(ch('CH1', [{ t: 50, level: 0 }]), GEO);
    expect(pts[0]).toEqual({ x: 10, y: 10 });
    expect(pts[2]).toEqual({ x: 110, y: 50 });
  });

  it('reconstructs a square wave with alternating rails', () => {
    const pts = buildStepPoints(
      ch('CH1', [
        { t: 25, level: 1 },
        { t: 50, level: 0 },
        { t: 75, level: 1 },
      ]),
      GEO,
    );
    const ys = pts.map((p) => p.y);
    expect(ys).toEqual([50, 50, 10, 10, 50, 50, 10, 10]);
    expect(pts.map((p) => p.x)).toEqual([10, 60, 60, 110, 110, 160, 160, 210]);
  });

  it('clamps out-of-window edge times to the plot bounds', () => {
    const pts = buildStepPoints(ch('CH1', [{ t: 250, level: 1 }]), GEO);
    expect(pts[1].x).toBe(210); // t beyond windowMs clamps to the right edge
  });
});

describe('traceBuilder.gridLines / channelGeometry / channelColor', () => {
  it('splits the plot into equal time divisions, endpoints included', () => {
    expect(gridLines(10, 200, 10)).toHaveLength(11);
    expect(gridLines(10, 200, 10)[0]).toBe(10);
    expect(gridLines(10, 200, 10).at(-1)).toBe(210);
    expect(gridLines(10, 200, 0)).toEqual([10, 210]); // degenerate -> single division
  });

  it('stacks channel bands top-down without overlap', () => {
    const plot = { x: 0, y: 0, width: 100, height: 80 };
    const g0 = channelGeometry(0, 2, plot, 200);
    const g1 = channelGeometry(1, 2, plot, 200);
    expect(g0.yLow).toBeLessThanOrEqual(40); // first band within [0,40]
    expect(g1.yHigh).toBeGreaterThanOrEqual(40); // second band within [40,80]
    expect(g0.yHigh).toBeLessThan(g0.yLow); // high rail above low rail
    expect(g1.windowMs).toBe(200);
  });

  it('assigns stable distinct colors to the four channels', () => {
    const colors = [0, 1, 2, 3].map(channelColor);
    expect(new Set(colors).size).toBe(4);
    expect(channelColor(4)).toBe(channelColor(0)); // wraps stably
  });
});

/** Recording 2d-context stub: captures stroke paths and fill texts. */
function recordingCanvas(): {
  canvas: HTMLCanvasElement;
  strokes: { x: number; y: number }[][];
  texts: string[];
  counts: { fills: number };
} {
  const strokes: { x: number; y: number }[][] = [];
  const texts: string[] = [];
  const counts = { fills: 0 };
  let current: { x: number; y: number }[] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    fillRect: () => { counts.fills++; },
    fillText: (t: string) => { texts.push(t); },
    beginPath: () => { current = []; strokes.push(current); },
    moveTo: (x: number, y: number) => { current.push({ x, y }); },
    lineTo: (x: number, y: number) => { current.push({ x, y }); },
    stroke: () => {},
  };
  const canvas = { getContext: () => ctx } as unknown as HTMLCanvasElement;
  return { canvas, strokes, texts, counts };
}

function scopeSnap(payload: WaveformPayload): RenderSnapshot {
  return { instanceId: 'scope1', type: 'waveform', payload };
}

describe('renderScope canvas binding', () => {
  it('paints the background, channel labels and the time-base annotation', () => {
    const { canvas, texts, counts } = recordingCanvas();
    renderScope(canvas, scopeSnap({
      startMs: 0, windowMs: 200,
      channels: [ch('CH1', [{ t: 10, level: 1 }])],
    }));
    expect(counts.fills).toBeGreaterThan(0);
    expect(texts).toContain('CH1');
    expect(texts.some((t) => t.includes('200ms') && t.includes('/div'))).toBe(true);
  });

  it('strokes one step trace per channel plus the grid', () => {
    const { canvas, strokes } = recordingCanvas();
    renderScope(canvas, scopeSnap({
      startMs: 0, windowMs: 200,
      channels: [ch('CH1', [{ t: 10, level: 1 }, { t: 20, level: 0 }]), ch('CH2', [])],
    }));
    // grid path + band separator + two channel traces.
    expect(strokes.length).toBeGreaterThanOrEqual(4);
    // The CH1 trace reflects both edges (4+ points: start, run, transition, run, transition, run).
    const ch1 = strokes.find((s) => s.length >= 6);
    expect(ch1).toBeDefined();
  });

  it('draws only the background when the payload is not a waveform', () => {
    const { canvas, strokes, counts } = recordingCanvas();
    renderScope(canvas, {
      instanceId: 'scope1', type: 'level', payload: { level: 1 },
    });
    expect(counts.fills).toBe(1); // background fill only
    expect(strokes).toHaveLength(0);
  });

  it('returns silently when the 2d context is unavailable', () => {
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() =>
      renderScope(canvas, scopeSnap({ startMs: 0, windowMs: 200, channels: [] })),
    ).not.toThrow();
  });
});
