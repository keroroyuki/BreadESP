// PRD: §F-PER-4 — ST7789 TFT (post-MVP). Skeleton stub.
// TODO(PRD §8): implement SPI command interpreter + rgb565 framebuffer.
import type { PeripheralFactory } from './types';

export const st7789Factory: PeripheralFactory = {
  kind: 'st7789',
  version: '0.0.0-stub',
  displayName: 'ST7789 TFT 240x240 (stub)',
  pins: [
    { id: 'MOSI', role: 'spi-mosi' },
    { id: 'SCK', role: 'spi-sck' },
    { id: 'CS', role: 'spi-cs' },
    { id: 'DC', role: 'gpio-in' },
  ],
  create() { throw new Error('st7789 not implemented (PRD §8 post-MVP)'); },
};
