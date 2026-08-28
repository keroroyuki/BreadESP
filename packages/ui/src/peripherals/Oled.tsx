// PRD: §F-PER-3 — OLED visual wrapper: a canvas driven by OledRenderer.
import { useEffect, useRef } from 'react';
import { useSimulationStore } from '../store/simulationStore';
import { OledRenderer } from '../components/ScreenView/OledRenderer';

export function Oled({ instanceId }: { instanceId: string }) {
  const snap = useSimulationStore((s) => s.snapshots[instanceId]);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!snap || snap.type !== 'pixels' || !ref.current) return;
    const p = snap.payload as { width: number; height: number; format: string; buffer: number[] };
    if (p.format === 'mono') OledRenderer.renderMono(ref.current, p.width, p.height, new Uint8Array(p.buffer));
  }, [snap]);
  return <canvas ref={ref} width={128} height={64} style={{ imageRendering: 'pixelated', background: '#000' }} />;
}
