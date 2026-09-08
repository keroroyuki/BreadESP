// PRD: §F-PROJ, §F-BB-4 — UI-side project state.
// The netlist (logic: instances + wires) and the layout (visual coordinates)
// are separate structures: wiring edits never touch positions, moves never
// touch wires. Persistence serializes each half independently (netlist.json /
// layout.json, PRD §F-PROJ-1); App forwards netlist edits to the Bridge via
// `bb:applyNetlist` so peripheral instances and routing follow the logic half.
import { create } from 'zustand';
import type { LayoutFile, LayoutItem, Netlist, WireEndpoint } from '@breadesp/netlist';

const EMPTY_NETLIST: Netlist = { version: 1, chip: 'esp32', peripherals: [], wires: [] };

interface ProjectState {
  dir: string | null;
  netlist: Netlist;
  layout: LayoutItem[];
  setDir: (dir: string) => void;
  setNetlist: (netlist: Netlist) => void;
  setLayout: (items: LayoutItem[]) => void;
  /** Hydrate both halves from a Bridge-validated opened project (PRD §F-PROJ-2). */
  loadProject: (p: { dir: string; netlist: Netlist; layout: LayoutFile }) => void;
  /** New/close: empty halves, optionally pointing at a fresh skeleton dir. */
  resetProject: (dir: string | null) => void;
  addPeripheral: (kind: string, x: number, y: number) => string;
  movePeripheral: (instanceId: string, x: number, y: number) => void;
  removePeripheral: (instanceId: string) => void;
  /**
   * Merge a props patch into one instance (logic-only edit; layout untouched).
   * P3.3 waveform generator panel (PRD §F-PER-7): props persist in
   * netlist.json, and the resulting netlist identity change re-applies the
   * netlist so the Bridge rebuilds the instance with the new config.
   */
  updatePeripheralProps: (instanceId: string, patch: Record<string, unknown>) => void;
  addWire: (from: WireEndpoint, to: WireEndpoint) => string | null;
  removeWire: (wireId: string) => void;
}

const sameEndpoint = (a: WireEndpoint, b: WireEndpoint): boolean =>
  a.instanceId === b.instanceId && a.pin === b.pin;

/** Deterministic `prefix-<smallest free n>` id, collision-safe against loaded projects. */
function nextId(prefix: string, taken: string[]): string {
  const used = new Set(taken);
  let n = 1;
  while (used.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  dir: null,
  netlist: EMPTY_NETLIST,
  layout: [],
  setDir: (dir) => set({ dir }),
  setNetlist: (netlist) => set({ netlist }),
  setLayout: (items) => set({ layout: items }),
  loadProject: (p) => set({ dir: p.dir, netlist: p.netlist, layout: p.layout.items }),
  resetProject: (dir) => set({ dir, netlist: EMPTY_NETLIST, layout: [] }),

  addPeripheral: (kind, x, y) => {
    const { netlist, layout } = get();
    const instanceId = nextId(
      kind,
      netlist.peripherals.map((p) => p.instanceId).concat(layout.map((l) => l.instanceId)),
    );
    set({
      netlist: { ...netlist, peripherals: [...netlist.peripherals, { instanceId, kind }] },
      layout: [...layout, { instanceId, x, y, kind }],
    });
    return instanceId;
  },

  // Visual-only edit: the netlist object is left untouched (F-BB-4).
  movePeripheral: (instanceId, x, y) => {
    set({ layout: get().layout.map((it) => (it.instanceId === instanceId ? { ...it, x, y } : it)) });
  },

  removePeripheral: (instanceId) => {
    const { netlist, layout } = get();
    set({
      netlist: {
        ...netlist,
        peripherals: netlist.peripherals.filter((p) => p.instanceId !== instanceId),
        // Wires to a removed instance would fail netlist validation (dangling endpoints).
        wires: netlist.wires.filter(
          (w) => w.from.instanceId !== instanceId && w.to.instanceId !== instanceId,
        ),
      },
      layout: layout.filter((it) => it.instanceId !== instanceId),
    });
  },

  updatePeripheralProps: (instanceId, patch) => {
    const { netlist } = get();
    // Unknown instances are a no-op: a panel card can outlive its instance
    // across a concurrent netlist edit.
    if (!netlist.peripherals.some((p) => p.instanceId === instanceId)) return;
    set({
      netlist: {
        ...netlist,
        peripherals: netlist.peripherals.map((p) =>
          p.instanceId === instanceId ? { ...p, props: { ...p.props, ...patch } } : p,
        ),
      },
    });
  },

  // Logic-only edit: the layout array is left untouched (F-BB-4).
  // Returns the new wire id, or null when the wire is a self-loop or duplicate.
  addWire: (from, to) => {
    if (sameEndpoint(from, to)) return null;
    const { netlist } = get();
    const duplicate = netlist.wires.some(
      (w) =>
        (sameEndpoint(w.from, from) && sameEndpoint(w.to, to)) ||
        (sameEndpoint(w.from, to) && sameEndpoint(w.to, from)),
    );
    if (duplicate) return null;
    const id = nextId('wire', netlist.wires.map((w) => w.id));
    set({ netlist: { ...netlist, wires: [...netlist.wires, { id, from, to }] } });
    return id;
  },

  removeWire: (wireId) => {
    set({ netlist: { ...get().netlist, wires: get().netlist.wires.filter((w) => w.id !== wireId) } });
  },
}));

/** Serialize the logic half (netlist.json) — never contains coordinates. */
export function toNetlistFile(netlist: Netlist): Netlist {
  return { ...netlist };
}

/** Serialize the visual half (layout.json) — never contains wires or instances' logic. */
export function toLayoutFile(layout: LayoutItem[]): LayoutFile {
  return {
    version: 1,
    items: layout.map(({ instanceId, x, y, kind }) => ({ instanceId, x, y, kind })),
  };
}
