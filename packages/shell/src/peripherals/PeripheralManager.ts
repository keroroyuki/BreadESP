// PRD: §4.2, §6.2 — Instantiates peripheral models from the netlist and routes BusTransactions.
import { getFactory, type Peripheral, type PeripheralContext, type BusTransaction, type RenderSnapshot } from '@breadesp/peripherals';
import type { Netlist, PeripheralInstance } from '@breadesp/netlist';
import { EventEmitter } from 'node:events';

export class PeripheralManager extends EventEmitter {
  private instances = new Map<string, Peripheral>();

  /** Build peripheral instances from a validated netlist. */
  applyNetlist(netlist: Netlist): void {
    for (const p of this.instances.values()) p.dispose?.();
    this.instances.clear();

    for (const inst of netlist.peripherals) {
      const factory = getFactory(inst.kind);
      if (!factory) throw new Error(`Unknown peripheral kind: ${inst.kind}`);
      const ctx: PeripheralContext = {
        emitSnapshot: (s: RenderSnapshot) => this.emit('snapshot', s),
        log: (lvl, msg) => this.emit('log', { level: lvl, msg }),
        onTick: () => () => {},
      };
      const p = factory.create(ctx, { instanceId: inst.instanceId, ...inst.props });
      this.instances.set(inst.instanceId, p);
    }
  }

  /** Route an inbound bus transaction to the peripheral(s) on that bus/target. */
  route(tx: BusTransaction): void {
    // TODO(PRD §4.2): use NetlistResolver to map bus+target -> instanceId.
    // MVP: broadcast to all instances that match kind/target; peripherals ignore mismatches.
    for (const p of this.instances.values()) p.onTransaction(tx);
  }

  /** UI button -> drive MCU input. TODO: route to QEMU GPIO input device. */
  driveInput(instanceId: string, pinId: string, level: 0 | 1): void {
    const p = this.instances.get(instanceId);
    p?.driveInput?.(pinId, level);
  }

  list(): PeripheralInstance[] { return [...this.instances.values()].map((p) => ({ instanceId: p.instanceId, kind: p.kind })); }
}
