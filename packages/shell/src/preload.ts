// PRD: §6.6 — Secure preload bridge. Exposes a typed API to the renderer.
// All IPC parameters/returns are JSON-serializable (PRD §6.6).
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  // sim:*
  sim: {
    start: (p: unknown) => ipcRenderer.invoke('sim:start', p),
    pause: () => ipcRenderer.invoke('sim:pause'),
    step: () => ipcRenderer.invoke('sim:step'),
    reset: () => ipcRenderer.invoke('sim:reset'),
    status: () => ipcRenderer.invoke('sim:status'),
    onStatus: (cb: (s: unknown) => void) => {
      const h = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on('sim:status', h);
      return () => ipcRenderer.removeListener('sim:status', h);
    },
  },
  // fw:*
  fw: {
    load: (p: unknown) => ipcRenderer.invoke('fw:load', p),
    listSymbols: () => ipcRenderer.invoke('fw:listSymbols'),
  },
  // dbg:*
  dbg: {
    setBreakpoint: (p: unknown) => ipcRenderer.invoke('dbg:setBreakpoint', p),
    removeBreakpoint: (p: unknown) => ipcRenderer.invoke('dbg:removeBreakpoint', p),
    continue: () => ipcRenderer.invoke('dbg:continue'),
    step: () => ipcRenderer.invoke('dbg:step'),
    vars: () => ipcRenderer.invoke('dbg:vars'),
    regs: () => ipcRenderer.invoke('dbg:regs'),
  },
  // proj:*
  proj: {
    new: (p: unknown) => ipcRenderer.invoke('proj:new', p),
    open: (p: unknown) => ipcRenderer.invoke('proj:open', p),
    save: (p: unknown) => ipcRenderer.invoke('proj:save', p),
    saveAs: (p: unknown) => ipcRenderer.invoke('proj:saveAs', p),
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
