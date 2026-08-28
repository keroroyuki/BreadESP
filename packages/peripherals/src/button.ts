// PRD: §6.2, §F-PER-2 — Button peripheral model.
// UI drives driveInput() to push level into the MCU GPIO input.
import type { Peripheral, PeripheralContext, PeripheralFactory } from './types';

class ButtonPeripheral implements Peripheral {
  readonly kind = 'button';
  readonly instanceId: string;

  constructor(instanceId: string, _ctx: PeripheralContext) {
    this.instanceId = instanceId;
    // TODO(PRD §F-PER-2): consume ctx (log/onTick) when GPIO input injection lands in P1.
  }

  onTransaction(): void {
    // Buttons are input-only; nothing to consume from MCU.
  }

  // driveInput is invoked by the UI click handler through the Bridge.
  // Actual GPIO injection happens in PeripheralManager (it routes driveInput -> MCU input).
}

export const buttonFactory: PeripheralFactory = {
  kind: 'button',
  version: '0.1.0',
  displayName: 'Push Button',
  pins: [{ id: '1', role: 'gpio-in' }, { id: '2', role: 'gnd', optional: true }],
  create(ctx: PeripheralContext, props?: Record<string, unknown>): Peripheral {
    const instanceId = String(props?.instanceId ?? crypto.randomUUID());
    return new ButtonPeripheral(instanceId, ctx);
  },
};
