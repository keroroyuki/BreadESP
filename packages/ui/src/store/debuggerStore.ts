// PRD: §F-DBG — Debugger panel state (dev-plan task P1.9).
// Owns the debugger's view state: connection phase, breakpoint list, the last
// stop frame, and the inspected vars/regs/watches. IPC side effects go through
// the bridge; async pushes (dbg:stopped/running/exit) are funneled into
// onStop/onRunning/onExit by App, which own the subscriptions.
import { create } from 'zustand';
import { bridge } from '../ipc/bridge';
import type { BreakpointRow, StoppedInfo, VarInfo, WatchMode } from '../ipc/bridge';

/** 'detached' — no GDB attached; 'attached' — connected and stopped; 'running' — target resumed. */
export type DbgPhase = 'detached' | 'attached' | 'running';

export interface WatchEntry {
  expr: string;
  value: string | null;
}

interface DebuggerState {
  phase: DbgPhase;
  /** Last failed dbg action, surfaced in the panel (cleared on the next success). */
  error: string | null;
  breakpoints: BreakpointRow[];
  /** Payload of the most recent *stopped; null before the first stop. */
  stop: StoppedInfo | null;
  vars: VarInfo[];
  regs: Record<string, string>;
  watches: WatchEntry[];

  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  addBreakpoint: (at: string) => Promise<void>;
  /** P4.4 (F-DBG-4): breakpoint gated on a condition expression. */
  addConditionalBreakpoint: (at: string, condition: string) => Promise<void>;
  /** P4.4 (F-DBG-4): hardware watchpoint; stops when `expr` is read/written per mode. */
  addWatchpoint: (expr: string, mode: WatchMode) => Promise<void>;
  /** P4.4 (F-DBG-4): set/clear (empty string) the condition of an existing breakpoint. */
  setBreakpointCondition: (id: number, condition: string) => Promise<void>;
  removeBreakpoint: (id: number) => Promise<void>;
  clearBreakpoints: () => Promise<void>;
  run: () => Promise<void>;
  step: () => Promise<void>;
  stepOver: () => Promise<void>;
  addWatch: (expr: string) => Promise<void>;
  removeWatch: (expr: string) => void;
  /** Re-read breakpoints + frame vars + regs + watch values (after a stop). */
  refresh: () => Promise<void>;
  /** dbg:stopped push — records the frame, then refreshes the inspected state. */
  onStop: (info: StoppedInfo) => void;
  /** dbg:running push. */
  onRunning: () => void;
  /** dbg:exit push — GDB is gone; every view resets. */
  onExit: (code: number) => void;
}

/** Run an action with error bookkeeping: failures land in `error`, successes clear it. */
async function guarded(set: (p: Partial<DebuggerState>) => void, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    set({ error: null });
  } catch (err) {
    set({ error: err instanceof Error ? err.message : String(err) });
  }
}

export const useDebuggerStore = create<DebuggerState>((set, get) => ({
  phase: 'detached',
  error: null,
  breakpoints: [],
  stop: null,
  vars: [],
  regs: {},
  watches: [],

  connect: () => guarded(set, async () => {
    await bridge.dbg.connect();
    set({ phase: 'attached' });
    await get().refresh();
  }),

  disconnect: () => guarded(set, async () => {
    await bridge.dbg.disconnect();
    set({ phase: 'detached', stop: null, vars: [], regs: {}, breakpoints: [] });
  }),

  addBreakpoint: (at) => guarded(set, async () => {
    await bridge.dbg.setBreakpoint({ at });
    set({ breakpoints: await bridge.dbg.listBreakpoints() });
  }),

  addConditionalBreakpoint: (at, condition) => guarded(set, async () => {
    await bridge.dbg.setConditionalBreakpoint({ at, condition });
    set({ breakpoints: await bridge.dbg.listBreakpoints() });
  }),

  addWatchpoint: (expr, mode) => guarded(set, async () => {
    await bridge.dbg.setWatchpoint({ expr, mode });
    set({ breakpoints: await bridge.dbg.listBreakpoints() });
  }),

  setBreakpointCondition: (id, condition) => guarded(set, async () => {
    await bridge.dbg.conditionBreakpoint({ id, condition });
    set({ breakpoints: await bridge.dbg.listBreakpoints() });
  }),

  removeBreakpoint: (id) => guarded(set, async () => {
    await bridge.dbg.removeBreakpoint({ id });
    set({ breakpoints: await bridge.dbg.listBreakpoints() });
  }),

  clearBreakpoints: () => guarded(set, async () => {
    await bridge.dbg.clearBreakpoints();
    set({ breakpoints: [] });
  }),

  run: () => guarded(set, async () => {
    await bridge.dbg.continue();
    set({ phase: 'running' });
  }),

  step: () => guarded(set, async () => {
    await bridge.dbg.step();
    set({ phase: 'attached' }); // the stop itself lands via dbg:stopped
  }),

  stepOver: () => guarded(set, async () => {
    await bridge.dbg.stepOver();
    set({ phase: 'attached' });
  }),

  addWatch: (expr) => guarded(set, async () => {
    const trimmed = expr.trim();
    if (trimmed === '' || get().watches.some((w) => w.expr === trimmed)) return;
    const value = await bridge.dbg.evaluate({ expr: trimmed });
    if (get().phase === 'detached') return; // in-flight reply after detach: drop
    set({ watches: [...get().watches, { expr: trimmed, value }] });
  }),

  removeWatch: (expr) => set({ watches: get().watches.filter((w) => w.expr !== expr) }),

  refresh: () => guarded(set, async () => {
    const [breakpoints, vars, regs] = await Promise.all([
      bridge.dbg.listBreakpoints(),
      bridge.dbg.vars(),
      bridge.dbg.regs(),
    ]);
    const watches: WatchEntry[] = [];
    for (const w of get().watches) {
      watches.push({ expr: w.expr, value: await bridge.dbg.evaluate({ expr: w.expr }) });
    }
    if (get().phase === 'detached') return; // in-flight reply after detach: drop
    set({ breakpoints, vars, regs, watches });
  }),

  onStop: (info) => {
    set({ phase: 'attached', stop: info });
    // Fire-and-forget: the panel updates when the reads land (PRD §F-DBG-3).
    void get().refresh();
  },

  onRunning: () => set({ phase: 'running' }),

  onExit: (code) => {
    // GDB gone: keep breakpoints on screen (they live in GDB, now lost) but
    // mark everything stale — panel resets to detached.
    set({ phase: 'detached', stop: null, vars: [], regs: {}, breakpoints: [], error: `debugger exited (${code})` });
  },
}));
