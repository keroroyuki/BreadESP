// PRD: §F-PROJ-1 — bundled example firmware discovery (packaging P6.1).
//
// The golden fixtures (packages/sim-core/fixtures/, scripts/make-*.mjs) double
// as the examples shipped inside the installer (resources/examples/). An
// examples.json manifest names each ELF's chip and one-line purpose; every
// entry is re-verified against the real ELF header before it is listed, so a
// stale manifest degrades to fewer entries instead of wrong ones.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readElfHeader, expectedElfMachine } from '@breadesp/sim-core';
import { chipKindSchema, type ChipKind } from '@breadesp/netlist';

export interface ExampleFirmware {
  /** File name (e.g. 'blink.elf'). */
  name: string;
  /** Absolute path, ready for proj:importFirmware. */
  path: string;
  chip: ChipKind;
  note?: string;
}

interface ExamplesManifest {
  examples?: { file?: unknown; chip?: unknown; note?: unknown }[];
}

/** Test seam: environment touch points are injectable. */
export interface ListExamplesOptions {
  resourcesPath?: string;
  /** Repo-layout walk start (defaults to this module's dir). */
  startDir?: string;
}

/** Candidate directories, packaged layout first. */
function candidateDirs(opts: ListExamplesOptions): string[] {
  const dirs: string[] = [];
  const resourcesPath = opts.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath !== undefined && resourcesPath !== '') dirs.push(join(resourcesPath, 'examples'));
  let dir = opts.startDir ?? __dirname;
  for (let depth = 0; depth < 12; depth++) {
    const candidate = join(dir, 'packages', 'sim-core', 'fixtures');
    if (existsSync(candidate)) {
      dirs.push(candidate);
      break;
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/** The manifest chip must match the ELF header's machine family (never trust JSON alone). */
function chipMatchesElf(path: string, chip: ChipKind): boolean {
  try {
    const buf = readFileSync(path);
    const header = readElfHeader(new Uint8Array(buf.buffer, buf.byteOffset, Math.min(buf.length, 52)));
    return header !== null && header.machine === expectedElfMachine(chip);
  } catch {
    return false;
  }
}

/** List the bundled example firmware; empty when nothing valid is found. */
export function listExampleFirmware(opts: ListExamplesOptions = {}): ExampleFirmware[] {
  const out: ExampleFirmware[] = [];
  const seen = new Set<string>();
  for (const dir of candidateDirs(opts)) {
    const manifestPath = join(dir, 'examples.json');
    if (!existsSync(manifestPath)) continue;
    let manifest: ExamplesManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExamplesManifest;
    } catch {
      continue; // malformed manifest: skip this directory
    }
    for (const entry of manifest.examples ?? []) {
      if (typeof entry?.file !== 'string' || entry.file.includes('/') || entry.file.includes('\\')) continue;
      const chipParsed = chipKindSchema.safeParse(entry.chip);
      if (!chipParsed.success) continue;
      const path = join(dir, entry.file);
      if (seen.has(path) || !existsSync(path) || !chipMatchesElf(path, chipParsed.data)) continue;
      seen.add(path);
      out.push({
        name: entry.file,
        path,
        chip: chipParsed.data,
        note: typeof entry.note === 'string' ? entry.note : undefined,
      });
    }
  }
  return out;
}
