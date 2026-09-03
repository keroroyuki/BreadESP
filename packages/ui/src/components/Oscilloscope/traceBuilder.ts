// PRD: §F-PER-8, §6.4 — Oscilloscope trace geometry (dev-plan task P2.5).
// Pure functions that map a WaveformPayload onto canvas coordinates, split out
// of the React component so the visible behavior is unit-testable without a
// DOM. Digital channels draw as step traces: horizontal runs at the low/high
// rail with vertical transitions at each edge.
import type { WaveformChannel, WaveformPayload } from '@breadesp/peripherals';

export interface TracePoint {
  x: number;
  y: number;
}

export interface TraceGeometry {
  /** Left edge of the plot area (px). */
  x0: number;
  /** Y of this channel's low rail (px). */
  yLow: number;
  /** Y of this channel's high rail (px). */
  yHigh: number;
  /** Plot width (px). */
  width: number;
  /** Time base (ms) that maps onto `width`. */
  windowMs: number;
}

/** Stable per-channel trace colors (scope convention: CH1 yellow, ...). */
export const CHANNEL_COLORS = ['#facc15', '#38bdf8', '#f472b6', '#4ade80'];

export function channelColor(index: number): string {
  return CHANNEL_COLORS[index % CHANNEL_COLORS.length];
}

function isWaveformPayload(p: unknown): p is WaveformPayload {
  return (
    typeof p === 'object' && p !== null
    && Array.isArray((p as WaveformPayload).channels)
    && Number.isFinite((p as WaveformPayload).windowMs)
    && (p as WaveformPayload).windowMs > 0
  );
}

/** Narrow a snapshot payload to the P2.5 digital-channels variant, else null. */
export function waveformOf(payload: unknown): WaveformPayload | null {
  return isWaveformPayload(payload) ? payload : null;
}

/**
 * Build the step-trace polyline for one channel. The level before the first
 * edge is the inverse of that edge's level (an edge is a transition); the
 * final level runs to the right plot edge. An empty edge list yields a flat
 * low rail — a channel the model emitted without edges has no known signal.
 */
export function buildStepPoints(channel: WaveformChannel, geo: TraceGeometry): TracePoint[] {
  const { x0, yLow, yHigh, width, windowMs } = geo;
  const xOf = (t: number): number => x0 + (Math.min(Math.max(t, 0), windowMs) / windowMs) * width;
  const yOf = (level: 0 | 1): number => (level === 1 ? yHigh : yLow);

  const edges = channel.edges;
  if (edges.length === 0) {
    return [
      { x: x0, y: yLow },
      { x: x0 + width, y: yLow },
    ];
  }

  let level: 0 | 1 = edges[0].level === 1 ? 0 : 1;
  const points: TracePoint[] = [{ x: x0, y: yOf(level) }];
  for (const edge of edges) {
    const x = xOf(edge.t);
    points.push({ x, y: yOf(level) }); // horizontal run up to the edge
    level = edge.level;
    points.push({ x, y: yOf(level) }); // vertical transition
  }
  points.push({ x: x0 + width, y: yOf(level) }); // trailing run to the plot edge
  return points;
}

/** Vertical grid lines: `divisions` equal time slices across the plot. */
export function gridLines(x0: number, width: number, divisions: number): number[] {
  const n = Math.max(1, Math.floor(divisions));
  const xs: number[] = [];
  for (let i = 0; i <= n; i++) xs.push(x0 + (width * i) / n);
  return xs;
}

/** Per-channel plot band geometry: channels stack top-down inside the plot. */
export function channelGeometry(
  index: number,
  channelCount: number,
  plot: { x: number; y: number; width: number; height: number },
  windowMs: number,
): TraceGeometry {
  const bands = Math.max(1, channelCount);
  const bandH = plot.height / bands;
  const pad = Math.min(6, bandH * 0.2);
  const yTop = plot.y + index * bandH;
  return {
    x0: plot.x,
    yLow: yTop + bandH - pad,
    yHigh: yTop + pad,
    width: plot.width,
    windowMs,
  };
}
