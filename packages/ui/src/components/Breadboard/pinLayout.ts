// PRD: §F-BB-1, §F-BB-4 — Canvas geometry for breadboard nodes and pin anchors.
// Pure functions: the netlist owns wiring logic, the layout owns visual
// coordinates, and this module is the single place translating a wire endpoint
// into canvas coordinates, so rendered pins and wire anchors can never drift.
import { getFactory, registerBuiltins, type PinDescriptor } from '@breadesp/peripherals';
import { MCU_INSTANCE_ID, type LayoutItem, type Wire, type WireEndpoint } from '@breadesp/netlist';

/** Peripheral node box size (visual only — PRD §F-BB-4). */
export const NODE_W = 150;
export const NODE_H = 70;
/** Pin dot radius on the canvas. */
export const PIN_R = 7;
/** Vertical gap between pin label and pin dot. */
export const PIN_LABEL_GAP = 13;

/**
 * ESP32 devkit usable GPIO pins exposed on the canvas MCU node.
 * 6-11 (flash), 20, 24, 28-31 are not broken out / not usable.
 */
export const MCU_GPIO_PINS: readonly number[] = [
  0, 2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39,
];

const MCU_PIN_GAP = 26;
const MCU_HEADER = 44;

/** MCU node — fixed on the canvas for MVP (moving it is a TODO with P1.8 layout load). */
export const MCU_NODE = {
  x: 26,
  y: 120,
  w: 180,
  h: (MCU_GPIO_PINS.length / 2) * MCU_PIN_GAP + MCU_HEADER + 14,
};

const MCU_PIN_INDEX = new Map<string, number>();
for (const [i, n] of MCU_GPIO_PINS.entries()) MCU_PIN_INDEX.set(`GPIO${n}`, i);

// Pin metadata comes from the peripheral factories (PRD §6.2 pins contract);
// the built-in MVP set is registered once here so the UI can render pin dots.
registerBuiltins();

export interface Anchor {
  x: number;
  y: number;
}

/** Pin descriptors of a peripheral kind (empty for unknown kinds). */
export function peripheralPins(kind: string): PinDescriptor[] {
  return getFactory(kind)?.pins ?? [];
}

/** Offset of pin `idx` (of `count`) relative to the node origin; pins sit on the bottom edge. */
export function peripheralPinOffset(idx: number, count: number): Anchor {
  return { x: ((idx + 1) * NODE_W) / (count + 1), y: NODE_H };
}

/** Canvas anchor of a peripheral pin; null when the pin id is unknown for the kind. */
export function peripheralPinAnchor(item: LayoutItem, pinId: string): Anchor | null {
  const pins = peripheralPins(item.kind);
  const idx = pins.findIndex((p) => p.id === pinId);
  if (idx < 0) return null;
  const off = peripheralPinOffset(idx, pins.length);
  return { x: item.x + off.x, y: item.y + off.y };
}

export interface McuPinLayout {
  anchor: Anchor;
  side: 'left' | 'right';
}

/** MCU GPIO pin anchor — two columns on the node's left/right edges; null for non-GPIO pins. */
export function mcuPinLayout(pin: string): McuPinLayout | null {
  const i = MCU_PIN_INDEX.get(pin);
  if (i === undefined) return null;
  const perSide = MCU_GPIO_PINS.length / 2;
  const side = i < perSide ? 'left' : 'right';
  const row = i % perSide;
  return {
    anchor: {
      x: side === 'left' ? MCU_NODE.x : MCU_NODE.x + MCU_NODE.w,
      y: MCU_NODE.y + MCU_HEADER + row * MCU_PIN_GAP,
    },
    side,
  };
}

/** Canvas anchor of any wire endpoint; null when the instance/pin is not on the canvas. */
export function endpointAnchor(ep: WireEndpoint, layout: LayoutItem[]): Anchor | null {
  if (ep.instanceId === MCU_INSTANCE_ID) return mcuPinLayout(ep.pin)?.anchor ?? null;
  const item = layout.find((it) => it.instanceId === ep.instanceId);
  if (!item) return null;
  return peripheralPinAnchor(item, ep.pin);
}

/** Both anchors of a wire; null when either endpoint cannot be placed (wire is not drawable). */
export function wireAnchors(wire: Wire, layout: LayoutItem[]): { from: Anchor; to: Anchor } | null {
  const from = endpointAnchor(wire.from, layout);
  const to = endpointAnchor(wire.to, layout);
  return from !== null && to !== null ? { from, to } : null;
}
