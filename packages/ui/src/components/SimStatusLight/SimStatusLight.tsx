// Simulation status light — at-a-glance health of the sim (T1.4).
// Color + pulse encode the SimStatus union; the label is i18n-driven and the
// full text stays available as the element title.
import type { CSSProperties } from 'react';
import { useSimulationStore, type SimStatus } from '../../store/simulationStore';
import { useT } from '../../i18n';

const STATUS_META: Record<SimStatus, { color: string; pulse: boolean }> = {
  idle: { color: '#94a3b8', pulse: false },
  loaded: { color: '#3b82f6', pulse: false },
  running: { color: '#22c55e', pulse: true },
  paused: { color: '#f59e0b', pulse: false },
  stopped: { color: '#64748b', pulse: false },
  error: { color: '#ef4444', pulse: false },
};

export function SimStatusLight() {
  const status = useSimulationStore((s) => s.status);
  const t = useT();
  const meta = STATUS_META[status];
  const label = t(`sim.status.${status}` as const);
  return (
    <span
      title={label}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}
    >
      <span
        className={meta.pulse ? 'animate-pulse' : undefined}
        style={{ ...dot, background: meta.color } as CSSProperties}
        aria-label={label}
      />
      {label}
    </span>
  );
}

const dot: CSSProperties = {
  width: 9,
  height: 9,
  borderRadius: '50%',
  display: 'inline-block',
  flexShrink: 0,
};
