// PRD: §F-PROJ — Project (.breadesp directory) load/save.
// Layout is stored separately from the netlist (PRD §6.5, §F-BB-4).
import { copyFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildTemplateProject, chipKindSchema, validateLayout, validateNetlist } from '@breadesp/netlist';
import type { ChipKind, LayoutFile, Netlist } from '@breadesp/netlist';
import { readElfHeader, expectedElfMachine, validateElf } from '@breadesp/sim-core';
import { scanExternalProject } from './ExternalProject.js';
import type { ExternalProjectLink, ExternalScanResult } from './ExternalProject.js';

const META_FILE = 'meta.json';
const NETLIST_FILE = 'netlist.json';
const LAYOUT_FILE = 'layout.json';
const FIRMWARE_FILE = 'firmware.elf';

/** meta.json on-disk shape (project bookkeeping, not board data). */
export interface ProjectMeta {
  version: 1;
  createdAt: number;
  updatedAt: number;
  /**
   * P4.3 (PRD §F-PROJ-3): optional association with an external
   * PlatformIO/ESP-IDF project; absent in pre-P4.3 metas (backward compatible).
   */
  external?: ExternalProjectLink;
}

/** Full project state as loaded from disk (PRD §F-PROJ-1 structure). */
export interface ProjectData {
  dir: string;
  meta: ProjectMeta;
  netlist: Netlist;
  layout: LayoutFile;
  /** Absolute path to <dir>/firmware.elf when imported, else null. */
  firmwareElf: string | null;
  /** Linked external build project (PRD §F-PROJ-3), else null. */
  external: ExternalProjectLink | null;
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

/** Options for `newProject` — the wizard's chip/template picks (dev-plan P4.2). */
export interface NewProjectOptions {
  /** Target chip; defaults to 'esp32' (MVP chip, PRD §8). */
  chip?: ChipKind;
  /** Project template id (@breadesp/netlist templates); defaults to 'empty'. */
  template?: string;
}

export class ProjectManager {
  private dir: string | null = null;

  /**
   * Create a project from a template (dev-plan task P4.2). Refuses to clobber
   * an existing project (new/save-as must target a fresh directory). The
   * template/chip are validated before anything touches disk, then the two
   * persistence halves are written and the project is returned fully
   * validated (same shape as openProject).
   */
  async newProject(dir: string, options?: NewProjectOptions): Promise<ProjectData> {
    const chip: ChipKind = options?.chip ?? 'esp32';
    const templateId = options?.template ?? 'empty';
    if (!chipKindSchema.safeParse(chip).success) {
      throw new Error(`[BB-125] unknown chip "${String(chip)}" (expected esp32/esp32s3/esp32c3/esp32c6)`);
    }
    let built: { netlist: Netlist; layout: LayoutFile };
    try {
      built = buildTemplateProject(templateId, chip);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`[BB-125] ${reason}`);
    }
    if (await pathExists(join(dir, META_FILE))) {
      throw new Error(`[BB-124] project already exists at ${dir}; pick a new directory`);
    }
    this.dir = dir;
    await mkdir(dir, { recursive: true });
    const now = Date.now();
    await writeFile(join(dir, META_FILE), JSON.stringify({ version: 1, createdAt: now, updatedAt: now }, null, 2));
    await writeFile(join(dir, NETLIST_FILE), JSON.stringify(built.netlist, null, 2));
    await writeFile(join(dir, LAYOUT_FILE), JSON.stringify(built.layout, null, 2));
    return this.openProject(dir);
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
    return {
      dir,
      meta,
      netlist,
      layout,
      firmwareElf: (await pathExists(firmwareElf)) ? firmwareElf : null,
      external: meta.external ?? null,
    };
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
   * P4.3 (PRD §F-PROJ-3): associate the open project with an external
   * PlatformIO/ESP-IDF project directory. Detection must succeed before the
   * link is persisted ([BB-127]); the returned scan lists every discovered
   * build/*.elf newest-first, each annotated with `archOk` against the
   * saved netlist's chip.
   */
  async linkExternalProject(dir: string): Promise<ExternalScanResult> {
    if (!this.dir) throw new Error('[BB-124] no project open');
    const scan = await scanExternalProject(dir);
    if (scan === null) {
      throw new Error(`[BB-127] not a PlatformIO or ESP-IDF project: ${dir}`);
    }
    const meta = await this.readMeta(this.dir);
    meta.external = scan.link;
    meta.updatedAt = Date.now();
    await this.writeMeta(meta);
    return this.decorateScan(scan);
  }

