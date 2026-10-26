// 3D wiring geometry (step 3): where pins meet the world, and what colour each
// pin role gets.
//
// Why this is separate from `Breadboard/pinLayout.ts`: that module owns the *2D*
// canvas geometry, where a node is a 150×70 editing box and every pin sits on the
// box's bottom edge. A 3D part body is only 25–50 units across, so pins on the box
// edge would float tens of units away from the model. The 3D row therefore sits on
// the model's own header, derived from the same factory pin list (same order, same
// ids) — pin identity has one source, placement is view-specific.
import type { PinRole } from '@breadesp/peripherals';
import { MCU_GPIO_PINS, mcuPinLayout, peripheralPins } from '../../Breadboard/pinLayout';
import { modelKeyFor, type ModelKey } from '../modelCatalog';

/** Header row of a model in board-local coordinates (model centred at origin). */
export interface PinRow3D {
  /** Distance between adjacent pins. */
  spacing: number;
  /** Row centre along Z. */
  z: number;
  /** Height the pins rise from (PCB top). */
  base: number;
  /** Pin length. */
  length: number;
}

/**
 * One row per modelled kind. Numbers mirror the matching model file — the models
 * import their own entry, so the decorative gold pins and the wiring anchors can
 * never disagree.
 */
export const PIN_ROWS_3D: Record<ModelKey, PinRow3D> = {
  // Two legs at x = ±3.6.
  led: { spacing: 7.2, z: 0, base: 0, length: 2.6 },
  // The two front legs of the four-legged switch.
  button: { spacing: 18, z: 9, base: 0, length: 3 },
  buzzer: { spacing: 12, z: 4, base: 0, length: 2.4 },
  speaker: { spacing: 4, z: -15, base: 3, length: 2.4 },
  ssd1306: { spacing: 4, z: 16.6, base: 3, length: 2.6 },
  st7789: { spacing: 3.4, z: -22.8, base: 3, length: 2.6 },
  // The instrument's rear pin strip (CH1..CH4 + GND).
  oscilloscope: { spacing: 8, z: 20, base: 0, length: 3 },
  mic: { spacing: 3.6, z: 13.4, base: 2.4, length: 2.2 },
  knob: { spacing: 4, z: 11.4, base: 0, length: 2.4 },
  sht30: { spacing: 4, z: 13.4, base: 2.6, length: 2.2 },
  generic: { spacing: 4, z: 13.4, base: 3, length: 2.2 },
};

/** MCU board thickness (also used by McuModel). */
export const MCU_BOARD_H = 6;
/** Height of the MCU header strip standing on the PCB. */
export const MCU_PIN_STRIP_H = 7.2;
/** Y of the MCU pad top — where wires attach. */
export const MCU_PIN_Y = MCU_BOARD_H + MCU_PIN_STRIP_H + 0.1;

export interface PinAnchor3D {
  /** Factory pin id (the netlist's endpoint pin). */
  pin: string;
  role: PinRole;
  position: [number, number, number];
}

/**
 * World-space anchors of a part's pins when its node box is centred at (cx, cz).
 * Pins are centred on that point, so a part keeps its pins whatever the factory
 * pin count is (a 3-pin mic and a 9-pin TFT both stay centred on their row).
 */
export function partPinAnchors(kind: string, cx: number, cz: number): PinAnchor3D[] {
  const pins = peripheralPins(kind);
  const row = PIN_ROWS_3D[modelKeyFor(kind)];
  const half = ((pins.length - 1) * row.spacing) / 2;
  return pins.map((p, i) => ({
    pin: p.id,
    role: p.role,
    position: [cx + i * row.spacing - half, row.base + row.length, cz + row.z],
  }));
}

/** World-space anchor of one MCU GPIO pin, or null for a non-GPIO pin. */
export function mcuPinAnchor(pin: string): [number, number, number] | null {
  const layout = mcuPinLayout(pin);
  if (layout === null) return null;
  return [layout.anchor.x, MCU_PIN_Y, layout.anchor.y];
}

/** Every MCU GPIO pin as a 3D anchor (order = MCU_GPIO_PINS). */
export function mcuPinAnchors(): PinAnchor3D[] {
  const out: PinAnchor3D[] = [];
  for (const n of MCU_GPIO_PINS) {
    const pin = `GPIO${n}`;
    const position = mcuPinAnchor(pin);
    if (position !== null) out.push({ pin, role: 'gpio-out', position });
  }
  return out;
}

/**
 * Colours by bus family: a wire between two amber pins is a GPIO, blue is I2C,
 * purple SPI, pink I2S, red power, grey ground. Exhaustive over PinRole, so a new
 * role in the SDK fails the typecheck here instead of rendering an undefined colour.
 */
const ROLE_COLORS: Record<PinRole, string> = {
  'gpio-in': '#fbbf24',
  'gpio-out': '#fbbf24',
  'pwm-in': '#fb923c',
  'i2c-sda': '#38bdf8',
  'i2c-scl': '#38bdf8',
  'spi-mosi': '#a78bfa',
  'spi-miso': '#a78bfa',
  'spi-sck': '#a78bfa',
  'spi-cs': '#a78bfa',
  'i2s-ws': '#f472b6',
  'i2s-bck': '#f472b6',
  'i2s-data-in': '#f472b6',
  'i2s-data-out': '#f472b6',
  'adc-in': '#34d399',
  probe: '#22d3ee',
  power: '#f87171',
  gnd: '#94a3b8',
};

export function pinRoleColor(role: PinRole): string {
  return ROLE_COLORS[role];
}
