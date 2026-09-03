// PRD: §F-SIM-4, §6.4 — Simulation state: status + peripheral snapshot cache.
// P2.6 (PRD §F-SIM-2): speed multiplier mirrors QemuRunner (pushed via sim:speed).
import { create } from 'zustand';
import type { RenderSnapshot } from '@breadesp/peripherals';

export type SimStatus = 'idle' | 'loaded' | 'running' | 'paused' | 'stopped' | 'error';

interface SimState {
  status: SimStatus;
  /** Speed multiplier (PRD §F-SIM-2); 1 = wall clock. */
  speed: number;
  uart: string;
  snapshots: Record<string, RenderSnapshot>; // by instanceId (latest)
  setStatus: (s: SimStatus) => void;
  setSpeed: (f: number) => void;
  appendUart: (s: string) => void;
  applySnapshot: (s: RenderSnapshot) => void;
  clear: () => void;
}

export const useSimulationStore = create<SimState>((set) => ({
  status: 'idle',
  speed: 1,
  uart: '',
  snapshots: {},
  setStatus: (status) => set({ status }),
  setSpeed: (speed) => set({ speed }),
  appendUart: (s) => set((st) => ({ uart: (st.uart + s).slice(-8192) })),
  applySnapshot: (s) => set((st) => ({ snapshots: { ...st.snapshots, [s.instanceId]: s } })),
  clear: () => set({ status: 'idle', speed: 1, uart: '', snapshots: {} }),
}));
