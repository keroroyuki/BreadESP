// PRD: §6.2, §F-PER-1 — LED peripheral model.
// Listens to gpio-out transactions; emits 'level' snapshots (0..1).
// PWM brightness via duty cycle is a TODO for later milestone (PRD §8).
import type {
  Peripheral, PeripheralContext, PeripheralFactory, BusTransaction, RenderSnapshot,
} from './types';

class LedPeripheral implements Peripheral {
  readonly kind = 'led';
  readonly instanceId: string;
  private ctx: PeripheralContext;
  private level = 0;

  constructor(instanceId: string, ctx: PeripheralContext) {
    this.instanceId = instanceId;
    this.ctx = ctx;
  }

  onTransaction(tx: BusTransaction): void {
    if (tx.kind !== 'gpio' || tx.dir !== 'write') return;
    const newLevel = tx.data[0] ? 1 : 0;
    if (newLevel === this.level) return;
    this.level = newLevel;
    const snap: RenderSnapshot = { instanceId: this.instanceId, type: 'level', payload: { level: this.level } };
    this.ctx.emitSnapshot(snap);
  }

  // TODO(PRD §F-PER-1): handle pwm-in transactions for brightness.
}

export const ledFactory: PeripheralFactory = {
  kind: 'led',
  version: '0.1.0',
  displayName: 'LED',
  pins: [{ id: 'A', role: 'gpio-out' }, { id: 'K', role: 'gnd', optional: true }],
  create(ctx: PeripheralContext, props?: Record<string, unknown>): Peripheral {
    const instanceId = String(props?.instanceId ?? crypto.randomUUID());
    return new LedPeripheral(instanceId, ctx);
  },
};
