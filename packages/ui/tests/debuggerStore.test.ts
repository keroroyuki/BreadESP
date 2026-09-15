// PRD: §F-DBG-1..3 — debuggerStore state machine (dev-plan task P1.9).
// The bridge module is mocked: these tests pin the store's state transitions
// (attach/detach, stop/run phases, breakpoint list upkeep, watch values and
// error bookkeeping), not the IPC plumbing.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbgApi = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  status: vi.fn(),
  setBreakpoint: vi.fn(),
  setConditionalBreakpoint: vi.fn(),
  setWatchpoint: vi.fn(),
  conditionBreakpoint: vi.fn(),
  removeBreakpoint: vi.fn(),
  clearBreakpoints: vi.fn(),
  listBreakpoints: vi.fn(),
  continue: vi.fn(),
  step: vi.fn(),
  stepOver: vi.fn(),
  vars: vi.fn(),
  regs: vi.fn(),
  evaluate: vi.fn(),
  onStopped: vi.fn(),
  onRunning: vi.fn(),
  onExit: vi.fn(),
}));

vi.mock('../src/ipc/bridge', () => ({ bridge: { dbg: dbgApi } }));

const reset = () => {
  vi.clearAllMocks();
  // Restore default mock resolutions (clearAllMocks keeps implementations but
  // clears once-resolved values set with mockResolvedValueOnce).
  dbgApi.connect.mockResolvedValue({ connected: true });
  dbgApi.disconnect.mockResolvedValue(undefined);
  dbgApi.setBreakpoint.mockResolvedValue({ id: 1, address: '0x40080024', enabled: true });
  dbgApi.removeBreakpoint.mockResolvedValue(undefined);
  dbgApi.clearBreakpoints.mockResolvedValue(undefined);
  dbgApi.listBreakpoints.mockResolvedValue([
    { id: 1, kind: 'breakpoint', address: '0x40080024', location: 'app_main', enabled: true, cond: null },
  ]);
  dbgApi.continue.mockResolvedValue(undefined);
  dbgApi.step.mockResolvedValue(undefined);
  dbgApi.stepOver.mockResolvedValue(undefined);
  dbgApi.vars.mockResolvedValue([{ name: 'msg_cursor', scope: 'local', value: '165' }]);
  dbgApi.regs.mockResolvedValue({ pc: '0x40080024' });
  dbgApi.evaluate.mockResolvedValue('165');
};

import { useDebuggerStore } from '../src/store/debuggerStore';

