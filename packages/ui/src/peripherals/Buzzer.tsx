// PRD: §F-PER-5 — Buzzer component: reads 'tone' snapshots, synthesizes the
// square wave through the shared BuzzerToneEngine and renders a visual state
// (speaker icon + frequency, glow scaled by duty).
import { useEffect } from 'react';
import { useSimulationStore } from '../store/simulationStore';
import { isSounding, sharedBuzzerEngine, toneFromSnapshot } from '../audio/BuzzerAudio';

export function Buzzer({ instanceId }: { instanceId: string }) {
  const snap = useSimulationStore((s) => s.snapshots[instanceId]);
  const tone = toneFromSnapshot(snap);
  const sounding = isSounding(tone);

  useEffect(() => {
    sharedBuzzerEngine().update(instanceId, tone);
  }, [instanceId, tone?.freqHz, tone?.duty]); // eslint-disable-line react-hooks/exhaustive-deps

  const glow = sounding && tone ? tone.duty : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#334155' }}>
      <span
        aria-label="buzzer"
        style={{
          display: 'inline-block',
          width: 18,
          height: 18,
          borderRadius: '50%',
          textAlign: 'center',
          lineHeight: '18px',
          background: sounding ? '#fbbf24' : '#e2e8f0',
          boxShadow: glow > 0 ? `0 0 ${4 + glow * 10}px rgba(245,158,11,${glow})` : 'none',
          border: '1px solid #92400e',
        }}
      >
        ♪
      </span>
      <span>{sounding && tone ? `${Math.round(tone.freqHz)} Hz` : 'silent'}</span>
    </div>
  );
}
