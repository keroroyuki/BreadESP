// PRD: §6.2, §F-PER-8 — Oscilloscope peripheral model (dev-plan task P2.5).
//
// A 4-channel digital probe. Each channel pin (CH1..CH4, role 'probe') is wired
// to an MCU GPIO like any other peripheral pin, so the NetlistResolver's
// existing pin-level wire routing delivers gpio (and pwm) transactions; the
// PeripheralManager passes the via-pin so the model can attribute a transaction
// to its channel.
//
// Capture: gpio level edges are timestamped with the transaction's virtual-ms
// clock and kept in a per-channel ring buffer pruned to the scrolling window
// (props.windowMs, default 200). A pwm transaction (LEDC decode, P2.3) carries
// no pin toggling, so the channel expands the steady (freq, duty) into
// synthesized edges across the window at snapshot-build time — the drawn
// waveform matches what a real scope would show on that pin.
//
// Snapshots: one 'waveform' snapshot per change carrying the full window state
// of every active channel (WaveformPayload). The payload is a restatable
// state, so the manager's 30fps last-write-wins throttle is safe; identical
// consecutive payloads are suppressed at the source.
//
// TODO(PRD §F-PER-8): I2S bus capture (PCM streams are already audible via the
// speaker; a bus-tap view lands with the P3 input milestone).
import type {
  BusTransaction,
  Peripheral,
  PeripheralContext,
  PeripheralFactory,
  RenderSnapshot,
  WaveformChannel,
  WaveformEdge,
} from './types';

/** Channel pins, in display order. */
const CHANNEL_PINS = ['CH1', 'CH2', 'CH3', 'CH4'] as const;
type ChannelPin = (typeof CHANNEL_PINS)[number];

const DEFAULT_WINDOW_MS = 200;
/** Per-channel edge cap (real + synthesized); guards the JSON frame size. */
const DEFAULT_MAX_EDGES = 1000;
/** LEDC wire payload layout (device-side encoder, see buzzer.ts): 6 bytes. */
const PWM_PAYLOAD_BYTES = 6;

interface AbsEdge {
  /** Absolute virtual-ms timestamp. */
  t: number;
  level: 0 | 1;
}

interface PwmState {
  freqHz: number;
  duty: number; // 0..1
}

interface ChannelState {
  edges: AbsEdge[];
  lastLevel: 0 | 1 | null;
  pwm: PwmState | null;
  /** Saw at least one accepted transaction; a touched channel with no edges
   *  still appears in the payload (the UI draws its flat low rail). */
  touched: boolean;
}

export class OscilloscopePeripheral implements Peripheral {
  readonly kind = 'oscilloscope';
  readonly instanceId: string;
  private ctx: PeripheralContext;
  private readonly windowMs: number;
  private readonly maxEdges: number;
  private readonly channels = new Map<ChannelPin, ChannelState>();
  /** Latest virtual-ms timestamp seen on any channel (window anchor). */
  private clockMs = 0;
  /** JSON of the last emitted payload, for source-side dedupe. */
  private lastEmitted = '';

  constructor(instanceId: string, ctx: PeripheralContext, props?: Record<string, unknown>) {
    this.instanceId = instanceId;
    this.ctx = ctx;
    this.windowMs = positiveNumber(props?.windowMs, DEFAULT_WINDOW_MS);
    this.maxEdges = Math.floor(positiveNumber(props?.maxEdges, DEFAULT_MAX_EDGES));
    for (const pin of CHANNEL_PINS) {
      this.channels.set(pin, { edges: [], lastLevel: null, pwm: null, touched: false });
    }
  }

  onTransaction(tx: BusTransaction, viaPin?: string): void {
    if (tx.dir !== 'write') return;
    const ch = this.channelOf(viaPin);
    if (ch === undefined) return;
    if (!Number.isFinite(tx.ts)) return;
    if (tx.ts > this.clockMs) this.clockMs = tx.ts;

    if (tx.kind === 'gpio') {
      const level: 0 | 1 = tx.data[0] ? 1 : 0;
      if (level === ch.lastLevel) return;
      ch.lastLevel = level;
      ch.pwm = null; // a real pin write supersedes any LEDC decode on this channel
      ch.touched = true;
      ch.edges.push({ t: tx.ts, level });
      if (ch.edges.length > this.maxEdges) ch.edges.splice(0, ch.edges.length - this.maxEdges);
    } else if (tx.kind === 'pwm') {
      const pwm = decodePwm(tx.data);
      if (pwm === null) return;
      const sounding = pwm.freqHz > 0 && pwm.duty > 0;
      // A stop on a channel that never carried a signal changes nothing.
      if (!sounding && !ch.touched) return;
      ch.pwm = sounding ? pwm : null;
      ch.edges = []; // synthesized at snapshot time from the steady state
      ch.lastLevel = null;
      ch.touched = true;
    } else {
      return;
    }
    this.pruneAndEmit();
  }

