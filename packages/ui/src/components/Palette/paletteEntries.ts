// PRD: §F-BB-2, §F-EXT-1 — Palette entries derived from the peripheral
// registry (dev-plan P5.1). A third-party package that calls
// registerPeripheral() appears here automatically — no UI code required.
import { listPeripherals, registerBuiltins, type PeripheralFactory } from '@breadesp/peripherals';

export interface PaletteEntry {
  /** Factory kind — the drag payload and the netlist instance kind. */
  kind: string;
  /** Human-facing label (factory displayName). */
  label: string;
  /** Factory semver, shown as a version badge. */
  version: string;
}

/** Pure mapping (testable): registered factories -> palette entries, order preserved. */
export function paletteEntriesFrom(factories: readonly PeripheralFactory[]): PaletteEntry[] {
  return factories.map((f) => ({ kind: f.kind, label: f.displayName, version: f.version }));
}

/**
 * Live palette entries from this process's registry. registerBuiltins is
 * idempotent (P5.1), so every consumer may ensure the built-in set itself.
 */
export function paletteEntries(): PaletteEntry[] {
  registerBuiltins();
  return paletteEntriesFrom(listPeripherals());
}
