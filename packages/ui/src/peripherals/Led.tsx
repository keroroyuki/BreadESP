// PRD: §F-PER-1 — LED visual component (reads 'level' snapshots).
import { useSimulationStore } from '../store/simulationStore';

export function Led({ instanceId }: { instanceId: string }) {
  const snap = useSimulationStore((s) => s.snapshots[instanceId]);
  const level = snap?.type === 'level' ? (snap.payload as { level: number }).level : 0;
  const c = Math.round(level * 255);
  return (
    <div style={{
      width: 24, height: 24, borderRadius: '50%',
      background: `rgb(${c},${Math.round(c * 0.1)},0)`,
      boxShadow: level > 0 ? `0 0 ${4 + level * 12}px rgba(255,40,0,${level})` : 'none',
      border: '1px solid #333',
    }} />
  );
}