  private channelOf(viaPin: string | undefined): ChannelState | undefined {
    if (viaPin === undefined) return undefined;
    return this.channels.get(viaPin as ChannelPin);
  }

  /** Drop edges that scrolled out of the window, then emit if anything changed. */
  private pruneAndEmit(): void {
    const startMs = this.clockMs - this.windowMs;
    for (const ch of this.channels.values()) {
      let drop = 0;
      while (drop < ch.edges.length && ch.edges[drop].t < startMs) drop++;
      // Keep one edge before the window start: it carries the level the trace
      // enters the window with (it is re-anchored to t=0 at build time).
      if (drop > 1) ch.edges.splice(0, drop - 1);
    }
    const payload = this.buildPayload(startMs);
    const json = JSON.stringify(payload);
    if (json === this.lastEmitted) return;
    this.lastEmitted = json;
    const snap: RenderSnapshot = { instanceId: this.instanceId, type: 'waveform', payload };
    this.ctx.emitSnapshot(snap);
  }

  private buildPayload(startMs: number): {
    startMs: number;
    windowMs: number;
    channels: WaveformChannel[];
  } {
    const channels: WaveformChannel[] = [];
    for (const pin of CHANNEL_PINS) {
      const ch = this.channels.get(pin)!;
      let edges: WaveformEdge[];
      if (ch.pwm !== null) {
        edges = synthesizePwmEdges(ch.pwm, this.windowMs, this.maxEdges);
      } else if (ch.edges.length > 0) {
        edges = ch.edges.map((e) => ({ t: Math.max(0, e.t - startMs), level: e.level }));
      } else if (ch.touched) {
        edges = []; // signal stopped (or a lone pre-window edge): flat rail
      } else {
        continue; // channel never saw a signal: omit it from the payload
      }
      channels.push({ label: pin, edges });
    }
    return { startMs, windowMs: this.windowMs, channels };
  }
}

/** Decoded LEDC state (same 6-byte wire payload the buzzer consumes). */
function decodePwm(data: Uint8Array): PwmState | null {
  if (data.length < PWM_PAYLOAD_BYTES) return null;
  const centiHz = (data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)) >>> 0;
  const permille = data[4] | (data[5] << 8);
  return { freqHz: centiHz / 100, duty: Math.min(permille, 1000) / 1000 };
}

/**
 * Expand a steady PWM tone into edges across [0, windowMs]. The phase is
 * anchored at the window start (rising edge at t=0); a real scope's trigger
 * does the same visually. Returns an empty list when the tone cannot be drawn
 * (non-finite) and caps the run at maxEdges edges.
 */
function synthesizePwmEdges(pwm: PwmState, windowMs: number, maxEdges: number): WaveformEdge[] {
  const periodMs = 1000 / pwm.freqHz;
  const highMs = periodMs * pwm.duty;
  if (!Number.isFinite(periodMs) || periodMs <= 0 || highMs <= 0) return [];
  const edges: WaveformEdge[] = [];
  for (let t = 0, i = 0; t <= windowMs && edges.length < maxEdges; t += periodMs, i++) {
    edges.push({ t, level: 1 });
    const fall = t + highMs;
    if (fall <= windowMs && edges.length < maxEdges) edges.push({ t: fall, level: 0 });
    void i;
  }
  return edges;
}

function positiveNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const oscilloscopeFactory: PeripheralFactory = {
  kind: 'oscilloscope',
  version: '1.0.0',
  displayName: 'Oscilloscope',
  pins: [
    { id: 'CH1', role: 'probe' },
    { id: 'CH2', role: 'probe', optional: true },
    { id: 'CH3', role: 'probe', optional: true },
    { id: 'CH4', role: 'probe', optional: true },
    { id: 'GND', role: 'gnd', optional: true },
  ],
  defaults: { windowMs: DEFAULT_WINDOW_MS, maxEdges: DEFAULT_MAX_EDGES },
  create(ctx: PeripheralContext, props?: Record<string, unknown>): Peripheral {
    const instanceId = String(props?.instanceId ?? crypto.randomUUID());
    return new OscilloscopePeripheral(instanceId, ctx, props);
  },
};
