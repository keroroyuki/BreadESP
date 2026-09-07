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
  // 'probe' added by P2.5 (PRD §F-PER-8): oscilloscope channel tap. Additive
  // union member; consumers that switch on roles must keep a default arm.
  | 'probe'
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

// §6.4, §F-PER-8 — Oscilloscope waveform payload (P2.5). A snapshot carries the
// complete edge list of every active channel inside one scrolling window, so it
// is a restatable state: last-write-wins coalescing in the manager is safe.
export interface WaveformEdge {
  /** Milliseconds from the window start (virtual clock, 0..windowMs). */
  t: number;
  level: 0 | 1;
}

export interface WaveformChannel {
  /** Channel label, e.g. 'CH1'. */
  label: string;
  /** Ordered edges inside the window; the level before the first edge is the
   *  inverse of that edge's level (an edge is by definition a transition). */
  edges: WaveformEdge[];
}

export interface WaveformPayload {
  /** Virtual-clock timestamp of the window start (anchor of every edge.t). */
  startMs: number;
  /** Window width in milliseconds (the scope's time base). */
  windowMs: number;
  channels: WaveformChannel[];
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
    | { samples: number[] }                               // waveform (legacy analog samples)
    | WaveformPayload                                     // waveform (P2.5 digital channels)
    | { text: string }
    | { freqHz: number; duty: number };                    // tone: freqHz>0 & duty>0 = sounding
}

// §6.7 reverse channel (P3.1, PRD §F-PER-7): a peripheral -> MCU PCM injection.
// The Bridge serializes one injection per frame ({"v":1,"in":[<I2sInjection>]})
// back to the breadesp-dbus device, which queues the samples and feeds them
// into the I2S RX DMA descriptors the firmware armed.
export interface I2sInjection {
  /** I2S controller index (0/1) the firmware receives on. */
  bus: number;
  /** Samples per second per channel (must match the firmware's RX config). */
  rate: number;
  /** Bits per sample (8/16/24/32). */
  bits: number;
  /** Channel count (1 = mono, 2 = stereo interleaved). */
  channels: number;
  /** Raw interleaved little-endian PCM bytes (JSON-safe number[]). */
  data: number[];
}

// §6.2 Context given to a peripheral at creation time.
export interface PeripheralContext {
  /** Push a render snapshot to the UI (throttled by the manager). */
  emitSnapshot: (snapshot: RenderSnapshot) => void;
  /**
   * Push an I2S RX PCM injection upstream towards the MCU (P3.1, additive
   * optional member — input peripherals like the mic use it; consumers
   * without an injection path may leave it undefined).
   */
  emitInput?: (injection: I2sInjection) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Subscribe to logical clock ticks. Returns unsubscribe. */
  onTick: (cb: (virtualMs: number) => void) => () => void;
}

// §6.2, §F-PER-7 — Local microphone capture chunk (P3.2). The renderer captures
// the host mic with getUserMedia/WebAudio and pushes mono Float32-range chunks
// over IPC (`per:captureChunk`); the Bridge routes them to the mic instance's
// `acceptCapture`, which resamples/encodes them into I2sInjection frames.
export interface CaptureChunk {
  /** Mono samples in [-1, 1] at `rate` (JSON-safe number[] over IPC). */
  samples: number[];
  /** Source sample rate of `samples` (the AudioContext's rate). */
  rate: number;
}

// §6.2 The peripheral instance.
export interface Peripheral {
  readonly kind: string;
  readonly instanceId: string;
  /**
   * Inbound bus transaction from the simulated MCU.
   * @param viaPin the instance's own pin the transaction was routed through
   *   (P2.5, additive optional parameter — the NetlistResolver knows which
   *   wire delivered a gpio/pwm transaction; single-pin models ignore it).
   */
  onTransaction(tx: BusTransaction, viaPin?: string): void;
  /** Peripheral drives an MCU input pin (e.g. button). */
  driveInput?(pinId: string, level: 0 | 1): void;
  /**
   * Feed a host-captured audio chunk (P3.2, additive optional member — only
   * input peripherals like the mic implement it). Chunks arrive from the
   * renderer at the capture device's native rate; the model resamples.
   */
  acceptCapture?(chunk: CaptureChunk): void;
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
