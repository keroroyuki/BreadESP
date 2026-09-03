// PRD: §6.6 — Thin typed wrapper around window.breadesp (exposed by preload.ts).
// Renderer never touches Node directly.
import type { LayoutFile, Netlist } from '@breadesp/netlist';

/** DBus forward channel — mirrors SimDbusChannel in shell/src/preload.ts (PRD §6.7). */
interface SimDbusChannel {
  socket?: string;
  host?: string;
  port?: number;
}

/** ProjectData — mirrors ProjectManager in shell/src/project/ProjectManager.ts (PRD §F-PROJ-1). */
interface ProjectData {
  dir: string;
  meta: { version: 1; createdAt: number; updatedAt: number };
  netlist: Netlist;
  layout: LayoutFile;
  firmwareElf: string | null;
}

/** Payload of `sim:load` — mirrors shell/src/preload.ts (PRD §6.6). */
interface SimLoadInput {
  elfPath: string;
  chip: 'esp32' | 'esp32s3' | 'esp32c3';
  qemuBin: string;
  gdbPort?: number;
  dbus?: SimDbusChannel;
}

/** One row of the debug panel's breakpoint list — mirrors shell GdbBridge (PRD §F-DBG-1). */
export interface BreakpointRow {
  id: number;
  address: string | null;
  location: string | null;
  enabled: boolean;
}

/** One frame variable — mirrors shell GdbBridge (PRD §F-DBG-3 局部变量). */
export interface VarInfo {
  name: string;
  scope: 'arg' | 'local';
  value: string | null;
}

/** Stop frame — mirrors shell GdbBridge StoppedInfo (PRD §F-DBG-2). */
export interface StoppedInfo {
  reason: string | null;
  breakpointNumber?: string;
  frame: { addr: string; func?: string; file?: string; line?: string } | null;
  threadId: string | null;
  stoppedThreads: string[];
}

interface BridgeApi {
  sim: {
    load: (p: SimLoadInput) => Promise<void>;
    start: () => Promise<void>;
    pause: () => Promise<void>;
    step: () => Promise<void>;
    reset: () => Promise<void>;
    status: () => Promise<unknown>;
    /** Speed multiplier (PRD §F-SIM-2, dev-plan task P2.6). */
    setSpeed: (p: { factor: number }) => Promise<void>;
    getSpeed: () => Promise<number>;
    /** UART0 input injection (PRD §F-SER-2, dev-plan task P1.10). */
    sendUart: (p: { data: string }) => Promise<void>;
    onStatus: (cb: (s: unknown) => void) => () => void;
    onSpeed: (cb: (f: number) => void) => () => void;
    onUart: (cb: (s: string) => void) => () => void;
    onError: (cb: (msg: string) => void) => () => void;
  };
  fw: { load: (p: unknown) => Promise<void>; listSymbols: () => Promise<unknown[]>; };
  dbg: {
    connect: () => Promise<{ connected: boolean }>;
    disconnect: () => Promise<void>;
    status: () => Promise<{ connected: boolean }>;
    setBreakpoint: (p: { at: string }) => Promise<{ id: number; address: string; enabled: boolean }>;
    removeBreakpoint: (p: { id: number }) => Promise<void>;
    clearBreakpoints: () => Promise<void>;
    listBreakpoints: () => Promise<BreakpointRow[]>;
    continue: () => Promise<void>;
    step: () => Promise<void>;
    stepOver: () => Promise<void>;
    vars: () => Promise<VarInfo[]>;
    regs: () => Promise<Record<string, string>>;
    evaluate: (p: { expr: string }) => Promise<string>;
    onStopped: (cb: (info: StoppedInfo) => void) => () => void;
    onRunning: (cb: () => void) => () => void;
    onExit: (cb: (code: number) => void) => () => void;
  };
  proj: {
    new: (p: { dir: string }) => Promise<void>;
    open: (p: { dir: string }) => Promise<ProjectData>;
    save: (p: { netlist: Netlist; layout: LayoutFile }) => Promise<void>;
    saveAs: (p: { dir: string; netlist: Netlist; layout: LayoutFile }) => Promise<void>;
    close: () => Promise<void>;
  };
  bb: { applyNetlist: (p: unknown) => Promise<void>; getNetlist: () => Promise<unknown>; };
  per: {
    onSnapshot: (cb: (s: unknown) => void) => () => void;
    driveInput: (p: { instanceId: string; pin: string; level: 0 | 1 }) => Promise<void>;
  };
}

function load(): BridgeApi {
  const api = (window as unknown as { breadesp?: BridgeApi }).breadesp;
  if (!api) throw new Error('breadesp bridge not exposed (preload failed)');
  return api;
}

export const bridge: BridgeApi = load();
