// PRD: §F-PROJ — Project (.breadesp directory) load/save.
// Layout is stored separately from the netlist (PRD §6.5, §F-BB-4).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validateNetlist } from '@breadesp/netlist';
import type { ChipKind, Netlist } from '@breadesp/netlist';
import { validateElf } from '@breadesp/sim-core';

export interface ProjectPaths {
  firmwareElf: string;
  netlist: string;
  layout: string;
  meta: string;
}

export class ProjectManager {
  private dir: string | null = null;

  async newProject(dir: string): Promise<void> {
    this.dir = dir;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ version: 1, createdAt: Date.now() }, null, 2));
    await writeFile(join(dir, 'netlist.json'), JSON.stringify(defaultNetlist(), null, 2));
    await writeFile(join(dir, 'layout.json'), JSON.stringify({ version: 1, items: [] }, null, 2));
  }

  async openProject(dir: string): Promise<ProjectPaths> {
    this.dir = dir;
    return {
      firmwareElf: join(dir, 'firmware.elf'),
      netlist: join(dir, 'netlist.json'),
      layout: join(dir, 'layout.json'),
      meta: join(dir, 'meta.json'),
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

  async saveNetlist(netlist: Netlist): Promise<void> {
    if (!this.dir) throw new Error('no project open');
    const { ok, issues } = validateNetlist(netlist);
    if (!ok) throw new Error('invalid netlist: ' + JSON.stringify(issues));
    await writeFile(join(this.dir, 'netlist.json'), JSON.stringify(netlist, null, 2));
  }

  async loadNetlist(): Promise<Netlist> {
    if (!this.dir) throw new Error('no project open');
    const raw = await readFile(join(this.dir, 'netlist.json'), 'utf8');
    const data = JSON.parse(raw);
    const { ok, issues } = validateNetlist(data);
    if (!ok) throw new Error('invalid netlist on disk: ' + JSON.stringify(issues));
    return data as Netlist;
  }

  async close(): Promise<void> { this.dir = null; }
}

function defaultNetlist(): Netlist {
  return { version: 1, chip: 'esp32', peripherals: [], wires: [] };
}
