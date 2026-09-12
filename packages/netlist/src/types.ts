// PRD: §6.5 — Netlist schema types (single source of truth for wiring persistence).
// Layout (visual positions) is intentionally NOT part of the netlist; it lives in layout.json.

export type ChipKind = 'esp32' | 'esp32s3' | 'esp32c3' | 'esp32c6'; // MVP: 'esp32' (PRD §8)

export interface PeripheralInstance {
  /** Global unique instance id. */
  instanceId: string;
  /** Matches PeripheralFactory.kind (PRD §6.2). */
  kind: string;
  /** Peripheral-specific params (e.g. I2C address, resolution). */
  props?: Record<string, unknown>;
}

export interface WireEndpoint {
  instanceId: string;
  /** Peripheral pin id, or 'GPIO0'..'GPIO39' when instanceId === 'mcu'. */
  pin: string;
}

export interface Wire {
  id: string;
  from: WireEndpoint;
  to: WireEndpoint;
}

export interface Netlist {
  version: 1;
  chip: ChipKind;
  peripherals: PeripheralInstance[];
  wires: Wire[];
}

/** Sentinel instanceId representing the MCU itself. */
export const MCU_INSTANCE_ID = 'mcu' as const;

// PRD: §F-BB-4, §F-PROJ-1 — layout.json types (the visual half of board
// persistence). Coordinates live here and ONLY here: netlist.json never
// carries positions, layout.json never carries wiring. Shared by the shell
// (disk read/write in ProjectManager) and the UI (store/serialization).

/** One placed peripheral on the canvas (visual only). */
export interface LayoutItem {
  instanceId: string;
  x: number;
  y: number;
  kind: string;
}

/** On-disk layout.json shape. */
export interface LayoutFile {
  version: 1;
  items: LayoutItem[];
}
