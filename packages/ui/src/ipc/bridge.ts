// PRD: §6.6 — Thin typed wrapper around window.breadesp (exposed by preload.ts).
// Renderer never touches Node directly.
import type { ChipKind, LayoutFile, Netlist } from '@breadesp/netlist';

/** DBus forward channel — mirrors SimDbusChannel in shell/src/preload.ts (PRD §6.7). */
interface SimDbusChannel {
  socket?: string;
  host?: string;
  port?: number;
}

/** ExternalProjectKind — mirrors shell/src/project/ExternalProject.ts (PRD §F-PROJ-3). */
export type ExternalProjectKind = 'platformio' | 'esp-idf';

/** ExternalProjectLink — mirrors shell/src/project/ExternalProject.ts (PRD §F-PROJ-3). */
export interface ExternalProjectLink {
  kind: ExternalProjectKind;
  dir: string;
}

/** ExternalElfCandidate — mirrors shell/src/project/ExternalProject.ts (PRD §F-PROJ-3). */
export interface ExternalElfCandidate {
  path: string;
  env: string | null;
  mtimeMs: number;
  sizeBytes: number;
  /** Filled by the Bridge: ELF header matches the project chip family. */
  archOk?: boolean;
}

/** ExternalScanResult — mirrors shell/src/project/ExternalProject.ts (PRD §F-PROJ-3). */
export interface ExternalScanResult {
  link: ExternalProjectLink;
  /** Newest build first. */
  candidates: ExternalElfCandidate[];
}

/** ProjectData — mirrors ProjectManager in shell/src/project/ProjectManager.ts (PRD §F-PROJ-1). */
interface ProjectData {
  dir: string;
  meta: { version: 1; createdAt: number; updatedAt: number; external?: ExternalProjectLink };
  netlist: Netlist;
  layout: LayoutFile;
  firmwareElf: string | null;
  external: ExternalProjectLink | null;
}

/** Payload of `sim:load` — mirrors shell/src/preload.ts (PRD §6.6). */
interface SimLoadInput {
  elfPath: string;
  chip: ChipKind;
  qemuBin: string;
  gdbPort?: number;
  dbus?: SimDbusChannel;
}

/** One row of the debug panel's breakpoint list — mirrors shell GdbBridge (PRD §F-DBG-1, P4.4). */
export interface BreakpointRow {
  id: number;
  /** 'breakpoint' — code location; 'watchpoint' — hardware data watch (F-DBG-4). */
  kind: 'breakpoint' | 'watchpoint';
  address: string | null;
  location: string | null;
  enabled: boolean;
  /** Condition expression; null when none (F-DBG-4). */
  cond: string | null;
}

/** Watchpoint trigger mode (F-DBG-4) — mirrors shell GdbBridge. */
export type WatchMode = 'write' | 'read' | 'access';

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
    /** P4.4 (F-DBG-4): breakpoint gated on a condition expression. */
    setConditionalBreakpoint: (p: { at: string; condition: string }) => Promise<{ id: number; address: string; enabled: boolean }>;
    /** P4.4 (F-DBG-4): hardware watchpoint on an expression. */
    setWatchpoint: (p: { expr: string; mode?: WatchMode }) => Promise<{ id: number; address: string; enabled: boolean }>;
    /** P4.4 (F-DBG-4): set/clear (empty string) the condition of an existing breakpoint. */
    conditionBreakpoint: (p: { id: number; condition: string }) => Promise<void>;
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
    /** P4.2 (PRD §F-PROJ-2): optional chip/template picks; resolves to the created ProjectData. */
    new: (p: { dir: string; chip?: ChipKind; template?: string }) => Promise<ProjectData>;
    open: (p: { dir: string }) => Promise<ProjectData>;
    save: (p: { netlist: Netlist; layout: LayoutFile }) => Promise<void>;
    saveAs: (p: { dir: string; netlist: Netlist; layout: LayoutFile }) => Promise<void>;
    close: () => Promise<void>;
    /** P4.3 (PRD §F-PROJ-3): link a PlatformIO/ESP-IDF project; returns the discovered ELFs. */
    linkExternal: (p: { dir: string }) => Promise<ExternalScanResult>;
    unlinkExternal: () => Promise<void>;
    scanExternal: () => Promise<ExternalScanResult>;
    /** Import a discovered build as firmware.elf; no elfPath picks the newest. Returns the dest path. */
    importExternal: (p?: { elfPath?: string }) => Promise<string>;
  };
  bb: { applyNetlist: (p: unknown) => Promise<void>; getNetlist: () => Promise<unknown>; };
  per: {
    onSnapshot: (cb: (s: unknown) => void) => () => void;
    driveInput: (p: { instanceId: string; pin: string; level: 0 | 1 }) => Promise<void>;
    /** Rotary knob gesture (P3.4, PRD §F-BB-3): signed detent steps (positive = clockwise). */
    rotateKnob: (p: { instanceId: string; delta: number }) => Promise<void>;
    /** Local mic capture (P3.2, PRD §F-PER-7): host-mic PCM chunk for one instance. */
    captureChunk: (p: { instanceId: string; rate: number; samples: number[] }) => Promise<void>;
  };
}

function load(): BridgeApi {
  const api = (window as unknown as { breadesp?: BridgeApi }).breadesp;
  if (!api) throw new Error('breadesp bridge not exposed (preload failed)');
  return api;
}

export const bridge: BridgeApi = load();
