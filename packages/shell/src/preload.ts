// PRD: §6.6 — Secure preload bridge. Exposes a typed API to the renderer.
// All IPC parameters/returns are JSON-serializable (PRD §6.6).
import { contextBridge, ipcRenderer } from 'electron';
import type { LayoutFile, Netlist } from '@breadesp/netlist';
import type { ProjectData } from './project/ProjectManager.js';

/** DBus forward channel — mirrors QemuDbusChannel in sim-core (PRD §6.7). */
export interface SimDbusChannel {
  socket?: string;
  host?: string;
  port?: number;
}

/** Payload of `sim:load` — mirrors the handler in ipc/handlers.ts (PRD §6.6). */
export interface SimLoadInput {
  elfPath: string;
  chip: 'esp32' | 'esp32s3' | 'esp32c3';
  qemuBin: string;
  gdbPort?: number;
  dbus?: SimDbusChannel;
}

const api = {
  // sim:*
  sim: {
    load: (p: SimLoadInput) => ipcRenderer.invoke('sim:load', p),
    start: () => ipcRenderer.invoke('sim:start'),
    pause: () => ipcRenderer.invoke('sim:pause'),
    step: () => ipcRenderer.invoke('sim:step'),
    reset: () => ipcRenderer.invoke('sim:reset'),
    status: () => ipcRenderer.invoke('sim:status'),
    onStatus: (cb: (s: unknown) => void) => {
      const h = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on('sim:status', h);
      return () => ipcRenderer.removeListener('sim:status', h);
    },
    onUart: (cb: (s: string) => void) => {
      const h = (_e: unknown, s: string) => cb(s);
      ipcRenderer.on('sim:uart', h);
      return () => ipcRenderer.removeListener('sim:uart', h);
    },
    onError: (cb: (msg: string) => void) => {
      const h = (_e: unknown, msg: string) => cb(msg);
      ipcRenderer.on('sim:error', h);
      return () => ipcRenderer.removeListener('sim:error', h);
    },
  },
  // fw:*
  fw: {
    load: (p: unknown) => ipcRenderer.invoke('fw:load', p),
    listSymbols: () => ipcRenderer.invoke('fw:listSymbols'),
  },
  // dbg:*
  dbg: {
    connect: () => ipcRenderer.invoke('dbg:connect'),
    disconnect: () => ipcRenderer.invoke('dbg:disconnect'),
    status: () => ipcRenderer.invoke('dbg:status'),
    setBreakpoint: (p: unknown) => ipcRenderer.invoke('dbg:setBreakpoint', p),
    removeBreakpoint: (p: unknown) => ipcRenderer.invoke('dbg:removeBreakpoint', p),
    clearBreakpoints: () => ipcRenderer.invoke('dbg:clearBreakpoints'),
    listBreakpoints: () => ipcRenderer.invoke('dbg:listBreakpoints'),
    continue: () => ipcRenderer.invoke('dbg:continue'),
    step: () => ipcRenderer.invoke('dbg:step'),
    stepOver: () => ipcRenderer.invoke('dbg:stepOver'),
    vars: () => ipcRenderer.invoke('dbg:vars'),
    regs: () => ipcRenderer.invoke('dbg:regs'),
    evaluate: (p: { expr: string }) => ipcRenderer.invoke('dbg:evaluate', p),
    onStopped: (cb: (info: unknown) => void) => {
      const h = (_e: unknown, info: unknown) => cb(info);
      ipcRenderer.on('dbg:stopped', h);
      return () => ipcRenderer.removeListener('dbg:stopped', h);
    },
    onRunning: (cb: () => void) => {
      const h = () => cb();
      ipcRenderer.on('dbg:running', h);
      return () => ipcRenderer.removeListener('dbg:running', h);
    },
    onExit: (cb: (code: number) => void) => {
      const h = (_e: unknown, code: number) => cb(code);
      ipcRenderer.on('dbg:exit', h);
      return () => ipcRenderer.removeListener('dbg:exit', h);
    },
  },
  // proj:*
  proj: {
    new: (p: { dir: string }) => ipcRenderer.invoke('proj:new', p),
    // IPC boundary: invoke is untyped over the wire; the main side validates
    // the whole project before returning it (openProject), so this is safe.
    open: (p: { dir: string }) => ipcRenderer.invoke('proj:open', p) as Promise<ProjectData>,
    save: (p: { netlist: Netlist; layout: LayoutFile }) => ipcRenderer.invoke('proj:save', p),
    saveAs: (p: { dir: string; netlist: Netlist; layout: LayoutFile }) => ipcRenderer.invoke('proj:saveAs', p),
    close: () => ipcRenderer.invoke('proj:close'),
  },
  // bb:*
  bb: {
    applyNetlist: (p: unknown) => ipcRenderer.invoke('bb:applyNetlist', p),
    getNetlist: () => ipcRenderer.invoke('bb:getNetlist'),
  },
  // per:* (Bridge -> UI one-way snapshot stream)
  per: {
    onSnapshot: (cb: (s: unknown) => void) => {
      const h = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on('per:snapshot', h);
      return () => ipcRenderer.removeListener('per:snapshot', h);
    },
    driveInput: (p: unknown) => ipcRenderer.invoke('per:driveInput', p),
  },
};

contextBridge.exposeInMainWorld('breadesp', api);

export type BreadespApi = typeof api;
