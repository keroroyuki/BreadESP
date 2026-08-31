// PRD: §F-BB-1, §F-BB-4 — pin anchor geometry.
// Pins and wire endpoints must resolve through this single module, so the
// rendered dots and the bezier anchors can never disagree.
import { describe, it, expect } from 'vitest';
import { MCU_INSTANCE_ID, type Wire } from '@breadesp/netlist';
import {
  MCU_GPIO_PINS,
  MCU_NODE,
  NODE_H,
  NODE_W,
  endpointAnchor,
  mcuPinLayout,
  peripheralPinAnchor,
  peripheralPinOffset,
  peripheralPins,
  wireAnchors,
} from '../src/components/Breadboard/pinLayout';
import type { LayoutItem } from '../src/store/projectStore';

describe('pinLayout', () => {
  it('exposes the factory pins for the MVP peripheral set', () => {
    expect(peripheralPins('led').map((p) => p.id)).toEqual(['A', 'K']);
    expect(peripheralPins('button').map((p) => p.id)).toEqual(['1', '2']);
    expect(peripheralPins('ssd1306').map((p) => p.id)).toEqual(['SDA', 'SCL', 'VCC', 'GND']);
    expect(peripheralPins('unknown-kind')).toEqual([]);
  });

  it('spreads peripheral pins evenly along the bottom edge', () => {
    const pins = peripheralPins('led');
    const offs = pins.map((_, i) => peripheralPinOffset(i, pins.length));
    expect(offs[0]).toEqual({ x: NODE_W / 3, y: NODE_H });
    expect(offs[1]).toEqual({ x: (2 * NODE_W) / 3, y: NODE_H });
    expect(offs.every((o) => o.x > 0 && o.x < NODE_W)).toBe(true);
  });

  it('anchors peripheral pins relative to the instance position', () => {
    const item: LayoutItem = { instanceId: 'led-1', x: 100, y: 50, kind: 'led' };
    expect(peripheralPinAnchor(item, 'A')).toEqual({ x: 100 + NODE_W / 3, y: 50 + NODE_H });
    expect(peripheralPinAnchor(item, 'nope')).toBeNull();
  });

  it('anchors MCU GPIO pins on the node edges in two columns', () => {
    const left = mcuPinLayout('GPIO2');
    const right = mcuPinLayout('GPIO39');
    expect(left?.side).toBe('left');
    expect(left?.anchor.x).toBe(MCU_NODE.x);
    expect(right?.side).toBe('right');
    expect(right?.anchor.x).toBe(MCU_NODE.x + MCU_NODE.w);
    expect(mcuPinLayout('GPIO40')).toBeNull(); // not exposed
    expect(mcuPinLayout('SDA')).toBeNull(); // MCU node speaks GPIO only (PRD §6.5)

    // Every exposed pin anchors inside the node's vertical extent, all distinct.
    const anchors = MCU_GPIO_PINS.map((n) => mcuPinLayout(`GPIO${n}`));
    expect(anchors.every((a) => a !== null && a.anchor.y >= MCU_NODE.y && a.anchor.y <= MCU_NODE.y + MCU_NODE.h)).toBe(true);
    expect(new Set(anchors.map((a) => `${a?.anchor.x},${a?.anchor.y}`)).size).toBe(MCU_GPIO_PINS.length);
  });

  it('resolves wire endpoints via the layout', () => {
    const layout: LayoutItem[] = [{ instanceId: 'led-1', x: 100, y: 50, kind: 'led' }];
    expect(endpointAnchor({ instanceId: MCU_INSTANCE_ID, pin: 'GPIO2' }, layout)).toEqual(
      mcuPinLayout('GPIO2')?.anchor,
    );
    expect(endpointAnchor({ instanceId: 'led-1', pin: 'A' }, layout)).toEqual({
      x: 100 + NODE_W / 3,
      y: 50 + NODE_H,
    });
    expect(endpointAnchor({ instanceId: 'ghost', pin: 'A' }, layout)).toBeNull();
    expect(endpointAnchor({ instanceId: 'led-1', pin: 'ZZ' }, layout)).toBeNull();
  });

  it('draws wires whose endpoints are both placeable and skips the others', () => {
    const layout: LayoutItem[] = [{ instanceId: 'led-1', x: 100, y: 50, kind: 'led' }];
    const wire: Wire = {
      id: 'wire-1',
      from: { instanceId: 'led-1', pin: 'A' },
      to: { instanceId: MCU_INSTANCE_ID, pin: 'GPIO2' },
    };
    const a = wireAnchors(wire, layout);
    expect(a).not.toBeNull();
    expect(a?.from).toEqual({ x: 100 + NODE_W / 3, y: 50 + NODE_H });
    expect(a?.to).toEqual(mcuPinLayout('GPIO2')?.anchor);

    const dangling: Wire = { ...wire, to: { instanceId: 'ghost', pin: 'A' } };
    expect(wireAnchors(dangling, layout)).toBeNull();
  });
});
