// PRD: §F-PER-8 — Oscilloscope panel (dev-plan task P2.5). Renders the latest
// 'waveform' snapshot of every oscilloscope instance on the breadboard as
// stacked digital step traces over a shared time base (the model's windowMs).
import { useEffect, useRef } from 'react';
import type { RenderSnapshot } from '@breadesp/peripherals';
import { useProjectStore } from '../../store/projectStore';
import { useSimulationStore } from '../../store/simulationStore';
import { buildStepPoints, channelColor, channelGeometry, gridLines, waveformOf } from './traceBuilder';

const CANVAS_W = 420;
const CANVAS_H = 180;
const PLOT = { x: 44, y: 10, width: CANVAS_W - 54, height: CANVAS_H - 34 };
const TIME_DIVISIONS = 10;

/** Draw one scope tile. Exported for the canvas-binding unit tests. */
export function renderScope(
  canvas: HTMLCanvasElement,
  snap: RenderSnapshot,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const wf = waveformOf(snap.payload);

  ctx.fillStyle = '#0b1120';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  if (!wf) return;

  // Grid: vertical time divisions + channel band separators.
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const x of gridLines(PLOT.x, PLOT.width, TIME_DIVISIONS)) {
    ctx.moveTo(x, PLOT.y);
    ctx.lineTo(x, PLOT.y + PLOT.height);
  }
  ctx.stroke();

  const channels = wf.channels;
  channels.forEach((ch, i) => {
    const geo = channelGeometry(i, channels.length, PLOT, wf.windowMs);
    const color = channelColor(i);
    if (i > 0) {
      ctx.strokeStyle = '#1e293b';
      ctx.beginPath();
      ctx.moveTo(PLOT.x, PLOT.y + (PLOT.height * i) / channels.length);
      ctx.lineTo(PLOT.x + PLOT.width, PLOT.y + (PLOT.height * i) / channels.length);
      ctx.stroke();
    }
    // Channel label at the left gutter.
    ctx.fillStyle = color;
    ctx.font = '10px monospace';
    ctx.fillText(ch.label, 6, (geo.yLow + geo.yHigh) / 2 + 3);
    // Step trace.
    const pts = buildStepPoints(ch, geo);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach((p, j) => (j === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
  });

  // Time base annotation: total window + per-division.
  ctx.fillStyle = '#64748b';
  ctx.font = '10px monospace';
  const perDiv = wf.windowMs / TIME_DIVISIONS;
  ctx.fillText(
    `${formatMs(wf.windowMs)} window  (${formatMs(perDiv)}/div)`,
    PLOT.x,
    CANVAS_H - 8,
  );
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function ScopeTile({ snap }: { snap: RenderSnapshot }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) renderScope(ref.current, snap);
  }, [snap]);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={label}>{snap.instanceId}</div>
      <canvas
        ref={ref}
        width={CANVAS_W}
        height={CANVAS_H}
        style={{ width: CANVAS_W, height: CANVAS_H, display: 'block', borderRadius: 4 }}
      />
    </div>
  );
}

export function Oscilloscope() {
  const snapshots = useSimulationStore((s) => s.snapshots);
  // Select the stable peripherals array (filtering inline would return a fresh
  // array every call and re-render forever).
  const peripherals = useProjectStore((s) => s.netlist.peripherals);
  const scopeIds = peripherals.filter((p) => p.kind === 'oscilloscope').map((p) => p.instanceId);
  const tiles = scopeIds
    .map((id) => snapshots[id])
    .filter((s): s is RenderSnapshot => s?.type === 'waveform')
    .sort((a, b) => a.instanceId.localeCompare(b.instanceId));

  return (
    <div style={{ width: 440, borderLeft: '1px solid #ccc', padding: 8, overflowY: 'auto' }}>
      <h3 style={h3}>Oscilloscope</h3>
      {scopeIds.length === 0 && <div style={muted}>Place an Oscilloscope and wire CH1..CH4 to GPIO pins.</div>}
      {scopeIds.length > 0 && tiles.length === 0 && <div style={muted}>Waiting for signal…</div>}
      {tiles.map((s) => (
        <ScopeTile key={s.instanceId} snap={s} />
      ))}
    </div>
  );
}

const h3: React.CSSProperties = { margin: '0 0 8px', fontSize: 13 };
const label: React.CSSProperties = { fontSize: 11, color: '#475569', marginBottom: 4 };
const muted: React.CSSProperties = { color: '#999', fontSize: 12 };
