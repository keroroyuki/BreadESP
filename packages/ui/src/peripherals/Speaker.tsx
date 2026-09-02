// PRD: §F-PER-6 — Speaker component: 'audio' snapshots queue PCM through the
// shared SpeakerPcmEngine (P2.4) and render a visual state (speaker icon +
// sample rate, glow scaled by the latest chunk's mean level). Playback itself
// is wired app-wide in App.tsx; this component only reflects the store.
import { useSimulationStore } from '../store/simulationStore';
import { audioFromSnapshot } from '../audio/SpeakerAudio';

export function Speaker({ instanceId }: { instanceId: string }) {
  const snap = useSimulationStore((s) => s.snapshots[instanceId]);
  const chunk = audioFromSnapshot(snap);
  const playing = chunk !== null && chunk.samples.length > 0;
  const level = playing
    ? Math.min(1, chunk.samples.reduce((acc, s) => acc + Math.abs(s), 0) / chunk.samples.length * 3)
    : 0;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#334155' }}>
      <span
        aria-label="speaker"
        style={{
          display: 'inline-block',
          width: 18,
          height: 18,
          borderRadius: '50%',
          textAlign: 'center',
          lineHeight: '18px',
          background: playing ? '#38bdf8' : '#e2e8f0',
          boxShadow: level > 0 ? `0 0 ${4 + level * 10}px rgba(14,165,233,${level})` : 'none',
          border: '1px solid #075985',
        }}
      >
        🔊
      </span>
      <span>{playing && chunk ? `${(chunk.sampleRate / 1000).toFixed(1)} kHz` : 'silent'}</span>
    </div>
  );
}
