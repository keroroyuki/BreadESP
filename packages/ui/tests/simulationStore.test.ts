// PRD: §F-SIM-2/4, dev-plan task P2.6 — simulation store speed mirror.
import { describe, expect, it, beforeEach } from 'vitest';
import { useSimulationStore } from '../src/store/simulationStore';

describe('simulationStore (P2.6 speed)', () => {
  beforeEach(() => {
    useSimulationStore.getState().clear();
  });

  it('defaults to 1x speed with idle status', () => {
    const s = useSimulationStore.getState();
    expect(s.speed).toBe(1);
    expect(s.status).toBe('idle');
  });

  it('setSpeed mirrors the Bridge-pushed factor (sim:speed push)', () => {
    useSimulationStore.getState().setSpeed(0.5);
    expect(useSimulationStore.getState().speed).toBe(0.5);
    useSimulationStore.getState().setSpeed(4);
    expect(useSimulationStore.getState().speed).toBe(4);
  });

  it('clear() resets speed alongside status/uart/snapshots', () => {
    const st = useSimulationStore.getState();
    st.setSpeed(0.25);
    st.setStatus('running');
    st.appendUart('Hello ESP32');
    useSimulationStore.getState().clear();
    const after = useSimulationStore.getState();
    expect(after.speed).toBe(1);
    expect(after.status).toBe('idle');
    expect(after.uart).toBe('');
    expect(after.snapshots).toEqual({});
  });
});
