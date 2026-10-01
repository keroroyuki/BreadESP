// T3.1 — palette search contract: case-insensitive substring over label and
// kind, blank query = full list, unknown query = empty list.
import { describe, it, expect } from 'vitest';
import { filterPaletteEntries } from '../src/components/Palette/paletteFilter';
import type { PaletteEntry } from '../src/components/Palette/paletteEntries';

const entry = (kind: string, label: string): PaletteEntry => ({ kind, label, version: '1.0.0' });
const ENTRIES: PaletteEntry[] = [
  entry('led', 'LED'),
  entry('button', 'Button'),
  entry('sht30', 'SHT30 temperature sensor'),
];

describe('filterPaletteEntries', () => {
  it('returns every entry for an empty query', () => {
    expect(filterPaletteEntries(ENTRIES, '')).toEqual(ENTRIES);
  });

  it('returns every entry for a blank query', () => {
    expect(filterPaletteEntries(ENTRIES, '   ')).toEqual(ENTRIES);
  });

  it('returns a copy for the blank query (not the input identity)', () => {
    expect(filterPaletteEntries(ENTRIES, '')).not.toBe(ENTRIES);
  });

  it('matches the label case-insensitively', () => {
    expect(filterPaletteEntries(ENTRIES, 'SENSOR')).toEqual([ENTRIES[2]]);
  });

  it('matches the kind', () => {
    expect(filterPaletteEntries(ENTRIES, 'sht')).toEqual([ENTRIES[2]]);
  });

  it('matches a substring, not just a prefix', () => {
    expect(filterPaletteEntries(ENTRIES, 'temperature')).toEqual([ENTRIES[2]]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterPaletteEntries(ENTRIES, 'servo')).toEqual([]);
  });

  it('matches several entries at once', () => {
    // "bu" hits both Button (label) and sht30 (no) — Button only here.
    expect(filterPaletteEntries(ENTRIES, 'bu')).toEqual([ENTRIES[1]]);
  });
});
