// PRD: §F-PER-7, §6.7 — Microphone peripheral model (dev-plan task P3.1).
//
// The mic is an input peripheral: it generates PCM samples (a configurable
// waveform — sine/square/noise/silence; local capture lands with P3.2) and
// pushes them upstream via ctx.emitInput as I2sInjection frames. The Bridge
// forwards them over the DBus reverse channel to the breadesp-dbus device,
// whose I2S RX shadow writes the samples into the firmware's DMA in-link
// descriptor buffers (packages/sim-core/device/breadesp_dbus.c), so firmware
// reading I2S RX DMA observes the injected waveform.
//
// Generation is wall-clock driven (one chunk per chunkMs). The device queues
// injections and the firmware consumes them at its own decoded virtual-clock
// rate, so clock drift between host and guest only shows up as queue
// trim/zero-pad at the device, never as corruption.
import type {
  I2sInjection, Peripheral, PeripheralContext, PeripheralFactory, BusTransaction,
} from './types';

export type MicWaveform = 'sine' | 'square' | 'noise' | 'silence';

/** Validated mic configuration (props are user-controlled netlist data). */
export interface MicConfig {
  waveform: MicWaveform;
  freqHz: number;
  /** 0..1 fraction of full scale. */
  amplitude: number;
  sampleRate: number;
  bits: 8 | 16 | 24 | 32;
  channels: 1 | 2;
  /** I2S controller index the injection targets (0/1). */
  bus: number;
  /** Wall-clock period between emitted chunks. */
  chunkMs: number;
}

const DEFAULTS = {
  waveform: 'sine' as MicWaveform,
  freqHz: 440,
  amplitude: 0.5,
  sampleRate: 16000,
  bits: 16 as const,
  channels: 1 as const,
  bus: 0,
  chunkMs: 20,
};

const WAVEFORMS: readonly MicWaveform[] = ['sine', 'square', 'noise', 'silence'];
const SAMPLE_RATE_MIN = 1000;
const SAMPLE_RATE_MAX = 192000;

function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** Parse netlist props into a validated config (unknown/invalid values fall back). */
export function micConfigFromProps(props?: Record<string, unknown>): MicConfig {
  const waveformRaw = typeof props?.waveform === 'string' ? props.waveform : DEFAULTS.waveform;
  const waveform = (WAVEFORMS as readonly string[]).includes(waveformRaw)
    ? (waveformRaw as MicWaveform)
    : DEFAULTS.waveform;
  const bitsRaw = Number(props?.bits ?? DEFAULTS.bits);
  const bits = ([8, 16, 24, 32] as const).find((b) => b === bitsRaw) ?? DEFAULTS.bits;
  const channelsRaw = Number(props?.channels ?? DEFAULTS.channels);
  const channels = channelsRaw === 2 ? 2 : 1;
  const busRaw = Number(props?.bus ?? DEFAULTS.bus);
  return {
    waveform,
    freqHz: clampNumber(props?.freqHz, DEFAULTS.freqHz, 1, 20000),
    amplitude: clampNumber(props?.amplitude, DEFAULTS.amplitude, 0, 1),
    sampleRate: Math.round(clampNumber(props?.sampleRate, DEFAULTS.sampleRate, SAMPLE_RATE_MIN, SAMPLE_RATE_MAX)),
    bits,
    channels,
    bus: busRaw === 1 ? 1 : 0,
    chunkMs: clampNumber(props?.chunkMs, DEFAULTS.chunkMs, 5, 1000),
  };
}

/** Deterministic noise source (xorshift32) so tests and replays are stable. */
function makeNoise(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    // Map uint32 onto [-1, 1).
    return ((state >>> 0) / 0x100000000) * 2 - 1;
  };
}

/** One sample of the configured waveform at phase (0..1 within the period). */
export function waveformSample(cfg: MicConfig, phase: number, noise: () => number): number {
  switch (cfg.waveform) {
    case 'sine': return cfg.amplitude * Math.sin(2 * Math.PI * phase);
    case 'square': return phase < 0.5 ? cfg.amplitude : -cfg.amplitude;
    case 'noise': return cfg.amplitude * noise();
    case 'silence': return 0;
  }
}

