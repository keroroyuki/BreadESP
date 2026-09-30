// PRD: §4, §10 — Electron main entry. Hosts the Bridge and wires IPC handlers.
// AI Agent: keep IPC channel naming prefixes per PRD §6.6 (sim:/fw:/dbg:/proj:/bb:/per:).
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { registerIpcHandlers } from './ipc/handlers.js';
import { ProjectManager } from './project/ProjectManager.js';
import { QemuRunner } from './qemu/QemuRunner.js';
import { GdbBridge } from './debugger/GdbBridge.js';
import { PeripheralManager } from './peripherals/PeripheralManager.js';
import { PluginCatalog } from './peripherals/PluginCatalog.js';
import { registerBuiltins } from '@breadesp/peripherals';

async function bootstrap() {
  // Singletons shared across IPC handlers.
  registerBuiltins();
  const project = new ProjectManager();
  const qemu = new QemuRunner();
  const gdb = new GdbBridge();
  const peripherals = new PeripheralManager();
  // Local peripheral catalog (P5.2, PRD §F-EXT-3): the offline marketplace.
  const catalog = new PluginCatalog();

  await app.whenReady();
  const win = new BrowserWindow({
    width: 1280, height: 800,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Handlers must be registered before the renderer starts invoking, and the
  // window must exist before them: every Bridge -> UI push (sim:status/uart,
  // per:snapshot, dbg:*) forwards through deps.win.webContents.send — without
  // it the pushes are silently dropped and the UI never hears the sim.
  await registerIpcHandlers({ project, qemu, gdb, peripherals, catalog, win });

  // Dev: load Vite dev server; Prod: load built index.html.
  if (process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await win.loadFile(join(__dirname, '../../ui/dist/index.html'));
  }
}

bootstrap().catch((err) => { console.error(err); process.exit(1); });
