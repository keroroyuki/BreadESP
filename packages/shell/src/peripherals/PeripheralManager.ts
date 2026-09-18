// PRD: §4.2, §6.2, §9 — Instantiates peripheral models from the netlist and routes
// BusTransactions. Render snapshots are throttled to a 30fps cap per
// (instanceId, snapshot type) so high-frequency bus traffic cannot flood the UI.
import { getFactory, type CaptureChunk, type Peripheral, type PeripheralContext, type BusTransaction, type RenderSnapshot } from '@breadesp/peripherals';
import type { Netlist, PeripheralInstance } from '@breadesp/netlist';
import { EventEmitter } from 'node:events';
import { NetlistResolver } from '../netlist/NetlistResolver.js';

/** PRD §9 performance budget: snapshots per (instanceId, type) are capped at 30fps. */
const MAX_SNAPSHOT_FPS = 30;
const SNAPSHOT_INTERVAL_MS = 1000 / MAX_SNAPSHOT_FPS;

/**
 * Per-key throttle slot. Invariant: `pending` is only set while `timer` is armed
 * (a snapshot within the window always schedules exactly one trailing flush).
 */
interface ThrottleSlot {
  lastEmitAt: number;
  pending?: RenderSnapshot;
  timer?: NodeJS.Timeout;
}

