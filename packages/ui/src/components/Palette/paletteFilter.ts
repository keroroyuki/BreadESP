// T3.1 — pure palette search. Case-insensitive substring match over both
// the human label and the machine kind, so a third-party peripheral stays
// findable by either name (users may know "sht30" but not its display name).
import type { PaletteEntry } from './paletteEntries';

/** Filter entries by `query`; an empty/blank query returns every entry (copy). */
export function filterPaletteEntries(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...entries];
  return entries.filter(
    (e) => e.label.toLowerCase().includes(q) || e.kind.toLowerCase().includes(q),
  );
}
