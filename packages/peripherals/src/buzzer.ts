// PRD: §F-PER-5 — Buzzer (post-MVP). Skeleton stub.
// TODO(PRD §8): PWM freq -> WebAudio square wave synthesis (handled in UI).
import type { PeripheralFactory } from './types';

export const buzzerFactory: PeripheralFactory = {
  kind: 'buzzer', version: '0.0.0-stub', displayName: 'Buzzer (stub)',
  pins: [{ id: '+', role: 'pwm-in' }, { id: '-', role: 'gnd', optional: true }],
  create() { throw new Error('buzzer not implemented (PRD §8 post-MVP)'); },
};
