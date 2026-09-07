// PRD: §F-PER-7, §6.7 — Microphone peripheral model (dev-plan tasks P3.1/P3.2).
//
// The mic is an input peripheral: it produces PCM samples and pushes them
// upstream via ctx.emitInput as I2sInjection frames. The Bridge forwards them
// over the DBus reverse channel to the breadesp-dbus device, whose I2S RX
// shadow writes the samples into the firmware's DMA in-link descriptor buffers
// (packages/sim-core/device/breadesp_dbus.c), so firmware reading I2S RX DMA
// observes the injected waveform.
//
// Two sample sources (P3.2):
// - synth (default): a configurable waveform — sine/square/noise/silence —
//   generated on the wall clock (one chunk per chunkMs);
// - capture: the renderer captures the host microphone (getUserMedia) and
//   pushes mono float chunks over IPC; `acceptCapture` buffers them at the
//   source rate and each tick resamples (linear) one chunkMs worth into the
//   configured format. Capture is a runtime override, never persisted: while
//   chunks keep arriving it wins over synth; after CAPTURE_STALE_MS without a
//   chunk the buffer is dropped and the synth resumes. A starved capture
//   buffer emits nothing (the device leaves armed DMA descriptors untouched),
//   so a paused/silent stream never injects fake silence.
//
// In both modes the device queues injections and the firmware consumes them at
// its own decoded virtual-clock rate, so clock drift between host and guest
// only shows up as queue trim/starvation at the device, never as corruption.
import type {
  CaptureChunk, I2sInjection, Peripheral, PeripheralContext, PeripheralFactory, BusTransaction,
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
/** P3.2: capture is considered stopped after this much feed silence. */
const CAPTURE_STALE_MS = 500;
/** P3.2: at most this much unplayed captured audio is buffered (drop-oldest). */
const CAPTURE_BUFFER_MS = 1000;

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

/**
 * Pure capture drain (P3.2): resample up to `maxFrames` mono samples from
 * `buf` (source rate `srcRate`) to `dstRate` by linear interpolation, starting
 * at fractional read position `pos`. Returns the produced samples and the next
 * fractional position. Produces fewer (or zero) samples when the buffer runs
 * dry — the caller emits nothing in that case (a starved capture must not
 * inject silence the firmware cannot distinguish from a real quiet mic).
 * Exported for tests.
 */
export function drainResampled(
  buf: readonly number[],
  pos: number,
  srcRate: number,
  dstRate: number,
  maxFrames: number,
): { samples: number[]; nextPos: number } {
  const step = srcRate / dstRate;
  const samples: number[] = [];
  let p = pos;
  for (let i = 0; i < maxFrames; i++) {
    // Interpolation reads p and p+1; past the last sample the value clamps to
    // the final sample, so a readable position needs p <= buf.length - 1.
    if (p > buf.length - 1) break;
    const lo = Math.floor(p);
    const hi = Math.min(lo + 1, buf.length - 1);
    const frac = p - lo;
    samples.push(buf[lo] * (1 - frac) + buf[hi] * frac);
    p += step;
  }
  return { samples, nextPos: p };
}

/** Encode mono float samples into one interleaved LE PCM chunk at cfg format. */
function encodeMonoSamples(cfg: MicConfig, samples: readonly number[]): number[] {
  const bytesPerSample = cfg.bits / 8;
  const data = new Array<number>(samples.length * cfg.channels * bytesPerSample).fill(0);
  for (let f = 0; f < samples.length; f++) {
    for (let ch = 0; ch < cfg.channels; ch++) {
      encodeSample(samples[f], cfg.bits, data, (f * cfg.channels + ch) * bytesPerSample);
    }
  }
  return data;
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
  /** Wall clock; a field (not a bare Date.now call) keeps the seam explicit. */
  private readonly now: () => number;
  // --- P3.2 capture state: mono float samples buffered at the source rate. ---
  private capBuf: number[] = [];
  /** Fractional read position into capBuf (drainResampled carries it). */
  private capPos = 0;
  /** Source rate of the buffered samples; a rate change resets the buffer. */
  private capRate = 0;
  /** now() of the last accepted chunk; stale means "capture stopped". */
  private lastFeedAt = -Infinity;
  private warnedCapOverflow = false;

  constructor(instanceId: string, ctx: PeripheralContext, cfg: MicConfig, now: () => number = Date.now) {
    this.instanceId = instanceId;
    this.ctx = ctx;
    this.cfg = cfg;
    this.now = now;
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

  /**
   * Local microphone capture (P3.2, PRD §F-PER-7): buffer a host-captured
   * mono float chunk at its source rate. While chunks keep arriving the tick
   * drains this buffer instead of synthesizing; malformed chunks (non-finite
   * rate/samples) are dropped at this boundary.
   */
  acceptCapture(chunk: CaptureChunk): void {
    if (!Number.isFinite(chunk.rate) || chunk.rate <= 0) return;
    const clean: number[] = [];
    for (const s of chunk.samples) {
      if (!Number.isFinite(s)) return; // a corrupt chunk is dropped whole
      clean.push(Math.min(1, Math.max(-1, s)));
    }
    if (chunk.rate !== this.capRate) {
      // Source-rate change (device switch): resampling across it would smear,
      // so restart the buffer.
      this.capBuf = [];
      this.capPos = 0;
      this.capRate = chunk.rate;
    }
    this.compactCapture();
    this.capBuf.push(...clean);
    // Bound latency: keep at most CAPTURE_BUFFER_MS of unplayed source audio.
    const maxLen = Math.ceil((this.capRate * CAPTURE_BUFFER_MS) / 1000);
    if (this.capBuf.length > maxLen) {
      this.capBuf.splice(0, this.capBuf.length - maxLen);
      if (!this.warnedCapOverflow) {
        this.warnedCapOverflow = true;
        this.ctx.log('warn', `mic '${this.instanceId}': capture buffer overflow; dropping oldest samples`);
      }
    }
    this.lastFeedAt = this.now();
  }

  /** Capture is live while a chunk arrived within the stale window. */
  private captureActive(): boolean {
    return this.now() - this.lastFeedAt < CAPTURE_STALE_MS;
  }

  /** Drop the fully-consumed prefix so the buffer cannot grow without bound. */
  private compactCapture(): void {
    const consumed = Math.floor(this.capPos);
    if (consumed > 0) {
      this.capBuf.splice(0, consumed);
      this.capPos -= consumed;
    }
  }

  private tick(): void {
    if (!this.ctx.emitInput) {
      if (!this.warnedNoChannel) {
        this.warnedNoChannel = true;
        this.ctx.log('warn', `mic '${this.instanceId}': no injection channel; samples dropped`);
      }
      return;
    }
    if (!this.captureActive()) {
      // Capture stopped: drop any unplayed buffer so a later capture restart
      // never replays stale audio, and resume the synth source.
      if (this.capBuf.length > 0) {
        this.capBuf = [];
        this.capPos = 0;
      }
      this.ctx.emitInput(this.synthInjection());
      return;
    }
    const injection = this.captureInjection();
    if (injection !== null) this.ctx.emitInput(injection);
  }

  /** Synth source (P3.1): one chunkMs of the configured waveform. */
  private synthInjection(): I2sInjection {
    const chunk = generatePcmChunk(this.cfg, this.phase, this.noise);
    this.phase = chunk.nextPhase;
    return {
      bus: this.cfg.bus,
      rate: this.cfg.sampleRate,
      bits: this.cfg.bits,
      channels: this.cfg.channels,
      data: chunk.data,
    };
  }

  /**
   * Capture source (P3.2): drain one chunkMs from the buffered host audio,
   * resampled to the configured format. Returns null when the buffer is
   * starved — emitting nothing keeps the device's armed descriptors waiting
   * for real audio instead of claiming them with silence.
   */
  private captureInjection(): I2sInjection | null {
    this.compactCapture();
    const frames = Math.max(1, Math.round((this.cfg.sampleRate * this.cfg.chunkMs) / 1000));
    const drained = drainResampled(this.capBuf, this.capPos, this.capRate, this.cfg.sampleRate, frames);
    if (drained.samples.length === 0) return null;
    this.capPos = drained.nextPos;
    return {
      bus: this.cfg.bus,
      rate: this.cfg.sampleRate,
      bits: this.cfg.bits,
      channels: this.cfg.channels,
      data: encodeMonoSamples(this.cfg, drained.samples),
    };
  }

  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.capBuf = [];
    this.capPos = 0;
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
