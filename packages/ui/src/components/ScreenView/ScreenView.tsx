// PRD: §F-PER-3 — Screen view. Renders the latest 'pixels' snapshot of any screen peripheral.
import { useSimulationStore } from '../../store/simulationStore';
import { OledRenderer } from './OledRenderer';
import { useEffect, useRef } from 'react';

export function ScreenView() {
  const snapshots = useSimulationStore((s) => s.snapshots);
  const screens = Object.values(snapshots).filter((s) => s.type === 'pixels');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const oled = screens.find((s) => (s.payload as { format?: string }).format === 'mono');

  useEffect(() => {
    if (oled && canvasRef.current) {
      const p = oled.payload as { width: number; height: number; format: string; buffer: number[] };
      OledRenderer.renderMono(canvasRef.current, p.width, p.height, new Uint8Array(p.buffer));
    }
  }, [oled]);

  return (
    <div style={{ width: 280, borderLeft: '1px solid #ccc', padding: 8 }}>
      <h3 style={h3}>Screen</h3>
      <canvas ref={canvasRef} width={128} height={64} style={{ width: 128, height: 64, imageRendering: 'pixelated', background: '#000' }} />
      {!oled && <div style={muted}>No screen peripheral active.</div>}
    </div>
  );
}

const h3: React.CSSProperties = { margin: '0 0 8px', fontSize: 13 };
const muted: React.CSSProperties = { color: '#999', fontSize: 12 };