/** Encode one Float32-ish sample in [-1, 1] as little-endian bytes at cfg.bits. */
function encodeSample(sample: number, bits: number, out: number[], offset: number): void {
  const clamped = Math.min(1, Math.max(-1, sample));
  const fullScale = 2 ** (bits - 1);
  // Round towards the nearest integer; +1.0 maps to full-scale - 1 like real ADCs.
  let v = Math.round(clamped * (fullScale - 1));
  if (v < 0) v += 2 * fullScale; // two's complement in `bits` bits
  const bytes = bits / 8;
  for (let b = 0; b < bytes; b++) {
    out[offset + b] = (v >>> (8 * b)) & 0xff;
  }
}

/**
 * Pure chunk generator: produce one chunkMs worth of interleaved PCM bytes.
 * `phase` is the fractional period position carried across calls so a tone
 * stays continuous chunk to chunk; the return value reports the next phase.
 * Exported for tests.
 */
export function generatePcmChunk(
  cfg: MicConfig,
  phase: number,
  noise: () => number = makeNoise(1),
): { data: number[]; nextPhase: number } {
  const frames = Math.max(1, Math.round((cfg.sampleRate * cfg.chunkMs) / 1000));
  const bytesPerSample = cfg.bits / 8;
  const data = new Array<number>(frames * cfg.channels * bytesPerSample).fill(0);
  let p = phase;
  const step = cfg.freqHz / cfg.sampleRate;
  for (let f = 0; f < frames; f++) {
    const s = waveformSample(cfg, p, noise);
    for (let ch = 0; ch < cfg.channels; ch++) {
      encodeSample(s, cfg.bits, data, (f * cfg.channels + ch) * bytesPerSample);
    }
    p = (p + step) % 1;
  }
  return { data, nextPhase: p };
}

class MicPeripheral implements Peripheral {
  readonly kind = 'mic';
  readonly instanceId: string;
  private readonly ctx: PeripheralContext;
  private readonly cfg: MicConfig;
  private phase = 0;
  private readonly noise = makeNoise(0x1234abcd);
  private timer: ReturnType<typeof setInterval> | null = null;
  private warnedNoChannel = false;

  constructor(instanceId: string, ctx: PeripheralContext, cfg: MicConfig) {
    this.instanceId = instanceId;
    this.ctx = ctx;
    this.cfg = cfg;
    this.timer = setInterval(() => this.tick(), this.cfg.chunkMs);
    // Typing boundary: in Node the interval is a Timeout whose unref() keeps a
    // background injection timer from holding the Bridge process alive; the
    // DOM lib types it as number, so guard structurally instead of asserting.
    const t: unknown = this.timer;
    if (typeof t === 'object' && t !== null && 'unref' in t) {
      (t as { unref: () => void }).unref();
    }
  }

  /** The mic is input-only; MCU-originated traffic is ignored. */
  onTransaction(_tx: BusTransaction): void {}

  private tick(): void {
    if (!this.ctx.emitInput) {
      if (!this.warnedNoChannel) {
        this.warnedNoChannel = true;
        this.ctx.log('warn', `mic '${this.instanceId}': no injection channel; samples dropped`);
      }
      return;
    }
    const chunk = generatePcmChunk(this.cfg, this.phase, this.noise);
    this.phase = chunk.nextPhase;
    const injection: I2sInjection = {
      bus: this.cfg.bus,
      rate: this.cfg.sampleRate,
      bits: this.cfg.bits,
      channels: this.cfg.channels,
      data: chunk.data,
    };
    this.ctx.emitInput(injection);
  }

  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const micFactory: PeripheralFactory = {
  kind: 'mic', version: '1.0.0', displayName: 'Microphone (I2S)',
  pins: [{ id: 'DOUT', role: 'i2s-data-out' }, { id: 'WS', role: 'i2s-ws' }, { id: 'BCK', role: 'i2s-bck' }],
  // Injection targets I2S controller 0 unless the netlist overrides props.bus
  // (mirrors the speaker's claim; DOUT/WS/BCK wires are UI-only since the
  // device injects at the DMA engine, before the GPIO matrix).
  defaults: { bus: 0 },
  create(ctx: PeripheralContext, props?: Record<string, unknown>): Peripheral {
    const instanceId = String(props?.instanceId ?? crypto.randomUUID());
    return new MicPeripheral(instanceId, ctx, micConfigFromProps(props));
  },
};
