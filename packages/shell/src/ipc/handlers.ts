// PRD: §6.6 — IPC handler registration. Bridges renderer calls to Bridge services.
import { ipcMain, type BrowserWindow } from 'electron';
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
  ipcMain.handle('sim:load', async (_e, p: { elfPath: string; chip: 'esp32' | 'esp32s3' | 'esp32c3'; qemuBin: string; gdbPort?: number; dbusSocket?: string }) =>
    qemu.load({ firmwareElf: p.elfPath, chip: p.chip, qemuBin: p.qemuBin, gdbPort: p.gdbPort, dbusSocket: p.dbusSocket }));
  ipcMain.handle('sim:start', async () => qemu.start());
  ipcMain.handle('sim:pause', async () => qemu.pause());
  ipcMain.handle('sim:step', async () => qemu.step());
  ipcMain.handle('sim:reset', async () => qemu.reset());
  ipcMain.handle('sim:status', async () => qemu.getStatus());

  // fw:*
  ipcMain.handle('fw:load', async (_e, p: { elfPath: string; chip: 'esp32' | 'esp32s3' | 'esp32c3' }) =>
    qemu.load({ firmwareElf: p.elfPath, chip: p.chip, qemuBin: process.env.BREADESP_QEMU_BIN! }));
  ipcMain.handle('fw:listSymbols', async () => { /* TODO(PRD §F-FW-4): via gdb info functions */ return []; });

  // dbg:*
  ipcMain.handle('dbg:setBreakpoint', async (_e, p: { at: string }) => gdb.setBreakpoint(p.at));
  ipcMain.handle('dbg:removeBreakpoint', async (_e, p: { id: number }) => gdb.removeBreakpoint(p.id));
  ipcMain.handle('dbg:continue', async () => gdb.continue());
  ipcMain.handle('dbg:step', async () => gdb.step());
  ipcMain.handle('dbg:vars', async () => gdb.vars());
  ipcMain.handle('dbg:regs', async () => gdb.regs());

  // proj:*
  ipcMain.handle('proj:new', async (_e, p: { dir: string }) => project.newProject(p.dir));
  ipcMain.handle('proj:open', async (_e, p: { dir: string }) => project.openProject(p.dir));
  ipcMain.handle('proj:save', async (_e, p: { netlist: unknown }) => project.saveNetlist(p.netlist as never));
  ipcMain.handle('proj:saveAs', async (_e, p: { dir: string; netlist: unknown }) => {
    await project.newProject(p.dir);
    await project.saveNetlist(p.netlist as never);
  });
  ipcMain.handle('proj:close', async () => project.close());

  // bb:*
  ipcMain.handle('bb:applyNetlist', async (_e, p: unknown) => peripherals.applyNetlist(p as never));
  ipcMain.handle('bb:getNetlist', async () => project.loadNetlist());

  // per:*
  ipcMain.handle('per:driveInput', async (_e, p: { instanceId: string; pin: string; level: 0 | 1 }) =>
    peripherals.driveInput(p.instanceId, p.pin, p.level));

  // Forward peripheral snapshots to the renderer (Bridge -> UI, PRD §6.6).
  peripherals.on('snapshot', (s: unknown) => deps.win?.webContents.send('per:snapshot', s));
  qemu.on('status', (s: string) => deps.win?.webContents.send('sim:status', s));
  qemu.on('uart', (s: string) => deps.win?.webContents.send('sim:uart', s));
}
