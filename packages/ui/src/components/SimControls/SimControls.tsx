// PRD: §F-SIM-1/2/4, dev-plan task P2.6 — simulation control bar.
// Pause/resume ride QMP stop/cont (QemuRunner), the speed selector drives the
// duty-cycle logical-clock throttle (factors > 1 saturate at wall clock —
// QEMU cannot execute the guest faster than the host).
import { useState } from 'react';
import type { CSSProperties } from 'react';
import { bridge } from '../../ipc/bridge';
import { useSimulationStore } from '../../store/simulationStore';

/** PRD §F-SIM-2 range 0.1x–10x; > 1x saturates at host wall clock. */
const SPEED_CHOICES = [0.1, 0.25, 0.5, 1, 2, 4, 10];

export function SimControls() {
  const status = useSimulationStore((s) => s.status);
  const speed = useSimulationStore((s) => s.speed);
  const [error, setError] = useState<string | null>(null);

  const live = status === 'running' || status === 'paused';

  const run = (fn: () => Promise<unknown>): void => {
    setError(null);
    fn().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  };

  const onTogglePause = (): void => {
    run(() => (status === 'running' ? bridge.sim.pause() : bridge.sim.start()));
  };

  const onSpeed = (factor: number): void => {
    // Optimistic mirror: the authoritative value arrives on the sim:speed push.
    useSimulationStore.getState().setSpeed(factor);
    run(() => bridge.sim.setSpeed({ factor }));
  };

  return (
    <div style={bar}>
      <button style={btn} disabled={!live} onClick={onTogglePause}>
        {status === 'running' ? 'Pause' : 'Resume'}
      </button>
      <button style={btn} disabled={status === 'idle'} onClick={() => run(() => bridge.sim.reset())}>
        Reset
      </button>
      <label style={label}>
        speed
        <select
          style={select}
          value={speed}
          onChange={(e) => onSpeed(Number(e.target.value))}
        >
          {SPEED_CHOICES.map((f) => (
            <option key={f} value={f}>{f}x</option>
          ))}
        </select>
      </label>
      {error !== null && <span style={errStyle}>{error}</span>}
    </div>
  );
}

const bar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 10px',
  borderBottom: '1px solid #ccc',
  background: '#eef2f7',
};

const btn: CSSProperties = { padding: '3px 10px', fontSize: 12, cursor: 'pointer' };
const label: CSSProperties = { fontSize: 12, color: '#334155', display: 'flex', alignItems: 'center', gap: 4 };
const select: CSSProperties = { fontSize: 12, padding: '2px 4px' };
const errStyle: CSSProperties = { fontSize: 12, color: '#b91c1c' };
