// PRD: §F-PROJ, §F-BB-4, §F-BB-5 — UI-side project state.
// The netlist (logic: instances + wires) and the layout (visual coordinates)
// are separate structures: wiring edits never touch positions, moves never
// touch wires. Persistence serializes each half independently (netlist.json /
// layout.json, PRD §F-PROJ-1); App forwards netlist edits to the Bridge via
// `bb:applyNetlist` so peripheral instances and routing follow the logic half.
// Undo/redo (F-BB-5) snapshots both halves before every breadboard edit;
// restoring a snapshot swaps in old object identities, which re-fires App's
// applyNetlist effect, so the Bridge follows undo/redo with zero extra glue.
import { create } from 'zustand';
import type { LayoutFile, LayoutItem, Netlist, WireEndpoint } from '@breadesp/netlist';
import type { ExternalProjectLink } from '../ipc/bridge';

const EMPTY_NETLIST: Netlist = { version: 1, chip: 'esp32', peripherals: [], wires: [] };

/** F-BB-5 (PRD): undo/redo history MUST cover at least 20 steps. */
export const UNDO_LIMIT = 20;

/** One undoable step: the two breadboard halves. dir/external/firmware are project metadata, never canvas edits. */
interface HistoryEntry {
  netlist: Netlist;
  layout: LayoutItem[];
}

/**
 * Coalescing state for drag moves. movePeripheral fires once per animation
 * frame while a node is dragged (wire endpoints follow live, F-BB-4), so a
 * single drag would otherwise flood the stack. Consecutive moves of the same
 * instance collapse into one entry; any other edit — or undo/redo itself —
 * ends the run. Module-level on purpose: it is a gesture tracker, not state
 * components should observe.
 */
let lastMove: { instanceId: string } | null = null;

interface ProjectState {
  dir: string | null;
  netlist: Netlist;
  layout: LayoutItem[];
  /** P4.3 (PRD §F-PROJ-3): linked external PlatformIO/ESP-IDF project, else null. */
  external: ExternalProjectLink | null;
  /** Absolute path of the project's imported firmware.elf, else null. */
  firmwareElf: string | null;
  setDir: (dir: string) => void;
  setNetlist: (netlist: Netlist) => void;
  setLayout: (items: LayoutItem[]) => void;
  setExternal: (link: ExternalProjectLink | null) => void;
  setFirmwareElf: (path: string | null) => void;
  /** Hydrate both halves from a Bridge-validated opened project (PRD §F-PROJ-2). */
  loadProject: (p: {
    dir: string;
    netlist: Netlist;
    layout: LayoutFile;
    external?: ExternalProjectLink | null;
    firmwareElf?: string | null;
  }) => void;
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
  /** F-BB-5 (PRD): undoable history of the two breadboard halves. */
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Restore the last snapshot (no-op when history is empty). */
  undo: () => void;
  /** Re-apply the most recently undone snapshot (no-op when future is empty). */
  redo: () => void;
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

/**
 * Push the current halves as one undoable step (F-BB-5). Called before every
 * breadboard edit; any new edit also invalidates the redo stack. Snapshots
 * hold object identities that are never mutated in place (F-BB-4 invariant:
 * every edit builds new objects), so entries stay frozen for free.
 * Module-level on purpose: history is store-owned, not a component concern.
 */
const pushHistory = (): void => {
  lastMove = null;
  const { netlist, layout, past } = useProjectStore.getState();
  useProjectStore.setState({ past: [...past, { netlist, layout }].slice(-UNDO_LIMIT), future: [] });
};

/** Drag moves coalesce: only the first frame of a consecutive run pushes. */
const pushHistoryForMove = (instanceId: string): void => {
  if (lastMove?.instanceId === instanceId) return;
  pushHistory();
  lastMove = { instanceId };
};

export const useProjectStore = create<ProjectState>((set, get) => ({
  dir: null,
  netlist: EMPTY_NETLIST,
  layout: [],
  external: null,
  firmwareElf: null,
  past: [],
  future: [],
  setDir: (dir) => set({ dir }),
  setNetlist: (netlist) => set({ netlist }),
  setLayout: (items) => set({ layout: items }),
  setExternal: (link) => set({ external: link }),
  setFirmwareElf: (path) => set({ firmwareElf: path }),
  loadProject: (p) => {
    // A different project must never inherit the previous one's history.
    lastMove = null;
    set({
      dir: p.dir,
      netlist: p.netlist,
      layout: p.layout.items,
      external: p.external ?? null,
      firmwareElf: p.firmwareElf ?? null,
      past: [],
      future: [],
    });
  },
  resetProject: (dir) => {
    lastMove = null;
    set({ dir, netlist: EMPTY_NETLIST, layout: [], external: null, firmwareElf: null, past: [], future: [] });
  },

  addPeripheral: (kind, x, y) => {
    const { netlist, layout } = get();
    const instanceId = nextId(
      kind,
      netlist.peripherals.map((p) => p.instanceId).concat(layout.map((l) => l.instanceId)),
    );
    pushHistory();
    set({
      netlist: { ...netlist, peripherals: [...netlist.peripherals, { instanceId, kind }] },
      layout: [...layout, { instanceId, x, y, kind }],
    });
    return instanceId;
  },

  // Visual-only edit: the netlist object is left untouched (F-BB-4).
  movePeripheral: (instanceId, x, y) => {
    pushHistoryForMove(instanceId);
    set({ layout: get().layout.map((it) => (it.instanceId === instanceId ? { ...it, x, y } : it)) });
  },

  removePeripheral: (instanceId) => {
    const { netlist, layout } = get();
    pushHistory();
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
    pushHistory();
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
    pushHistory();
    set({ netlist: { ...netlist, wires: [...netlist.wires, { id, from, to }] } });
    return id;
  },

  removeWire: (wireId) => {
    pushHistory();
    set({ netlist: { ...get().netlist, wires: get().netlist.wires.filter((w) => w.id !== wireId) } });
  },

  // F-BB-5 (PRD): undo/redo swap identities, not contents — every restored
  // snapshot is a fresh object reference, so App's applyNetlist effect follows.
  undo: () => {
    const { past, netlist, layout, future } = get();
    if (past.length === 0) return;
    lastMove = null;
    const prev = past[past.length - 1];
    set({
      netlist: prev.netlist,
      layout: prev.layout,
      past: past.slice(0, -1),
      future: [{ netlist, layout }, ...future].slice(0, UNDO_LIMIT),
    });
  },

  redo: () => {
    const { future, netlist, layout, past } = get();
    if (future.length === 0) return;
    lastMove = null;
    const next = future[0];
    set({
      netlist: next.netlist,
      layout: next.layout,
      future: future.slice(1),
      past: [...past, { netlist, layout }].slice(-UNDO_LIMIT),
    });
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
