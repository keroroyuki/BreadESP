// PRD: §F-PER-3, §F-PER-4 — Screen view. Renders the latest 'pixels' snapshot
// of every screen peripheral placed on the breadboard. Each screen instance
// owns its own canvas sized to the snapshot dimensions; the mono (SSD1306)
// path uses OledRenderer and the RGB565 (ST7789) path uses TftRenderer.
import { useEffect, useRef } from 'react';
import { useSimulationStore } from '../../store/simulationStore';
import { OledRenderer } from './OledRenderer';
import { TftRenderer } from './TftRenderer';
import type { RenderSnapshot } from '@breadesp/peripherals';

interface PixelsPayload {
  width: number;
  height: number;
  format: 'mono' | 'rgb565' | 'argb8888';
  buffer: number[];
}

function pixelsOf(s: RenderSnapshot): PixelsPayload | null {
  if (s.type !== 'pixels') return null;
  return s.payload as PixelsPayload;
}

function ScreenTile({ snap }: { snap: RenderSnapshot }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const p = pixelsOf(snap);

  useEffect(() => {
    if (!p || !ref.current) return;
    if (p.format === 'mono') {
      OledRenderer.renderMono(ref.current, p.width, p.height, new Uint8Array(p.buffer));
    } else if (p.format === 'rgb565') {
      TftRenderer.renderRgb565(ref.current, p.width, p.height, p.buffer);
    }
    // TODO(PRD §F-PER-4): handle 'argb8888' when a model emits it.
  }, [snap]);

  if (!p) return null;
  // Constrain the on-screen size so a 240x240 TFT still fits the side panel;
  // imageRendering: pixelated keeps the pixels crisp when upscaled.
  const maxW = 240;
  const scale = Math.min(1, maxW / p.width);
  const styleW = Math.round(p.width * scale);
  const styleH = Math.round(p.height * scale);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={label}>{snap.instanceId} ({p.format} {p.width}x{p.height})</div>
      <canvas
        ref={ref}
        width={p.width}
        height={p.height}
        style={{ width: styleW, height: styleH, imageRendering: 'pixelated', background: '#000', display: 'block' }}
      />
    </div>
  );
}

export function ScreenView() {
  const snapshots = useSimulationStore((s) => s.snapshots);
  const screens = Object.values(snapshots)
    .filter((s): s is RenderSnapshot => s?.type === 'pixels')
    .sort((a, b) => a.instanceId.localeCompare(b.instanceId));

  return (
    <div style={{ width: 280, borderLeft: '1px solid #ccc', padding: 8, overflowY: 'auto' }}>
      <h3 style={h3}>Screen</h3>
      {screens.length === 0 && <div style={muted}>No screen peripheral active.</div>}
      {screens.map((s) => (
        <ScreenTile key={s.instanceId} snap={s} />
      ))}
    </div>
  );
}

const h3: React.CSSProperties = { margin: '0 0 8px', fontSize: 13 };
const muted: React.CSSProperties = { color: '#999', fontSize: 12 };
const label: React.CSSProperties = { fontSize: 11, color: '#475569', marginBottom: 4 };
