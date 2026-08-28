// PRD: §6.3, §F-PER-3 — Sanity test for SSD1306 framebuffer update path.
import { describe, it, expect } from 'vitest';
import { ssd1306Factory } from '../src/ssd1306';
import type { RenderSnapshot, PeripheralContext } from '../src/types';

function makeCtx(snapshots: RenderSnapshot[]): PeripheralContext {
  return {
    emitSnapshot: (s) => snapshots.push(s),
    log: () => {},
    onTick: () => () => {},
  };
}

describe('ssd1306', () => {
  it('emits a pixels snapshot on a data write', () => {
    const snaps: RenderSnapshot[] = [];
    const p = ssd1306Factory.create(makeCtx(snaps), { instanceId: 'oled1', address: 0x3c });
    // Write a single data byte (0xff) into page 0: ctrl=CMD(0xb0 page0), then DATA 0x40 + 0xff
    const data = new Uint8Array([0x00, 0xb0, 0x40, 0xff]);
    p.onTransaction({ kind: 'i2c', bus: 0, target: 0x3c, dir: 'write', data, ts: 0 });
    expect(snaps.length).toBeGreaterThan(0);
    expect(snaps.at(-1)!.type).toBe('pixels');
  });
});