export class PeripheralManager extends EventEmitter {
  private instances = new Map<string, Peripheral>();
  private resolver = new NetlistResolver();
  private throttle = new Map<string, ThrottleSlot>();
  /** Unwired gpio-in endpoints already warned about (P3.4, one-shot each). */
  private readonly warnedUnwired = new Set<string>();
  /** Time source for the throttle window. Test seam: inject a controllable clock. */
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    super();
    this.now = now;
  }

  /**
   * Build peripheral instances from a validated netlist. Atomic: a rejected
   * netlist (duplicate instanceId, unknown kind) leaves the previous instances
   * and routing untouched. The new routing is built FIRST (into a scratch
   * resolver) so instance constructors that already drive pins (e.g. the
   * knob's rest-state sync, P3.4) resolve against the incoming wiring; the
   * scratch only replaces the live resolver once every instance exists.
   */
  applyNetlist(netlist: Netlist): void {
    const nextResolver = new NetlistResolver();
    nextResolver.setNetlist(netlist);
    // Build into a scratch map first; commit only after every instance exists.
    const next = new Map<string, Peripheral>();
    const seen = new Set<string>();
    try {
      for (const inst of netlist.peripherals) {
        if (seen.has(inst.instanceId)) {
          throw new Error(`[BB-200] duplicate instanceId '${inst.instanceId}' in netlist`);
        }
        seen.add(inst.instanceId);
        const factory = getFactory(inst.kind);
        // P5.1 (PRD §F-EXT-1): a kind the registry does not know usually means
        // the third-party package was never registered in the Bridge process.
        if (!factory) {
          throw new Error(
            `[BB-206] unknown peripheral kind '${inst.kind}' (instance '${inst.instanceId}'); register the peripheral package before applying the netlist`,
          );
        }
        const ctx: PeripheralContext = {
          emitSnapshot: (s) => this.emitThrottled(s),
          // Input peripherals (mic P3.1, knob/sht30 P3.4) push injections
          // upstream; the owner wires the 'inject' event to DBusChannel.sendInject.
          emitInput: (inj) => this.emit('inject', inj),
          // P3.4: input peripherals drive their own gpio-in pins; the manager
          // resolves (instanceId, pinId) -> MCU GPIO via the netlist wires and
          // injects the level over the reverse channel. Constructors run before
          // the commit, so they resolve against the incoming (scratch) routing.
          drivePin: (pinId, level) => this.injectGpioInput(inst.instanceId, pinId, level, nextResolver),
          log: (lvl, msg) => this.emit('log', { level: lvl, msg }),
          onTick: () => () => {},
        };
        next.set(inst.instanceId, factory.create(ctx, { instanceId: inst.instanceId, ...inst.props }));
      }
    } catch (err) {
      for (const p of next.values()) p.dispose?.();
      throw err;
    }

    for (const p of this.instances.values()) p.dispose?.();
    this.instances = next;
    // A re-applied netlist rebuilds every instance: stale pending snapshots of
    // disposed models must never reach the UI.
    this.resetThrottle();
    // New wiring: unwired-pin warnings (P3.4) restart from a clean slate.
    this.warnedUnwired.clear();
    this.resolver = nextResolver;
  }

  /** Route an inbound bus transaction to the peripheral(s) wired to that bus/target. */
  route(tx: BusTransaction): void {
    for (const target of this.resolver.resolve(tx)) {
      const p = this.instances.get(target.instanceId);
      if (!p) continue;
      try {
        // viaPin (P2.5): multi-pin taps like the oscilloscope attribute the
        // transaction to a channel; single-pin models ignore the argument.
        p.onTransaction(tx, target.pin);
      } catch (err) {
        // One failing model must not break delivery to the other targets; the
        // error is logged with instance/transaction context (PRD §4.7).
        const reason = err instanceof Error ? err.message : String(err);
        this.emit('log', {
          level: 'error',
          msg: `[BB-201] peripheral '${target.instanceId}' failed on ${tx.kind} transaction (bus=${tx.bus}, target=${tx.target ?? 'n/a'}): ${reason}`,
        });
      }
    }
  }

  /**
   * UI input -> drive MCU input pin (P1 button, P3.4): the model hears the
   * gesture (driveInput hook), and the resolved wire injects the level over
   * the DBus reverse channel so firmware GPIO_IN reads observe it.
   */
  driveInput(instanceId: string, pinId: string, level: 0 | 1): void {
    const p = this.instances.get(instanceId);
    p?.driveInput?.(pinId, level);
    this.injectGpioInput(instanceId, pinId, level);
  }

  /**
   * UI rotation gesture -> rotary encoder model (P3.4): the model plays the
   * quadrature transition sequence onto its pins over time. Unknown instances
   * and models without rotate() drop the gesture silently — a netlist
   * re-apply may dispose an instance while its UI widget is still live.
   */
  driveRotate(instanceId: string, delta: number): void {
    const p = this.instances.get(instanceId);
    p?.rotate?.(delta);
  }

  /**
   * Resolve a peripheral pin's wire to an MCU GPIO number and inject the
   * level as a gpio-in reverse frame (P3.4). Returns false (and warns once
   * per endpoint) when the pin is not wired to an MCU GPIO. `resolver`
   * overrides the live routing for constructor-time drives during applyNetlist.
   */
  private injectGpioInput(instanceId: string, pinId: string, level: 0 | 1, resolver: NetlistResolver = this.resolver): boolean {
    const gpio = resolver.resolveGpioInput(instanceId, pinId);
    if (gpio === undefined) {
      const key = `${instanceId}|${pinId}`;
      if (!this.warnedUnwired.has(key)) {
        this.warnedUnwired.add(key);
        this.emit('log', {
          level: 'warn',
          msg: `[BB-205] '${instanceId}' pin ${pinId} is not wired to an MCU GPIO; input dropped`,
        });
      }
      return false;
    }
    this.emit('inject', { kind: 'gpio-in', pin: gpio, level });
    return true;
  }

  /**
   * Local mic capture (P3.2, PRD §F-PER-7): route a renderer-captured PCM
   * chunk to the instance's acceptCapture. Unknown instances and models
   * without a capture sink drop the chunk silently — a netlist re-apply may
   * dispose an instance while its renderer-side stream is still live.
   */
  feedCapture(instanceId: string, chunk: CaptureChunk): void {
    const p = this.instances.get(instanceId);
    p?.acceptCapture?.(chunk);
  }

  /** Teardown: dispose instances, cancel pending snapshot timers, drop routing. */
  dispose(): void {
    for (const p of this.instances.values()) p.dispose?.();
    this.instances.clear();
    this.resetThrottle();
    this.warnedUnwired.clear();
    this.resolver.setNetlist({ version: 1, chip: 'esp32', peripherals: [], wires: [] });
  }

  list(): PeripheralInstance[] { return [...this.instances.values()].map((p) => ({ instanceId: p.instanceId, kind: p.kind })); }

  /**
   * 30fps snapshot gate (PRD §9, dev-plan §10.4). The first snapshot of a quiet
   * period is emitted immediately (low latency); snapshots arriving within one
   * interval of the last emission are coalesced last-write-wins and the newest
   * is flushed at the end of the window. Emissions for a key therefore stay at
   * least SNAPSHOT_INTERVAL_MS apart (sustained rate <= 30fps) while the UI
   * always converges to the latest state.
   */
  private emitThrottled(s: RenderSnapshot): void {
    // 'audio' snapshots (P2.4) are a PCM *stream*, not a restatable state:
    // last-write-wins coalescing would silently drop samples and corrupt the
    // waveform, so they bypass the throttle. The stream rate is bounded at
    // the source (the speaker model batches ~30ms chunks; the QEMU device
    // ticks at 10ms), so the PRD §9 flood budget still holds.
    if (s.type === 'audio') {
      this.emit('snapshot', s);
      return;
    }
    const key = `${s.instanceId}|${s.type}`;
    const now = this.now();
    const slot = this.throttle.get(key);

    if (slot === undefined) {
      this.throttle.set(key, { lastEmitAt: now });
      this.emit('snapshot', s); // quiet period: leading edge, immediate
      return;
    }
    if (slot.timer !== undefined) {
      slot.pending = s; // mid-burst: keep only the newest snapshot of the window
      return;
    }
    const sinceLast = now - slot.lastEmitAt;
    if (sinceLast >= SNAPSHOT_INTERVAL_MS) {
      slot.lastEmitAt = now;
      this.emit('snapshot', s);
      return;
    }
    slot.pending = s;
    slot.timer = setTimeout(() => this.flushSlot(key), SNAPSHOT_INTERVAL_MS - sinceLast);
  }

  /** Trailing edge: deliver the newest coaleszed snapshot of the window. */
  private flushSlot(key: string): void {
    const slot = this.throttle.get(key);
    if (slot === undefined) return; // throttle was reset while the timer was armed
    slot.timer = undefined;
    const s = slot.pending;
    slot.pending = undefined;
    if (s === undefined) return;
    slot.lastEmitAt = this.now();
    this.emit('snapshot', s);
  }

  /** Drop all throttle state, cancelling any armed trailing flush. */
  private resetThrottle(): void {
    for (const slot of this.throttle.values()) {
      if (slot.timer !== undefined) clearTimeout(slot.timer);
    }
    this.throttle.clear();
  }
}
