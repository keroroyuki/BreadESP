// PRD: §F-SIM-4, §6.4 — Simulation state: status + peripheral snapshot cache.
import { create } from 'zustand';
import type { RenderSnapshot } from '@breadesp/peripherals';

export type SimStatus = 'idle' | 'loaded' | 'running' | 'paused' | 'stopped' | 'error';

interface SimState {
  status: SimStatus;
  uart: string;
  snapshots: Record<string, RenderSnapshot>; // by instanceId (latest)
  setStatus: (s: SimStatus) => void;
  appendUart: (s: string) => void;
  applySnapshot: (s: RenderSnapshot) => void;
  clear: () => void;
}

export const useSimulationStore = create<SimState>((set) => ({
  status: 'idle',
  uart: '',
  snapshots: {},
  setStatus: (status) => set({ status }),
  appendUart: (s) => set((st) => ({ uart: (st.uart + s).slice(-8192) })),
  applySnapshot: (s) => set((st) => ({ snapshots: { ...st.snapshots, [s.instanceId]: s } })),
  clear: () => set({ status: 'idle', uart: '', snapshots: {} }),
}));
