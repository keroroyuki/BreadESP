// PRD: §F-PER-6 — Speaker / I2S DAC (post-MVP). Skeleton stub.
// TODO(PRD §8): I2S PCM stream -> WebAudio playback.
import type { PeripheralFactory } from './types';

export const speakerFactory: PeripheralFactory = {
  kind: 'speaker', version: '0.0.0-stub', displayName: 'Speaker (I2S) (stub)',
  pins: [{ id: 'DIN', role: 'i2s-data-in' }, { id: 'WS', role: 'i2s-ws' }, { id: 'BCK', role: 'i2s-bck' }],
  create() { throw new Error('speaker not implemented (PRD §8 post-MVP)'); },
};
