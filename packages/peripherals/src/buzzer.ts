// PRD: §6.2, §F-PER-5 — Buzzer peripheral model (dev-plan task P2.3).
//
// Two input paths converge on one tone state:
//
// - pwm transactions (authoritative): the QEMU breadesp-dbus device shadows the
//   LEDC timer/channel registers and the GPIO-matrix FUNCn_OUT_SEL config, so a
//   firmware `ledc` configuration arrives here already decoded — data[] is
//   [freq-centihertz u32 LE][duty-permille u16 LE] (see packages/sim-core/
//   device/breadesp_dbus.c). A tone is sounding iff freqHz > 0 and duty > 0.
//
// - gpio transactions (bit-bang fallback): a firmware that toggles the pin by
//   hand produces level edges; the model measures the rising-edge period over
//   the last few edges (virtual-ms timestamps) and derives the frequency with a
//   fixed 50% duty. Silence cannot be detected on this path (the manager's
//   onTick is a no-op stub — documented TODO, PRD §8); the LEDC path emits an
//   explicit stop.
//
// Snapshots: 'tone' ({freqHz, duty}) feeds both the WebAudio synthesis and the
// breadboard visual (the duty doubles as the glow level — the simulation store
// keeps one latest snapshot per instance, so a single snapshot type avoids
// tone/level clobbering). Emissions are deduplicated: a steady tone costs at
// most one snapshot per change.
import type {
  Peripheral, PeripheralContext, PeripheralFactory, BusTransaction, RenderSnapshot,
} from './types';

/** LEDC wire payload layout (device-side encoder): 6 bytes. */
const PWM_PAYLOAD_BYTES = 6;
/** Bit-bang fallback: rising-edge window for the period average. */
const EDGE_WINDOW = 8;
/** Bit-bang fallback: ignore periods outside the audible-plausible band. */
const MIN_FREQ_HZ = 5;
const MAX_FREQ_HZ = 20_000;
/** Bit-bang fallback: re-emit only when the estimate moved by this ratio. */
const EDGE_DRIFT_TOLERANCE = 0.03;

interface Tone {
  freqHz: number;
  duty: number; // 0..1; 0 = silent
}

class BuzzerPeripheral implements Peripheral {
  readonly kind = 'buzzer';
  readonly instanceId: string;
  private ctx: PeripheralContext;
  private tone: Tone = { freqHz: 0, duty: 0 };
  private risingEdges: number[] = [];
  private lastGpio = 0;

  constructor(instanceId: string, ctx: PeripheralContext) {
    this.instanceId = instanceId;
    this.ctx = ctx;
  }

  onTransaction(tx: BusTransaction): void {
    if (tx.dir !== 'write') return;
    if (tx.kind === 'pwm') {
      this.onPwm(tx.data);
    } else if (tx.kind === 'gpio') {
      this.onGpioEdge(tx);
    }
  }

  /** Decoded LEDC state from the device shadow. */
  private onPwm(data: Uint8Array): void {
    if (data.length < PWM_PAYLOAD_BYTES) return;
    const centiHz = (data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)) >>> 0;
    const permille = data[4] | (data[5] << 8);
    const freqHz = centiHz / 100;
    const duty = Math.min(permille, 1000) / 1000;
    this.setTone(freqHz > 0 && duty > 0 ? { freqHz, duty } : { freqHz: 0, duty: 0 });
  }

  /** Bit-bang fallback: derive the frequency from rising-edge periods. */
  private onGpioEdge(tx: BusTransaction): void {
    const level = tx.data[0] ? 1 : 0;
    if (level === this.lastGpio) return;
    this.lastGpio = level;
    if (level === 0) return; // falling edge: period state only

    this.risingEdges.push(tx.ts);
    if (this.risingEdges.length > EDGE_WINDOW) this.risingEdges.shift();
    const edges = this.risingEdges;
    if (edges.length < 4) return;

    const periodMs = (edges[edges.length - 1] - edges[0]) / (edges.length - 1);
    if (periodMs <= 0) return;
    const freqHz = 1000 / periodMs;
    if (freqHz < MIN_FREQ_HZ || freqHz > MAX_FREQ_HZ) return;

    // Steady-tone dedupe with a drift band: qemu virtual timestamps quantize
    // the estimate, so a constant bit-bang would otherwise re-emit forever.
    const prev = this.tone;
    if (prev.freqHz > 0 && Math.abs(freqHz - prev.freqHz) / prev.freqHz < EDGE_DRIFT_TOLERANCE) {
      return;
    }
    this.setTone({ freqHz, duty: 0.5 });
  }

  private setTone(next: Tone): void {
    const prev = this.tone;
    if (next.freqHz === prev.freqHz && next.duty === prev.duty) return;
    this.tone = next;
    const toneSnap: RenderSnapshot = {
      instanceId: this.instanceId,
      type: 'tone',
      payload: { freqHz: next.freqHz, duty: next.duty },
    };
    this.ctx.emitSnapshot(toneSnap);
  }
}

export const buzzerFactory: PeripheralFactory = {
  kind: 'buzzer',
  version: '1.0.0',
  displayName: 'Buzzer',
  pins: [{ id: '+', role: 'pwm-in' }, { id: '-', role: 'gnd', optional: true }],
  create(ctx: PeripheralContext, props?: Record<string, unknown>): Peripheral {
    const instanceId = String(props?.instanceId ?? crypto.randomUUID());
    return new BuzzerPeripheral(instanceId, ctx);
  },
};
