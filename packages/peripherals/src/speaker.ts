// PRD: §6.2, §F-PER-6 — Speaker peripheral model (dev-plan task P2.4).
//
// Consumes i2s transactions forwarded by the QEMU breadesp-dbus device: its
// I2S shadow decodes the controller's clock config and walks the TX DMA
// descriptor chain at the PCM byte rate, so each transaction's data[] is
// [sample-rate u32 LE][bits u8][channels u8][flags u8][reserved u8] followed
// by the raw interleaved little-endian PCM bytes exactly as the DMA engine
// would shift them out (see packages/sim-core/device/breadesp_dbus.c).
//
// The model decodes the PCM into mono Float32 samples (multi-channel frames
// are averaged — a speaker has one diaphragm) and emits 'audio' snapshots
// ({samples, sampleRate}, PRD §6.4) which the UI's WebAudio engine schedules
// for playback. A format change mid-stream is reflected in the next
// snapshot's sampleRate; malformed/truncated payloads are dropped silently.
import type {
  Peripheral, PeripheralContext, PeripheralFactory, BusTransaction, RenderSnapshot,
} from './types';

/** Wire header prepended by the device (see the C encoder): 8 bytes. */
const I2S_HEADER_BYTES = 8;

export interface DecodedI2s {
  sampleRate: number;
  samples: number[]; // mono Float32 in [-1, 1]
}

/** Validate and extract the 8-byte wire header, or null when malformed. */
function parseI2sHeader(data: Uint8Array): StreamFormat | null {
  if (data.length < I2S_HEADER_BYTES) return null;
  const sampleRate = (data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)) >>> 0;
  const bits = data[4];
  const channels = data[5];
  if (sampleRate === 0 || channels === 0) return null;
  const bytesPerSample = bits / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample < 1 || bytesPerSample > 4) return null;
  return { sampleRate, bits, channels };
}

/**
 * Decode whole PCM frames (little-endian sign-extended, interleaved channels)
 * into mono Float32 samples in [-1, 1] (channels averaged — a speaker has one
 * diaphragm). `bytes.length` must be a multiple of the frame size.
 */
function decodePcm(bytes: Uint8Array | number[], format: StreamFormat): number[] {
  const bytesPerSample = format.bits / 8;
  const frameBytes = bytesPerSample * format.channels;
  const frames = Math.floor(bytes.length / frameBytes);
  const fullScale = 2 ** (format.bits - 1);
  const samples = new Array<number>(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let ch = 0; ch < format.channels; ch++) {
      const off = f * frameBytes + ch * bytesPerSample;
      // Little-endian sign-extended integer read (bits may not be 16/32).
      let v = 0;
      for (let b = bytesPerSample - 1; b >= 0; b--) v = (v << 8) | bytes[off + b];
      const signBit = 2 ** (format.bits - 1);
      if (v >= signBit) v -= 2 * signBit;
      acc += v / fullScale;
    }
    samples[f] = acc / format.channels;
  }
  return samples;
}

/**
 * Pure decode: i2s wire payload -> mono Float32 samples, or null when the
 * payload is truncated or the format is unsupported. A partial trailing frame
 * is dropped (the stateful model carries it into the next transaction).
 * Exported for tests.
 */
export function decodeI2sPayload(data: Uint8Array): DecodedI2s | null {
  const header = parseI2sHeader(data);
  if (!header) return null;
  const pcm = data.subarray(I2S_HEADER_BYTES);
  const frameBytes = (header.bits / 8) * header.channels;
  const frames = Math.floor(pcm.length / frameBytes);
  if (frames === 0) return null;
  return { sampleRate: header.sampleRate, samples: decodePcm(pcm.subarray(0, frames * frameBytes), header) };
}

/** Batch PCM into chunks of at least this many mono samples before emitting
 *  (≈30ms at 16kHz): one snapshot per 10ms device tick would be needlessly
 *  chatty, and WebAudio scheduling prefers fewer, longer buffers. */
const CHUNK_MIN_SAMPLES = 512;

/** Parsed wire format header of the current stream. */
interface StreamFormat {
  sampleRate: number;
  bits: number;
  channels: number;
}

class SpeakerPeripheral implements Peripheral {
  readonly kind = 'speaker';
  readonly instanceId: string;
  private ctx: PeripheralContext;
  private pending: number[] = [];
  private pendingRate = 0;
  private format: StreamFormat | null = null;
  /** PCM bytes carried across transactions (device chunks split frames). */
  private remainder: number[] = [];

  constructor(instanceId: string, ctx: PeripheralContext) {
    this.instanceId = instanceId;
    this.ctx = ctx;
  }

  onTransaction(tx: BusTransaction): void {
    if (tx.kind !== 'i2s' || tx.dir !== 'write') return;
    const header = parseI2sHeader(tx.data);
    if (!header) return;
    // A format change retunes the stream: flush at the old format first.
    if (this.format !== null
        && (header.sampleRate !== this.format.sampleRate
          || header.bits !== this.format.bits
          || header.channels !== this.format.channels)) {
      this.flush();
      this.remainder = [];
    }
    this.format = header;
    this.pendingRate = header.sampleRate;

    // Rejoin frames split across transactions before decoding.
    const bytesPerSample = header.bits / 8;
    const frameBytes = bytesPerSample * header.channels;
    const pcm = tx.data.subarray(I2S_HEADER_BYTES);
    const bytes = this.remainder.length > 0 ? [...this.remainder, ...pcm] : Array.from(pcm);
    const frames = Math.floor(bytes.length / frameBytes);
    const consumed = frames * frameBytes;
    const decoded = decodePcm(bytes.slice(0, consumed), header);
    this.remainder = bytes.slice(consumed);

    for (const s of decoded) this.pending.push(s);
    if (this.pending.length >= CHUNK_MIN_SAMPLES) this.flush();
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    const snap: RenderSnapshot = {
      instanceId: this.instanceId,
      type: 'audio',
      payload: { samples: this.pending, sampleRate: this.pendingRate },
    };
    this.pending = [];
    this.ctx.emitSnapshot(snap);
  }
}

export const speakerFactory: PeripheralFactory = {
  kind: 'speaker',
  version: '1.0.0',
  displayName: 'Speaker (I2S)',
  pins: [
    { id: 'DIN', role: 'i2s-data-in' },
    { id: 'WS', role: 'i2s-ws' },
    { id: 'BCK', role: 'i2s-bck' },
    { id: '-', role: 'gnd', optional: true },
  ],
  // Routing claims I2S controller 0 unless the netlist overrides props.bus
  // (mirrors the SPI CS claim; see NetlistResolver).
  defaults: { bus: 0 },
  create(ctx: PeripheralContext, props?: Record<string, unknown>): Peripheral {
    const instanceId = String(props?.instanceId ?? crypto.randomUUID());
    return new SpeakerPeripheral(instanceId, ctx);
  },
};
