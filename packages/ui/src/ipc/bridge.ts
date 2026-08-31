// PRD: §6.6 — Thin typed wrapper around window.breadesp (exposed by preload.ts).
// Renderer never touches Node directly.

/** Payload of `sim:load` — mirrors shell/src/preload.ts (PRD §6.6). */
interface SimLoadInput {
  elfPath: string;
  chip: 'esp32' | 'esp32s3' | 'esp32c3';
  qemuBin: string;
  gdbPort?: number;
  dbusSocket?: string;
}

interface BridgeApi {
  sim: {
    load: (p: SimLoadInput) => Promise<void>;
    start: () => Promise<void>;
    pause: () => Promise<void>;
    step: () => Promise<void>;
    reset: () => Promise<void>;
    status: () => Promise<unknown>;
    onStatus: (cb: (s: unknown) => void) => () => void;
    onUart: (cb: (s: string) => void) => () => void;
    onError: (cb: (msg: string) => void) => () => void;
  };
  fw: { load: (p: unknown) => Promise<void>; listSymbols: () => Promise<unknown[]>; };
  dbg: {
    setBreakpoint: (p: { at: string }) => Promise<unknown>;
    removeBreakpoint: (p: { id: number }) => Promise<void>;
    continue: () => Promise<void>;
    step: () => Promise<void>;
    vars: () => Promise<Record<string, unknown>>;
    regs: () => Promise<Record<string, unknown>>;
  };
  proj: {
    new: (p: { dir: string }) => Promise<void>;
    open: (p: { dir: string }) => Promise<unknown>;
    save: (p: { netlist: unknown }) => Promise<void>;
    saveAs: (p: { dir: string; netlist: unknown }) => Promise<void>;
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
