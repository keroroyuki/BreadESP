// PRD: §F-PROJ — Project (.breadesp directory) load/save.
// Layout is stored separately from the netlist (PRD §6.5, §F-BB-4).
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateLayout, validateNetlist } from '@breadesp/netlist';
import type { ChipKind, LayoutFile, Netlist } from '@breadesp/netlist';
import { validateElf } from '@breadesp/sim-core';

const META_FILE = 'meta.json';
const NETLIST_FILE = 'netlist.json';
const LAYOUT_FILE = 'layout.json';
const FIRMWARE_FILE = 'firmware.elf';

/** meta.json on-disk shape (project bookkeeping, not board data). */
export interface ProjectMeta {
  version: 1;
  createdAt: number;
  updatedAt: number;
}

/** Full project state as loaded from disk (PRD §F-PROJ-1 structure). */
export interface ProjectData {
  dir: string;
  meta: ProjectMeta;
  netlist: Netlist;
  layout: LayoutFile;
  /** Absolute path to <dir>/firmware.elf when imported, else null. */
  firmwareElf: string | null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Parse `raw` as JSON with a readable [BB-code] error carrying `file`. */
async function readJson(file: string, code: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${code} cannot read ${file}: ${reason}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${code} ${file} is not valid JSON: ${reason}`);
  }
}

export class ProjectManager {
  private dir: string | null = null;

  /**
   * Create a skeleton project. Refuses to clobber an existing project
   * (new/save-as must target a fresh directory).
   */
  async newProject(dir: string): Promise<void> {
    if (await pathExists(join(dir, META_FILE))) {
      throw new Error(`[BB-124] project already exists at ${dir}; pick a new directory`);
    }
    this.dir = dir;
    await mkdir(dir, { recursive: true });
    const now = Date.now();
    await writeFile(join(dir, META_FILE), JSON.stringify({ version: 1, createdAt: now, updatedAt: now }, null, 2));
    await writeFile(join(dir, NETLIST_FILE), JSON.stringify(defaultNetlist(), null, 2));
    await writeFile(join(dir, LAYOUT_FILE), JSON.stringify(defaultLayout(), null, 2));
  }

  /** Open a project and return its full validated state; a failed open keeps the previous state. */
  async openProject(dir: string): Promise<ProjectData> {
    const isDir = await stat(dir).then((s) => s.isDirectory()).catch(() => false);
    if (!isDir) throw new Error(`[BB-120] project directory not found: ${dir}`);

    const meta = await this.readMeta(dir);
    const netlist = await this.readNetlist(dir);
    const layout = await this.readLayout(dir);
    const firmwareElf = join(dir, FIRMWARE_FILE);

    this.dir = dir;
    return { dir, meta, netlist, layout, firmwareElf: (await pathExists(firmwareElf)) ? firmwareElf : null };
  }

  /**
   * Pre-load firmware gate (dev-plan task P0.6): the ELF header must match the
   * target chip's architecture, otherwise loading is refused (PRD §9, F-FW-5).
   */
  async validateFirmware(elfPath: string, chip: ChipKind): Promise<void> {
    let buf: Buffer;
    try {
      buf = await readFile(elfPath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`[BB-101] cannot read firmware ELF ${elfPath}: ${reason}`);
    }
    const { ok, issues } = validateElf(buf, chip);
    if (!ok) {
      throw new Error(`[BB-101] firmware ELF ${elfPath} rejected: ${issues.map((i) => i.message).join('; ')}`);
    }
  }

  /**
   * Copy a firmware ELF into the project as firmware.elf (PRD §F-PROJ-1).
   * The chip gate uses the saved netlist's chip as the source of truth.
   */
  async importFirmware(elfPath: string): Promise<string> {
    if (!this.dir) throw new Error('[BB-124] no project open');
    const netlist = await this.readNetlist(this.dir);
    await this.validateFirmware(elfPath, netlist.chip);
    const dest = join(this.dir, FIRMWARE_FILE);
    await copyFile(elfPath, dest);
    return dest;
  }

  /** Persist both halves (netlist.json + layout.json) and bump meta.updatedAt. */
  async saveProject(netlist: Netlist, layout: LayoutFile): Promise<void> {
    if (!this.dir) throw new Error('[BB-124] no project open; call newProject/openProject first');
    const net = validateNetlist(netlist);
    if (!net.ok) throw new Error(`[BB-122] invalid netlist: ${net.issues.map((i) => i.message).join('; ')}`);
    const lay = validateLayout(layout);
    if (!lay.ok) throw new Error(`[BB-123] invalid layout: ${lay.issues.map((i) => i.message).join('; ')}`);
    await writeFile(join(this.dir, NETLIST_FILE), JSON.stringify(netlist, null, 2));
    await writeFile(join(this.dir, LAYOUT_FILE), JSON.stringify(layout, null, 2));
    const meta = await this.readMeta(this.dir);
    meta.updatedAt = Date.now();
    await writeFile(join(this.dir, META_FILE), JSON.stringify(meta, null, 2));
  }

  /** Read-only netlist fetch (used by `bb:getNetlist`). */
  async loadNetlist(): Promise<Netlist> {
    if (!this.dir) throw new Error('[BB-124] no project open');
    return this.readNetlist(this.dir);
  }

  async close(): Promise<void> {
    this.dir = null;
  }

  private async readMeta(dir: string): Promise<ProjectMeta> {
    const file = join(dir, META_FILE);
    if (!(await pathExists(file))) {
      throw new Error(`[BB-120] not a breadesp project (missing ${META_FILE}): ${dir}`);
    }
    const data = await readJson(file, '[BB-121]');
    const m = data as Record<string, unknown> | null;
    if (m === null || typeof m !== 'object' || Array.isArray(m) ||
      m.version !== 1 || typeof m.createdAt !== 'number' || typeof m.updatedAt !== 'number') {
      throw new Error(`[BB-121] malformed ${META_FILE} in ${dir} (expected {version:1, createdAt, updatedAt})`);
    }
    return { version: 1, createdAt: m.createdAt, updatedAt: m.updatedAt };
  }

  private async readNetlist(dir: string): Promise<Netlist> {
    const file = join(dir, NETLIST_FILE);
    const data = await readJson(file, '[BB-122]');
    const { ok, issues } = validateNetlist(data);
    if (!ok) throw new Error(`[BB-122] invalid netlist in ${file}: ${issues.map((i) => i.message).join('; ')}`);
    return data as Netlist;
  }

  private async readLayout(dir: string): Promise<LayoutFile> {
    const file = join(dir, LAYOUT_FILE);
    const data = await readJson(file, '[BB-123]');
    const { ok, issues } = validateLayout(data);
    if (!ok) throw new Error(`[BB-123] invalid layout in ${file}: ${issues.map((i) => i.message).join('; ')}`);
    return data as LayoutFile;
  }
}

function defaultNetlist(): Netlist {
  return { version: 1, chip: 'esp32', peripherals: [], wires: [] };
}

function defaultLayout(): LayoutFile {
  return { version: 1, items: [] };
}
