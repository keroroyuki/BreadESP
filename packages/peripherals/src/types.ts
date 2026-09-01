// PRD: §6.1–6.4 — Peripheral SDK core types (contract, do not rename).
// AI Agent: edits here MUST keep backward compat; breakage bumps version (PRD §10.3).

// §6.1 Pin roles
export type PinRole =
  | 'gpio-in' | 'gpio-out'
  | 'pwm-in'
  | 'i2c-sda' | 'i2c-scl'
  | 'spi-mosi' | 'spi-miso' | 'spi-sck' | 'spi-cs'
  | 'i2s-ws' | 'i2s-bck'
  | 'i2s-data-in' | 'i2s-data-out'
  | 'adc-in'
  | 'power' | 'gnd';

export interface PinDescriptor {
  id: string;
  role: PinRole;
  optional?: boolean;
}

// §6.3 BusTransaction (Bridge -> peripheral model)
export interface BusTransaction {
  kind: 'i2c' | 'spi' | 'gpio' | 'pwm' | 'i2s' | 'adc';
  bus: number;
  target?: number;        // i2c address | spi cs | gpio pin
  dir: 'read' | 'write';
  data: Uint8Array;       // write payload
  length?: number;        // read expected length
  ts: number;             // logical timestamp (virtual ms)
}

// §6.4 RenderSnapshot (peripheral model -> UI)
export interface RenderSnapshot {
  instanceId: string;
  // 'tone' added by P2.3 (PRD §F-PER-5): additive union member, backward
  // compatible for producers and consumers that ignore unknown types.
  type: 'pixels' | 'level' | 'audio' | 'waveform' | 'text' | 'tone';
  payload:
    | { width: number; height: number; format: 'mono' | 'rgb565' | 'argb8888'; buffer: number[] | string }
    | { level: number }                                   // 0..1 brightness
    | { samples: number[]; sampleRate: number }            // audio (JSON-safe Float32 as number[])
    | { samples: number[] }                               // waveform
    | { text: string }
    | { freqHz: number; duty: number };                    // tone: freqHz>0 & duty>0 = sounding
}

// §6.2 Context given to a peripheral at creation time.
export interface PeripheralContext {
  /** Push a render snapshot to the UI (throttled by the manager). */
  emitSnapshot: (snapshot: RenderSnapshot) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Subscribe to logical clock ticks. Returns unsubscribe. */
  onTick: (cb: (virtualMs: number) => void) => () => void;
}

// §6.2 The peripheral instance.
export interface Peripheral {
  readonly kind: string;
  readonly instanceId: string;
  /** Inbound bus transaction from the simulated MCU. */
  onTransaction(tx: BusTransaction): void;
  /** Peripheral drives an MCU input pin (e.g. button). */
  driveInput?(pinId: string, level: 0 | 1): void;
  dispose?(): void;
}

// §6.2 Factory contract for registering peripherals.
export interface PeripheralFactory {
  kind: string;
  version: string;
  displayName: string;
  pins: PinDescriptor[];
  /**
   * Props applied when a netlist instance omits them (e.g. the default I2C
   * address). NetlistResolver reads these so routing and the model itself
   * agree on defaults.
   */
  defaults?: Record<string, unknown>;
  create(ctx: PeripheralContext, props?: Record<string, unknown>): Peripheral;
}
