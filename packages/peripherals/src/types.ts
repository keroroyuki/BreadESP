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

/**
 * Runtime list of every PinRole (P5.1, PRD §6.1/§F-EXT-1) — the single source
 * the registry validates factory pin tables against. Keep in sync with the
 * PinRole union above; additive union members MUST be appended here too.
 */
export const PIN_ROLES: readonly PinRole[] = [
  'gpio-in', 'gpio-out',
  'pwm-in',
  'i2c-sda', 'i2c-scl',
  'spi-mosi', 'spi-miso', 'spi-sck', 'spi-cs',
  'i2s-ws', 'i2s-bck',
  'i2s-data-in', 'i2s-data-out',
  'adc-in',
  'probe',
  'power', 'gnd',
];

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
  /** Discriminant of the PeripheralInjection union (P3.4); always 'i2s-in'. */
  kind: 'i2s-in';
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

// §6.7 reverse channel (P3.4, PRD §F-BB-3): a peripheral -> MCU GPIO input
// level injection. The device overlays the level onto the firmware-visible
// GPIO_IN registers (the stock esp32.gpio model is a strap-only stub).
export interface GpioInjection {
  kind: 'gpio-in';
  /** MCU GPIO number (0..39) to drive. */
  pin: number;
  level: 0 | 1;
}

// §6.7 reverse channel (P3.4, PRD §F-BB-3): a peripheral -> MCU I2C read
// reply. The device keeps a per-(bus, target) reply mailbox that its I2C
// sniffer serves byte-by-byte to firmware master reads; each frame atomically
// replaces the pending reply, mirroring a sensor's readout register holding
// the latest measurement.
export interface I2cReply {
  kind: 'i2c-out';
  bus: number;
  /** 7-bit slave address the reply belongs to. */
  target: number;
  data: number[];
}

/**
 * Union of everything a peripheral can push upstream towards the MCU
 * (P3.1/P3.4). The discriminant is required: the Bridge serializes each kind
 * field-by-field (the device is an ordered scanner, so wire field order is
 * contractual) and a missing kind must be a compile-time, not a runtime,
 * failure.
 */
export type PeripheralInjection = I2sInjection | GpioInjection | I2cReply;

// §6.2 Context given to a peripheral at creation time.
export interface PeripheralContext {
  /** Push a render snapshot to the UI (throttled by the manager). */
  emitSnapshot: (snapshot: RenderSnapshot) => void;
  /**
   * Push an injection upstream towards the MCU (P3.1: I2S RX PCM; P3.4: GPIO
   * input levels, I2C read replies). Additive optional member — input
   * peripherals use it; consumers without an injection path may leave it
   * undefined.
   */
  emitInput?: (injection: PeripheralInjection) => void;
  /**
   * Drive one of the instance's own gpio-in pins towards the MCU (P3.4,
   * additive optional member). The Bridge resolves the netlist wire
   * (instanceId, pinId) -> MCU GPIO number and injects the level over the DBus
   * reverse channel. Returns false when the pin is not wired to an MCU GPIO
   * (the caller may warn/drop) or when no injection path exists.
   */
  drivePin?: (pinId: string, level: 0 | 1) => boolean;
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
  /**
   * Rotate a knob/encoder by `delta` detent steps (P3.4, additive optional
   * member — only rotary-input models implement it). Positive = clockwise.
   * The model plays the corresponding quadrature transition sequence onto its
   * gpio-in pins over time.
   */
  rotate?(delta: number): void;
  dispose?(): void;
}

// §6.2 Factory contract for registering peripherals.
export interface PeripheralFactory {
  kind: string;
  /** Semantic version of THIS peripheral (semver; enforced at registration, P5.1). */
  version: string;
  displayName: string;
  pins: PinDescriptor[];
  /**
   * Props applied when a netlist instance omits them (e.g. the default I2C
   * address). NetlistResolver reads these so routing and the model itself
   * agree on defaults.
   */
  defaults?: Record<string, unknown>;
  /**
   * SDK contract version the factory was built against (P5.1, additive
   * optional member). Semver string; registration rejects factories built
   * against a NEWER major than the host's PERIPHERAL_SDK_VERSION, since the
   * host cannot guarantee the newer contract surface. Absent = pre-P5.1
   * factory, accepted as compatible with the current host.
   */
  sdkVersion?: string;
  create(ctx: PeripheralContext, props?: Record<string, unknown>): Peripheral;
}

// §6.2, §F-EXT-3 — JSON-safe metadata of a registered factory (P5.2). The
// Bridge sends one per catalog-loaded kind to the renderer, which mirrors it
// into its own registry via registerRemotePeripheral() so the palette, pin
// anchors and generic node body can render the kind without the model code
// (models only ever instantiate in the Bridge process).
export interface PeripheralMeta {
  kind: string;
  version: string;
  displayName: string;
  pins: PinDescriptor[];
  defaults?: Record<string, unknown>;
  sdkVersion?: string;
}

// §F-EXT-3 — Host API handed to a catalog package entry's default export at
// load time (P5.2). Passing the host's own registration surface sidesteps the
// dual-instance hazard: a package that instead imports '@breadesp/peripherals'
// itself only lands in the host registry when module resolution dedupes to the
// host's copy, so the default-export form is the supported contract.
export interface PeripheralHostApi {
  registerPeripheral: (factory: PeripheralFactory) => void;
  /** The host's SDK contract version (gate [BB-222] decisions at load time). */
  PERIPHERAL_SDK_VERSION: string;
}
