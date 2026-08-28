// PRD: §F-PER-7 — Microphone / I2S ADC input (post-MVP). Skeleton stub.
// TODO(PRD §8): generated or captured waveform -> I2S/ADC input buffer injection.
import type { PeripheralFactory } from './types';

export const micFactory: PeripheralFactory = {
  kind: 'mic', version: '0.0.0-stub', displayName: 'Microphone (I2S/ADC) (stub)',
  pins: [{ id: 'DOUT', role: 'i2s-data-out' }, { id: 'WS', role: 'i2s-ws' }, { id: 'BCK', role: 'i2s-bck' }],
  create() { throw new Error('mic not implemented (PRD §8 post-MVP)'); },
};