  /** Remove the external project association (idempotent). */
  async unlinkExternalProject(): Promise<void> {
    if (!this.dir) throw new Error('[BB-124] no project open');
    const meta = await this.readMeta(this.dir);
    if (meta.external === undefined) return;
    delete meta.external;
    meta.updatedAt = Date.now();
    await this.writeMeta(meta);
  }

  /** Re-scan the linked external project (PRD §F-PROJ-3 auto-discovery). */
  async scanExternalFirmware(): Promise<ExternalScanResult> {
    const meta = await this.linkedMeta();
    const scan = await scanExternalProject(meta.external.dir);
    if (scan === null) {
      throw new Error(`[BB-128] linked project no longer recognized: ${meta.external.dir}`);
    }
    return this.decorateScan(scan);
  }

  /**
   * Copy a discovered external build into the project as firmware.elf
   * (PRD §F-PROJ-1/§F-PROJ-3). Without `elfPath` the newest candidate is
   * picked; an explicit path must be one of the current scan's candidates so
   * this channel cannot import arbitrary files. The P0.6 architecture gate
   * ([BB-101]) applies before anything is copied.
   */
  async importExternalFirmware(elfPath?: string): Promise<string> {
    const scan = await this.scanExternalFirmware();
    if (scan.candidates.length === 0) {
      throw new Error(`[BB-129] no build/*.elf found under ${scan.link.dir} (build the firmware first)`);
    }
    let chosen = scan.candidates[0];
    if (elfPath !== undefined) {
      const found = scan.candidates.find((c) => c.path === elfPath);
      if (found === undefined) {
        throw new Error(`[BB-129] ${elfPath} is not a discovered candidate of ${scan.link.dir}; rescan and pick from the list`);
      }
      chosen = found;
    }
    return this.importFirmware(chosen.path);
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

  /** Meta of the open project with the external link mandatory ([BB-128] otherwise). */
  private async linkedMeta(): Promise<ProjectMeta & { external: ExternalProjectLink }> {
    if (!this.dir) throw new Error('[BB-124] no project open');
    const meta = await this.readMeta(this.dir);
    const external = meta.external;
    if (external === undefined) {
      throw new Error('[BB-128] no external project linked; call proj:linkExternal first');
    }
    return { ...meta, external };
  }

  /**
   * Annotate each candidate with `archOk` — whether its ELF header matches the
   * saved netlist's chip family. An unreadable/undecodable file is simply
   * archOk:false; scanning never fails on a single bad build artifact.
   */
  private async decorateScan(scan: ExternalScanResult): Promise<ExternalScanResult> {
    // linkExternalProject/scanExternalFirmware both run with a project open;
    // loadNetlist re-checks the open-project invariant ([BB-124]).
    const netlist = await this.loadNetlist();
    const expected = expectedElfMachine(netlist.chip);
    const candidates = await Promise.all(
      scan.candidates.map(async (c) => {
        let archOk = false;
        try {
          // Only the 52-byte header decides the architecture; cap the read so
          // a multi-MB app binary is not pulled into memory per candidate.
          const buf = Buffer.alloc(0x34);
          const fh = await open(c.path, 'r');
          try {
            await fh.read(buf, 0, buf.length, 0);
          } finally {
            await fh.close();
          }
          const header = readElfHeader(buf);
          archOk = header !== null && header.machine === expected;
        } catch {
          archOk = false;
        }
        return { ...c, archOk };
      }),
    );
    return { ...scan, candidates };
  }

  private async writeMeta(meta: ProjectMeta): Promise<void> {
    if (!this.dir) throw new Error('[BB-124] no project open');
    await writeFile(join(this.dir, META_FILE), JSON.stringify(meta, null, 2));
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
    const meta: ProjectMeta = { version: 1, createdAt: m.createdAt, updatedAt: m.updatedAt };
    // P4.3 (PRD §F-PROJ-3): optional external link; validated strictly when present.
    if (m.external !== undefined) {
      const ext = m.external as Record<string, unknown> | null;
      if (ext === null || typeof ext !== 'object' || Array.isArray(ext) ||
        (ext.kind !== 'platformio' && ext.kind !== 'esp-idf') ||
        typeof ext.dir !== 'string' || ext.dir.length === 0) {
        throw new Error(`[BB-121] malformed ${META_FILE} in ${dir} (external must be {kind: platformio|esp-idf, dir})`);
      }
      meta.external = { kind: ext.kind, dir: ext.dir };
    }
    return meta;
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
