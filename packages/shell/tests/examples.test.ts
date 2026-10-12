// PRD: §F-PROJ-1 — listExampleFirmware unit tests (packaging P6.1).
// Fixtures are real temp dirs; the ELF header check runs against synthetic
// headers built on the spot (golden-fixture verification lives in sim-core).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EM_XTENSA, EM_RISCV } from '@breadesp/sim-core';
import { listExampleFirmware } from '../src/project/examples.js';

const roots: string[] = [];

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'breadesp-examples-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** Minimal valid ELF32 LE header with the given e_machine. */
function fakeElf(machine: number): Buffer {
  const buf = Buffer.alloc(52);
  buf.set([0x7f, 0x45, 0x4c, 0x46], 0); // magic
  buf[4] = 1; // ELFCLASS32
  buf[5] = 1; // LSB
  buf.writeUInt16LE(2, 0x10); // e_type EXEC
  buf.writeUInt16LE(machine, 0x12);
  return buf;
}

/** Packaged-layout fixture: <parent>/examples/{examples.json,*.elf}. */
function makePackaged(entries: { file: string; chip: string; note?: string; machine?: number }[]): string {
  const parent = fixture();
  const dir = join(parent, 'examples');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'examples.json'),
    JSON.stringify({ version: 1, examples: entries.map(({ file, chip, note }) => ({ file, chip, note })) }),
    'utf8',
  );
  for (const e of entries) {
    const machine = e.machine ?? (e.chip.startsWith('esp32c') ? EM_RISCV : EM_XTENSA);
    writeFileSync(join(dir, e.file), fakeElf(machine));
  }
  return parent;
}

describe('listExampleFirmware (P6.1)', () => {
  it('lists manifest entries with absolute paths after ELF verification', () => {
    const parent = makePackaged([
      { file: 'blink.elf', chip: 'esp32', note: 'LED blink' },
      { file: 's3-blink.elf', chip: 'esp32s3' },
    ]);
    const list = listExampleFirmware({ resourcesPath: parent, startDir: fixture() });
    expect(list.map((e) => e.name)).toEqual(['blink.elf', 's3-blink.elf']);
    expect(list[0].path).toBe(join(parent, 'examples', 'blink.elf'));
    expect(list[0].chip).toBe('esp32');
    expect(list[0].note).toBe('LED blink');
  });

  it('drops entries whose ELF family contradicts the manifest chip', () => {
    const parent = makePackaged([
      { file: 'ok.elf', chip: 'esp32' },
      { file: 'bad.elf', chip: 'esp32c3', machine: EM_XTENSA }, // header disagrees
    ]);
    const list = listExampleFirmware({ resourcesPath: parent, startDir: fixture() });
    expect(list.map((e) => e.name)).toEqual(['ok.elf']);
  });

  it('skips entries with missing files, path separators, or unknown chips', () => {
    const parent = makePackaged([{ file: 'ok.elf', chip: 'esp32' }]);
    const dir = join(parent, 'examples');
    writeFileSync(
      join(dir, 'examples.json'),
      JSON.stringify({
        version: 1,
        examples: [
          { file: 'ok.elf', chip: 'esp32' },
          { file: 'ghost.elf', chip: 'esp32' }, // no file on disk
          { file: '../escape.elf', chip: 'esp32' }, // path traversal attempt
          { file: 'c6.elf', chip: 'esp8266' }, // not a ChipKind
        ],
      }),
      'utf8',
    );
    const list = listExampleFirmware({ resourcesPath: parent, startDir: fixture() });
    expect(list.map((e) => e.name)).toEqual(['ok.elf']);
  });

  it('returns an empty list when no examples directory exists anywhere', () => {
    expect(listExampleFirmware({ resourcesPath: undefined, startDir: fixture() })).toEqual([]);
  });

  it('tolerates a malformed manifest without throwing', () => {
    const parent = fixture();
    mkdirSync(join(parent, 'examples'), { recursive: true });
    writeFileSync(join(parent, 'examples', 'examples.json'), '{ not json', 'utf8');
    expect(listExampleFirmware({ resourcesPath: parent, startDir: fixture() })).toEqual([]);
  });

  it('finds the repo fixtures directory by walking up from a nested start dir', () => {
    const root = fixture();
    const fix = join(root, 'packages', 'sim-core', 'fixtures');
    mkdirSync(fix, { recursive: true });
    writeFileSync(join(fix, 'examples.json'), JSON.stringify({ version: 1, examples: [{ file: 'blink.elf', chip: 'esp32' }] }), 'utf8');
    writeFileSync(join(fix, 'blink.elf'), fakeElf(EM_XTENSA));
    const nested = join(root, 'packages', 'shell', 'dist', 'project');
    mkdirSync(nested, { recursive: true });
    const list = listExampleFirmware({ resourcesPath: undefined, startDir: nested });
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('blink.elf');
  });

  it('the real repo fixtures pass their own manifest verification', () => {
    // Integration with the committed golden fixtures + examples.json (P6.1):
    // the bundled examples must never drift from the actual ELF files.
    const list = listExampleFirmware({ resourcesPath: undefined });
    expect(list.length).toBeGreaterThanOrEqual(8);
    expect(list.some((e) => e.name === 'blink.elf' && e.chip === 'esp32')).toBe(true);
    expect(list.some((e) => e.name === 's3-blink.elf' && e.chip === 'esp32s3')).toBe(true);
    expect(list.every((e) => e.note === undefined || e.note.length > 0)).toBe(true);
  });
});
