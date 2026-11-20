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
      className="inline-flex items-center gap-1.5 rounded-full border bg-white px-2 py-[3px] text-[11px] leading-4"
      style={{ borderColor: `${meta.color}55` }}
    >
      <span
        className={meta.pulse ? 'animate-pulse' : undefined}
        style={{ ...dot, background: meta.color } as CSSProperties}
        aria-label={label}
      />
      <span className="text-bb-ink">{label}</span>
    </span>
  );
}

const dot: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: '50%',
  display: 'inline-block',
  flexShrink: 0,
  boxShadow: '0 0 0 3px rgba(148, 163, 184, 0.16)',
};
