// 3D wiring step 3: the pin anchors are what wires attach to, and they are derived
// from the same factory pin lists the 2D canvas uses. These tests pin the contract
// that keeps the two views honest: same pins, same ids, one anchor each, centred on
// the node, and MCU anchors identical to mcuPinLayout.
import { describe, expect, it } from 'vitest';
import { PIN_ROLES } from '@breadesp/peripherals';
import { listPeripherals, registerBuiltins } from '@breadesp/peripherals';
import { MCU_GPIO_PINS, mcuPinLayout, peripheralPins } from '../src/components/Breadboard/pinLayout';
import {
  MCU_PIN_Y,
  PIN_ROWS_3D,
  mcuPinAnchor,
  mcuPinAnchors,
  partPinAnchors,
  pinRoleColor,
} from '../src/components/Breadboard3D/wiring/pinRows3d';
import { modelKeyFor } from '../src/components/Breadboard3D/modelCatalog';

describe('3D pin anchors', () => {
  it('gives every built-in kind exactly one anchor per factory pin, same ids', () => {
    registerBuiltins();
    for (const factory of listPeripherals()) {
      const pins = peripheralPins(factory.kind);
      const anchors = partPinAnchors(factory.kind, 100, 100);
      expect(anchors.map((a) => a.pin), factory.kind).toEqual(pins.map((p) => p.id));
      expect(anchors.map((a) => a.role), factory.kind).toEqual(pins.map((p) => p.role));
    }
  });

  it('centres the pin row on the node centre', () => {
    for (const factory of listPeripherals()) {
      const anchors = partPinAnchors(factory.kind, 200, 140);
      if (anchors.length === 0) continue;
      const meanX = anchors.reduce((sum, a) => sum + a.position[0], 0) / anchors.length;
      expect(meanX, factory.kind).toBeCloseTo(200, 6);
    }
  });

  it('places the row at the model row height and depth', () => {
    // ESP32-style check on one kind with a known row, plus the general formula.
    const [a] = partPinAnchors('ssd1306', 50, 60);
    const row = PIN_ROWS_3D[modelKeyFor('ssd1306')];
    expect(a.position[1]).toBeCloseTo(row.base + row.length, 6);
    expect(a.position[2]).toBeCloseTo(60 + row.z, 6);
  });

  it('spaces adjacent pins by the row spacing', () => {
    const anchors = partPinAnchors('st7789', 0, 0);
    const row = PIN_ROWS_3D.st7789;
    for (let i = 1; i < anchors.length; i += 1) {
      expect(anchors[i].position[0] - anchors[i - 1].position[0]).toBeCloseTo(row.spacing, 6);
    }
  });

  it('keeps every anchor inside the board world bounds', () => {
    for (const factory of listPeripherals()) {
      for (const a of partPinAnchors(factory.kind, 480, 280)) {
        expect(a.position[0]).toBeGreaterThan(-500);
        expect(a.position[0]).toBeLessThan(1500);
        expect(a.position[2]).toBeGreaterThan(-500);
        expect(a.position[2]).toBeLessThan(1100);
      }
    }
  });

  it('mirrors mcuPinLayout exactly for every GPIO pin', () => {
    const anchors = mcuPinAnchors();
    expect(anchors.map((a) => a.pin)).toEqual(MCU_GPIO_PINS.map((n) => `GPIO${n}`));
    for (const a of anchors) {
      const layout = mcuPinLayout(a.pin);
      expect(layout).not.toBeNull();
      expect(a.position[0]).toBeCloseTo(layout!.anchor.x, 6);
      expect(a.position[1]).toBe(MCU_PIN_Y);
      expect(a.position[2]).toBeCloseTo(layout!.anchor.y, 6);
    }
  });

  it('returns null for a non-GPIO MCU pin', () => {
    expect(mcuPinAnchor('GPIO6')).toBeNull(); // flash pin, not broken out
  });

  it('defines a colour for every pin role in the SDK', () => {
    for (const role of PIN_ROLES) {
      expect(pinRoleColor(role), role).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
