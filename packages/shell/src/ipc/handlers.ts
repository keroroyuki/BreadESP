// PRD: §6.6 — IPC handler registration. Bridges renderer calls to Bridge services.
import { ipcMain, type BrowserWindow } from 'electron';
import { chipKindSchema } from '@breadesp/netlist';
import type { ChipKind, LayoutFile, Netlist } from '@breadesp/netlist';
import type { ProjectManager } from '../project/ProjectManager.js';
import type { QemuRunner } from '../qemu/QemuRunner.js';
import type { GdbBridge } from '../debugger/GdbBridge.js';
import type { PeripheralManager } from '../peripherals/PeripheralManager.js';

export interface HandlerDeps {
  project: ProjectManager;
  qemu: QemuRunner;
  gdb: GdbBridge;
  peripherals: PeripheralManager;
  win?: BrowserWindow;
}

export async function registerIpcHandlers(deps: HandlerDeps): Promise<void> {
  const { project, qemu, gdb, peripherals } = deps;

  // sim:*
  ipcMain.handle('sim:load', async (_e, p: { elfPath: string; chip: ChipKind; qemuBin: string; gdbPort?: number; dbus?: { socket?: string; host?: string; port?: number } }) => {
    // Architecture gate before spawn (dev-plan task P0.6, PRD §9).
    await project.validateFirmware(p.elfPath, p.chip);
    return qemu.load({ firmwareElf: p.elfPath, chip: p.chip, qemuBin: p.qemuBin, gdbPort: p.gdbPort, dbus: p.dbus });
  });
  ipcMain.handle('sim:start', async () => qemu.start());
  ipcMain.handle('sim:pause', async () => qemu.pause());
  // Instruction-level stepping is a GDB stub capability (PRD §F-SIM-1 +
  // §F-DBG-2): route through the bridge, which the debug panel attaches
  // lazily via dbg:connect (dev-plan task P1.9).
  ipcMain.handle('sim:step', async () => {
    if (!gdb.isConnected()) {
      throw new Error('[BB-105] single-step requires the debugger attached; call dbg:connect first');
    }
    return gdb.step();
  });
  ipcMain.handle('sim:reset', async () => qemu.reset());
  ipcMain.handle('sim:status', async () => qemu.getStatus());
  // Simulation speed multiplier (PRD §F-SIM-2, dev-plan task P2.6): the runner
  // validates the [0.1, 10] range and throttles the logical clock by QMP
  // duty-cycling; out-of-range factors reject with [BB-116].
  ipcMain.handle('sim:setSpeed', async (_e, p: { factor: number }) => qemu.setSpeed(p.factor));
  ipcMain.handle('sim:getSpeed', async () => qemu.getSpeed());
  // UART0 input injection (PRD §F-SER-2, dev-plan task P1.10): bytes written to
  // the QEMU stdin pipe land in the guest UART RX FIFO. Unloaded VMs reject
  // with [BB-102] straight from QemuRunner.writeStdin.
  ipcMain.handle('sim:sendUart', async (_e, p: { data: string }) => qemu.writeStdin(p.data));

  // fw:*
  ipcMain.handle('fw:load', async (_e, p: { elfPath: string; chip: ChipKind }) => {
    // Architecture gate before spawn (dev-plan task P0.6, PRD §9).
    await project.validateFirmware(p.elfPath, p.chip);
    return qemu.load({ firmwareElf: p.elfPath, chip: p.chip, qemuBin: process.env.BREADESP_QEMU_BIN! });
  });
  ipcMain.handle('fw:listSymbols', async () => { /* TODO(PRD §F-FW-4): via gdb info functions */ return []; });

  // dbg:* (dev-plan task P1.9 — debug panel surface, PRD §F-DBG-1..5)
  // Connection is lazy: QemuRunner.load() always arms the GDB stub, the panel
  // attaches at any time via dbg:connect with the port/ELF it remembers.
  ipcMain.handle('dbg:connect', async () => {
    if (gdb.isConnected()) return { connected: true }; // idempotent attach
    const gdbPort = qemu.getGdbPort();
    const firmwareElf = qemu.getFirmwareElf();
    if (gdbPort === null || firmwareElf === null) {
      throw new Error('[BB-115] no firmware loaded; call sim:load before attaching the debugger');
    }
    const gdbBin = process.env.BREADESP_GDB_BIN;
    if (gdbBin === undefined) {
      throw new Error('[BB-110] BREADESP_GDB_BIN is not set; cannot spawn xtensa-esp32-elf-gdb');
    }
    await gdb.start({ gdbBin, elfPath: firmwareElf, targetHost: '127.0.0.1', port: gdbPort });
    return { connected: true };
  });
  ipcMain.handle('dbg:disconnect', async () => gdb.stop());
  ipcMain.handle('dbg:status', async () => ({ connected: gdb.isConnected() }));
  ipcMain.handle('dbg:setBreakpoint', async (_e, p: { at: string }) => gdb.setBreakpoint(p.at));
  ipcMain.handle('dbg:removeBreakpoint', async (_e, p: { id: number }) => gdb.removeBreakpoint(p.id));
  ipcMain.handle('dbg:clearBreakpoints', async () => gdb.clearBreakpoints());
  ipcMain.handle('dbg:listBreakpoints', async () => gdb.listBreakpoints());
  ipcMain.handle('dbg:continue', async () => gdb.continue());
  ipcMain.handle('dbg:step', async () => gdb.step());
  ipcMain.handle('dbg:stepOver', async () => gdb.stepOver());
  ipcMain.handle('dbg:vars', async () => gdb.vars());
  ipcMain.handle('dbg:regs', async () => gdb.regs());
  ipcMain.handle('dbg:evaluate', async (_e, p: { expr: string }) => gdb.evaluate(p.expr));

  // proj:*
  // P4.2 (PRD §F-PROJ-2): new takes the wizard's chip/template picks; the
  // payload is renderer-controlled, so validate at this boundary. Unknown
  // templates/chips are rejected deeper by ProjectManager with [BB-125].
  ipcMain.handle('proj:new', async (_e, p: { dir: string; chip?: ChipKind; template?: string }) => {
    if (
      typeof p?.dir !== 'string' || p.dir.length === 0 ||
      (p.chip !== undefined && !chipKindSchema.safeParse(p.chip).success) ||
      (p.template !== undefined && (typeof p.template !== 'string' || p.template.length === 0))
    ) {
      throw new Error('[BB-126] invalid proj:new payload (dir/chip/template)');
    }
    return project.newProject(p.dir, { chip: p.chip, template: p.template });
  });
  ipcMain.handle('proj:open', async (_e, p: { dir: string }) => project.openProject(p.dir));
  // IPC boundary: payloads arrive as plain JSON data; saveProject re-validates
  // both halves before anything is written (PRD §6.6).
  ipcMain.handle('proj:save', async (_e, p: { netlist: Netlist; layout: LayoutFile }) =>
    project.saveProject(p.netlist, p.layout));
  ipcMain.handle('proj:saveAs', async (_e, p: { dir: string; netlist: Netlist; layout: LayoutFile }) => {
    await project.newProject(p.dir);
    await project.saveProject(p.netlist, p.layout);
  });
  ipcMain.handle('proj:close', async () => project.close());
  // P4.3 (PRD §F-PROJ-3): external PlatformIO/ESP-IDF project association.
  // Payloads are renderer-controlled, so validate at this boundary; deeper
  // failures are coded [BB-127..129] by ProjectManager.
  ipcMain.handle('proj:linkExternal', async (_e, p: { dir: string }) => {
    if (typeof p?.dir !== 'string' || p.dir.length === 0) {
      throw new Error('[BB-130] invalid proj:linkExternal payload (dir)');
    }
    return project.linkExternalProject(p.dir);
  });
  ipcMain.handle('proj:unlinkExternal', async () => project.unlinkExternalProject());
  ipcMain.handle('proj:scanExternal', async () => project.scanExternalFirmware());
  ipcMain.handle('proj:importExternal', async (_e, p?: { elfPath?: string }) => {
    if (
      p !== undefined && p !== null &&
      (typeof p !== 'object' || Array.isArray(p) ||
        (p.elfPath !== undefined && (typeof p.elfPath !== 'string' || p.elfPath.length === 0)))
    ) {
      throw new Error('[BB-130] invalid proj:importExternal payload (elfPath)');
    }
    return project.importExternalFirmware(p?.elfPath);
  });
  // TODO(PRD §F-PROJ-1): expose project.importFirmware once the firmware-picking UI lands.

  // bb:*
  ipcMain.handle('bb:applyNetlist', async (_e, p: unknown) => peripherals.applyNetlist(p as never));
  ipcMain.handle('bb:getNetlist', async () => project.loadNetlist());

  // per:*
  // P3.4: the payload is renderer-controlled, so validate at this boundary.
  ipcMain.handle('per:driveInput', async (_e, p: { instanceId: string; pin: string; level: 0 | 1 }) => {
    if (
      typeof p?.instanceId !== 'string' || p.instanceId.length === 0 ||
      typeof p?.pin !== 'string' || p.pin.length === 0 ||
      (p?.level !== 0 && p?.level !== 1)
    ) {
      throw new Error('[BB-203] invalid per:driveInput payload (instanceId/pin/level)');
    }
    peripherals.driveInput(p.instanceId, p.pin, p.level);
  });
  // Rotary knob gesture (P3.4, PRD §F-BB-3): delta is signed detent steps
  // (positive = clockwise); the model plays the quadrature sequence over time.
  ipcMain.handle('per:rotateKnob', async (_e, p: { instanceId: string; delta: number }) => {
    if (
      typeof p?.instanceId !== 'string' || p.instanceId.length === 0 ||
      !Number.isFinite(p?.delta) || Math.abs(p.delta) > 256
    ) {
      throw new Error('[BB-204] invalid per:rotateKnob payload (instanceId/delta)');
    }
    peripherals.driveRotate(p.instanceId, Math.trunc(p.delta));
  });
  // Local mic capture (P3.2, PRD §F-PER-7/§6.6): the renderer pushes host-mic
  // PCM chunks; the model resamples and injects them over the DBus reverse
  // channel. The payload is renderer-controlled, so validate at this boundary.
  ipcMain.handle('per:captureChunk', async (_e, p: { instanceId: string; rate: number; samples: number[] }) => {
    if (
      typeof p?.instanceId !== 'string' || p.instanceId.length === 0 ||
      !Number.isFinite(p?.rate) || p.rate < 1000 || p.rate > 192000 ||
      !Array.isArray(p?.samples) || p.samples.length === 0 || p.samples.length > 192000 ||
      p.samples.some((s) => typeof s !== 'number' || !Number.isFinite(s))
    ) {
      throw new Error('[BB-202] invalid per:captureChunk payload (instanceId/rate/samples)');
    }
    peripherals.feedCapture(p.instanceId, { rate: p.rate, samples: p.samples });
  });

  // Forward peripheral snapshots to the renderer (Bridge -> UI, PRD §6.6).
  peripherals.on('snapshot', (s: unknown) => deps.win?.webContents.send('per:snapshot', s));
  qemu.on('status', (s: string) => deps.win?.webContents.send('sim:status', s));
  qemu.on('speed', (f: number) => deps.win?.webContents.send('sim:speed', f));
  qemu.on('uart', (s: string) => deps.win?.webContents.send('sim:uart', s));
  // QemuRunner only emits 'error' when listened for; subscribing here also
  // keeps the message out of the 'log' fallback (dev-plan task P1.1).
  qemu.on('error', (err: Error) => deps.win?.webContents.send('sim:error', err.message));
  // Debugger stop/run/exit pushes (dev-plan task P1.9): async stops (breakpoint
  // hits, step ends) update the panel without a renderer poll.
  gdb.on('stopped', (info: unknown) => deps.win?.webContents.send('dbg:stopped', info));
  gdb.on('running', () => deps.win?.webContents.send('dbg:running'));
  gdb.on('exit', (code: number) => deps.win?.webContents.send('dbg:exit', code));
}