describe('debuggerStore (P1.9)', () => {
  beforeEach(() => {
    reset();
    useDebuggerStore.setState({
      phase: 'detached', error: null, breakpoints: [], stop: null,
      vars: [], regs: {}, watches: [],
    });
  });

  it('connect() attaches, then refreshes breakpoints/vars/regs', async () => {
    await useDebuggerStore.getState().connect();
    const st = useDebuggerStore.getState();
    expect(st.phase).toBe('attached');
    expect(st.breakpoints).toEqual([{ id: 1, kind: 'breakpoint', address: '0x40080024', location: 'app_main', enabled: true, cond: null }]);
    expect(st.vars).toEqual([{ name: 'msg_cursor', scope: 'local', value: '165' }]);
    expect(st.regs).toEqual({ pc: '0x40080024' });
  });

  it('connect() surfaces a readable error and stays detached on failure', async () => {
    dbgApi.connect.mockRejectedValueOnce(new Error('[BB-115] no firmware loaded'));
    await useDebuggerStore.getState().connect();
    const st = useDebuggerStore.getState();
    expect(st.phase).toBe('detached');
    expect(st.error).toBe('[BB-115] no firmware loaded');
  });

  it('disconnect() detaches and clears the stop frame and inspected state', async () => {
    await useDebuggerStore.getState().connect();
    useDebuggerStore.getState().onStop({ reason: 'breakpoint-hit', frame: { addr: '0x40080024', func: 'app_main' }, threadId: '1', stoppedThreads: ['all'] });
    await useDebuggerStore.getState().disconnect();
    const st = useDebuggerStore.getState();
    expect(st.phase).toBe('detached');
    expect(st.stop).toBeNull();
    expect(st.vars).toEqual([]);
    expect(st.regs).toEqual({});
    expect(st.breakpoints).toEqual([]);
  });

  it('run() moves to running; onRunning() keeps it there; onStop() lands back attached', async () => {
    await useDebuggerStore.getState().connect();
    await useDebuggerStore.getState().run();
    expect(useDebuggerStore.getState().phase).toBe('running');
    useDebuggerStore.getState().onRunning();
    expect(useDebuggerStore.getState().phase).toBe('running');
    useDebuggerStore.getState().onStop({ reason: 'breakpoint-hit', frame: { addr: '0x40080024', func: 'app_main' }, threadId: '1', stoppedThreads: ['all'] });
    expect(useDebuggerStore.getState().phase).toBe('attached');
    expect(useDebuggerStore.getState().stop?.frame?.func).toBe('app_main');
  });

  it('addBreakpoint/removeBreakpoint re-read the breakpoint list after each edit', async () => {
    await useDebuggerStore.getState().connect();
    dbgApi.listBreakpoints.mockResolvedValueOnce([{ id: 7, kind: 'breakpoint', address: '0x1', location: 'app_main', enabled: true, cond: null }]);
    await useDebuggerStore.getState().addBreakpoint('app_main');
    expect(dbgApi.setBreakpoint).toHaveBeenCalledWith({ at: 'app_main' });
    expect(useDebuggerStore.getState().breakpoints).toEqual([{ id: 7, kind: 'breakpoint', address: '0x1', location: 'app_main', enabled: true, cond: null }]);

    dbgApi.listBreakpoints.mockResolvedValueOnce([]);
    await useDebuggerStore.getState().removeBreakpoint(7);
    expect(dbgApi.removeBreakpoint).toHaveBeenCalledWith({ id: 7 });
    expect(useDebuggerStore.getState().breakpoints).toEqual([]);
  });

  it('clearBreakpoints() empties the list', async () => {
    await useDebuggerStore.getState().connect();
    await useDebuggerStore.getState().clearBreakpoints();
    expect(dbgApi.clearBreakpoints).toHaveBeenCalledTimes(1);
    expect(useDebuggerStore.getState().breakpoints).toEqual([]);
  });

  // --- P4.4 (PRD §F-DBG-4): conditional breakpoints / watchpoints ---

  it('addConditionalBreakpoint() sends at+condition and re-reads the list (P4.4)', async () => {
    await useDebuggerStore.getState().connect();
    dbgApi.listBreakpoints.mockResolvedValueOnce([
      { id: 4, kind: 'breakpoint', address: '0x40080024', location: 'app_main', enabled: true, cond: 'remaining == 0' },
    ]);
    await useDebuggerStore.getState().addConditionalBreakpoint('app_main', 'remaining == 0');
    expect(dbgApi.setConditionalBreakpoint).toHaveBeenCalledWith({ at: 'app_main', condition: 'remaining == 0' });
    expect(useDebuggerStore.getState().breakpoints[0].cond).toBe('remaining == 0');
  });

  it('addWatchpoint() forwards the mode and surfaces watchpoint rows (P4.4)', async () => {
    await useDebuggerStore.getState().connect();
    dbgApi.listBreakpoints.mockResolvedValueOnce([
      { id: 5, kind: 'watchpoint', address: null, location: 'led_state', enabled: true, cond: null },
    ]);
    await useDebuggerStore.getState().addWatchpoint('led_state', 'read');
    expect(dbgApi.setWatchpoint).toHaveBeenCalledWith({ expr: 'led_state', mode: 'read' });
    expect(useDebuggerStore.getState().breakpoints[0].kind).toBe('watchpoint');
  });

  it('setBreakpointCondition() updates and can clear a condition (P4.4)', async () => {
    await useDebuggerStore.getState().connect();
    dbgApi.listBreakpoints.mockResolvedValueOnce([
      { id: 1, kind: 'breakpoint', address: '0x40080024', location: 'app_main', enabled: true, cond: null },
    ]);
    await useDebuggerStore.getState().setBreakpointCondition(1, '');
    expect(dbgApi.conditionBreakpoint).toHaveBeenCalledWith({ id: 1, condition: '' });
    expect(useDebuggerStore.getState().breakpoints[0].cond).toBeNull();
  });

  it('P4.4 actions surface bridge errors without corrupting state (P4.4)', async () => {
    await useDebuggerStore.getState().connect();
    dbgApi.setWatchpoint.mockRejectedValueOnce(new Error('[BB-113] GDB error: Could not find minimal symbol for led_state'));
    await useDebuggerStore.getState().addWatchpoint('led_state', 'write');
    expect(useDebuggerStore.getState().error).toMatch(/\[BB-113\]/);
    expect(useDebuggerStore.getState().breakpoints).toEqual([{ id: 1, kind: 'breakpoint', address: '0x40080024', location: 'app_main', enabled: true, cond: null }]);
  });

  it('addWatch() evaluates immediately; duplicate and empty exprs are ignored', async () => {
    await useDebuggerStore.getState().connect();
    await useDebuggerStore.getState().addWatch('led_state');
    await useDebuggerStore.getState().addWatch('led_state'); // duplicate
    await useDebuggerStore.getState().addWatch('   ');         // blank
    expect(dbgApi.evaluate).toHaveBeenCalledTimes(1);
    expect(useDebuggerStore.getState().watches).toEqual([{ expr: 'led_state', value: '165' }]);
  });

  it('removeWatch() drops one entry; refresh() re-evaluates the rest', async () => {
    await useDebuggerStore.getState().connect();
    await useDebuggerStore.getState().addWatch('led_state');
    dbgApi.evaluate.mockResolvedValueOnce('0');
    await useDebuggerStore.getState().addWatch('remaining');
    useDebuggerStore.getState().removeWatch('led_state');
    expect(useDebuggerStore.getState().watches.map((w) => w.expr)).toEqual(['remaining']);

    dbgApi.evaluate.mockResolvedValueOnce('42');
    await useDebuggerStore.getState().refresh();
    expect(useDebuggerStore.getState().watches).toEqual([{ expr: 'remaining', value: '42' }]);
  });

  it('onStop() records the frame and refreshes the inspected state', async () => {
    useDebuggerStore.getState().onStop({ reason: 'end-stepping-range', frame: { addr: '0x40080027' }, threadId: '1', stoppedThreads: ['all'] });
    // refresh() is fire-and-forget inside onStop: flush microtasks.
    await new Promise((r) => setTimeout(r, 0));
    const st = useDebuggerStore.getState();
    expect(st.phase).toBe('attached');
    expect(st.stop?.reason).toBe('end-stepping-range');
    expect(dbgApi.vars).toHaveBeenCalledTimes(1);
    expect(dbgApi.regs).toHaveBeenCalledTimes(1);
  });

  it('onExit() resets everything and records the exit', () => {
    useDebuggerStore.getState().onStop({ reason: 'breakpoint-hit', frame: { addr: '0x1' }, threadId: '1', stoppedThreads: ['all'] });
    useDebuggerStore.getState().onExit(0);
    const st = useDebuggerStore.getState();
    expect(st.phase).toBe('detached');
    expect(st.stop).toBeNull();
    expect(st.error).toBe('debugger exited (0)');
  });

  it('errors clear again on the next successful action', async () => {
    dbgApi.step.mockRejectedValueOnce(new Error('[BB-114] GDB is not running'));
    await useDebuggerStore.getState().step();
    expect(useDebuggerStore.getState().error).toBe('[BB-114] GDB is not running');
    dbgApi.step.mockResolvedValueOnce(undefined);
    await useDebuggerStore.getState().step();
    expect(useDebuggerStore.getState().error).toBeNull();
  });
});
