// PRD: §4.2, §6.2, §9 — Instantiates peripheral models from the netlist and routes
// BusTransactions. Render snapshots are throttled to a 30fps cap per
// (instanceId, snapshot type) so high-frequency bus traffic cannot flood the UI.
import { getFactory, type Peripheral, type PeripheralContext, type BusTransaction, type RenderSnapshot } from '@breadesp/peripherals';
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
  /** Time source for the throttle window. Test seam: inject a controllable clock. */
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    super();
    this.now = now;
  }

  /**
   * Build peripheral instances from a validated netlist. Atomic: a rejected
   * netlist (duplicate instanceId, unknown kind) leaves the previous instances
   * and routing untouched.
   */
  applyNetlist(netlist: Netlist): void {
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
        if (!factory) throw new Error(`Unknown peripheral kind: ${inst.kind}`);
        const ctx: PeripheralContext = {
          emitSnapshot: (s) => this.emitThrottled(s),
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
    this.resolver.setNetlist(netlist);
  }

  /** Route an inbound bus transaction to the peripheral(s) wired to that bus/target. */
  route(tx: BusTransaction): void {
    for (const target of this.resolver.resolve(tx)) {
      const p = this.instances.get(target.instanceId);
      if (!p) continue;
      try {
        p.onTransaction(tx);
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

  /** UI button -> drive MCU input. TODO: route to QEMU GPIO input device. */
  driveInput(instanceId: string, pinId: string, level: 0 | 1): void {
    const p = this.instances.get(instanceId);
    p?.driveInput?.(pinId, level);
  }

  /** Teardown: dispose instances, cancel pending snapshot timers, drop routing. */
  dispose(): void {
    for (const p of this.instances.values()) p.dispose?.();
    this.instances.clear();
    this.resetThrottle();
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
