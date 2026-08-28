// PRD: §F-PROJ — Project (.breadesp directory) load/save.
// Layout is stored separately from the netlist (PRD §6.5, §F-BB-4).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validateNetlist } from '@breadesp/netlist';
import type { Netlist } from '@breadesp/netlist';

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
