// PRD: §F-PROJ — UI-side project state (netlist + layout).
import { create } from 'zustand';
import type { Netlist } from '@breadesp/netlist';

export interface LayoutItem { instanceId: string; x: number; y: number; kind: string; }

interface ProjectState {
  dir: string | null;
  netlist: Netlist;
  layout: LayoutItem[];
  setDir: (d: string) => void;
  setNetlist: (n: Netlist) => void;
  addPeripheral: (kind: string, x: number, y: number) => string;
}

let idc = 0;
export const useProjectStore = create<ProjectState>((set, get) => ({
  dir: null,
  netlist: { version: 1, chip: 'esp32', peripherals: [], wires: [] },
  layout: [],
  setDir: (dir) => set({ dir }),
  setNetlist: (netlist) => set({ netlist }),
  addPeripheral: (kind, x, y) => {
    const instanceId = `${kind}-${++idc}`;
    const item: LayoutItem = { instanceId, x, y, kind };
    const netlist = { ...get().netlist, peripherals: [...get().netlist.peripherals, { instanceId, kind }] };
    set({ layout: [...get().layout, item], netlist });
    return instanceId;
  },
}));
