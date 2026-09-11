// PRD: §6.2, §F-BB-3 — Rotary encoder knob peripheral model (dev-plan task P3.4).
//
// The knob is an input peripheral: rotating it drives a two-phase quadrature
// (Gray code) signal onto its A/B pins, exactly like a mechanical incremental
// encoder. The Bridge resolves each pin's netlist wire to an MCU GPIO number
// (ctx.drivePin, P3.4) and injects the level over the DBus reverse channel
// ({"kind":"gpio-in",...}); the breadesp-dbus device overlays the level onto
// the firmware-visible GPIO_IN registers (the stock esp32.gpio model is a
// strap-only stub), so firmware polling GPIO_IN decodes detents from the
// transition sequence.
//
// One detent ("click") is a full 4-transition Gray cycle; rotate(delta) queues
// delta detents (positive = clockwise = A leads B) played back one transition
// per stepMs on the wall clock, so even tightly polling firmware observes a
// clean transition sequence with no skipped states.
import type { Peripheral, PeripheralContext, PeripheralFactory, BusTransaction } from './types';

/** Validated knob configuration (props are user-controlled netlist data). */
export interface KnobConfig {
  /** Wall-clock milliseconds between two quadrature transitions. */
  stepMs: number;
}

const DEFAULTS = { stepMs: 5 };

/** Knob parameter bounds, exported so UI/tests share one source of truth. */
export const KNOB_LIMITS = {
  stepMs: { min: 1, max: 100 },
  /** |delta| cap per rotate() call (detents); larger spins are clamped. */
  detentsPerCall: 64,
  /** Pending transition queue cap (detents); beyond it spins are dropped. */
  queueDetents: 256,
} as const;

function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** Parse netlist props into a validated config (unknown/invalid values fall back). */
export function knobConfigFromProps(props?: Record<string, unknown>): KnobConfig {
  return {
    stepMs: clampNumber(props?.stepMs, DEFAULTS.stepMs, KNOB_LIMITS.stepMs.min, KNOB_LIMITS.stepMs.max),
  };
}

/**
 * Quadrature pin levels per Gray phase (A leads B clockwise):
 * phase 0 -> (0,0), 1 -> (1,0), 2 -> (1,1), 3 -> (0,1). One step between
 * adjacent phases flips exactly one pin. Exported for tests.
 */
export function quadratureLevels(phase: number): readonly [0 | 1, 0 | 1] {
  switch ((phase & 3) as 0 | 1 | 2 | 3) {
    case 0: return [0, 0];
    case 1: return [1, 0];
    case 2: return [1, 1];
    default: return [0, 1];
  }
}

class KnobPeripheral implements Peripheral {
  readonly kind = 'knob';
  readonly instanceId: string;
  private readonly ctx: PeripheralContext;
  private readonly cfg: KnobConfig;
  /** Current Gray phase 0..3; (0,0) rest state matches the device reset. */
  private phase = 0;
  /** Signed pending transitions (positive = clockwise), 4 per detent. */
  private pending = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly warnedUnwired = new Set<string>();
  private warnedNoChannel = false;
  private warnedQueueDrop = false;

  constructor(instanceId: string, ctx: PeripheralContext, cfg: KnobConfig) {
    this.instanceId = instanceId;
    this.ctx = ctx;
    this.cfg = cfg;
    // Re-sync the rest state: a re-applied netlist rebuilds this instance
    // while the device may still hold levels driven by the disposed one.
    this.drive('A', 0, false);
    this.drive('B', 0, false);
  }

  /** The knob is input-only; MCU-originated traffic is ignored. */
  onTransaction(_tx: BusTransaction): void {}

  /**
   * SW push switch (gpio-in): the Bridge injects the level straight to the
   * wired MCU GPIO — this model keeps no switch state (momentary switch).
   */
  driveInput(_pinId: string, _level: 0 | 1): void {}

  /**
   * Queue `delta` detents of rotation (positive = clockwise). Non-finite and
   * fractional deltas are truncated; oversized spins are clamped so a
   * pathological caller cannot grow the queue without bound.
   */
  rotate(delta: number): void {
    if (!Number.isFinite(delta)) return;
    const detents = Math.min(KNOB_LIMITS.detentsPerCall, Math.max(-KNOB_LIMITS.detentsPerCall, Math.trunc(delta)));
    if (detents === 0) return;
    const maxPending = KNOB_LIMITS.queueDetents * 4;
    let next = this.pending + detents * 4;
    if (Math.abs(next) > maxPending) {
      next = Math.sign(next) * maxPending; // drop the excess: a hand cannot spin faster
      if (!this.warnedQueueDrop) {
        this.warnedQueueDrop = true;
        this.ctx.log('warn', `knob '${this.instanceId}': rotation queue full; extra detents dropped`);
      }
    }
    this.pending = next;
    this.ensureTimer();
  }

  private ensureTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), this.cfg.stepMs);
    // Node timeouts hold the process alive; DOM types lack unref (structural guard).
    const t: unknown = this.timer;
    if (typeof t === 'object' && t !== null && 'unref' in t) {
      (t as { unref: () => void }).unref();
    }
  }

  /** Play one quadrature transition per tick until the queue drains. */
  private tick(): void {
    if (this.pending === 0) {
      if (this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
      return;
    }
    const dir = this.pending > 0 ? 1 : -1;
    const next = (this.phase + dir + 4) & 3;
    const before = quadratureLevels(this.phase);
    const after = quadratureLevels(next);
    if (before[0] !== after[0]) this.drive('A', after[0], true);
    if (before[1] !== after[1]) this.drive('B', after[1], true);
    this.phase = next;
    this.pending -= dir;
  }

  /**
   * Drive one pin through the Bridge wire resolution. Unwired pins drop the
   * transition (warned once per pin); a missing drivePin channel (old Bridge)
   * drops everything (warned once per instance).
   */
  private drive(pinId: string, level: 0 | 1, warn: boolean): void {
    if (!this.ctx.drivePin) {
      if (warn && !this.warnedNoChannel) {
        this.warnedNoChannel = true;
        this.ctx.log('warn', `knob '${this.instanceId}': no GPIO input channel; rotation dropped`);
      }
      return;
    }
    const wired = this.ctx.drivePin(pinId, level);
    if (!wired && warn && !this.warnedUnwired.has(pinId)) {
      this.warnedUnwired.add(pinId);
      this.ctx.log('warn', `knob '${this.instanceId}' pin ${pinId} is not wired to an MCU GPIO; transitions dropped`);
    }
  }

  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.pending = 0;
  }
}

export const knobFactory: PeripheralFactory = {
  kind: 'knob', version: '1.0.0', displayName: 'Rotary Knob (Encoder)',
  pins: [
    { id: 'A', role: 'gpio-in' },
    { id: 'B', role: 'gpio-in' },
    { id: 'SW', role: 'gpio-in', optional: true },
    { id: 'GND', role: 'gnd', optional: true },
  ],
  defaults: { stepMs: DEFAULTS.stepMs },
  create(ctx: PeripheralContext, props?: Record<string, unknown>): Peripheral {
    const instanceId = String(props?.instanceId ?? crypto.randomUUID());
    return new KnobPeripheral(instanceId, ctx, knobConfigFromProps(props));
  },
};
