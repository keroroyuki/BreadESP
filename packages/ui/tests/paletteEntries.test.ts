// PRD: §F-BB-2, §F-EXT-1 — Registry-driven palette (dev-plan P5.1). The M5
// acceptance: a third-party package that calls registerPeripheral() appears
// in the palette automatically, with no UI-side code change.
import { describe, expect, it } from 'vitest';
import { registerPeripheral, type Peripheral, type PeripheralFactory } from '@breadesp/peripherals';
import { paletteEntries, paletteEntriesFrom } from '../src/components/Palette/paletteEntries';

function thirdPartyFactory(): PeripheralFactory {
  return {
    kind: 'acme-servo',
    version: '2.1.0',
    displayName: 'Acme Servo',
    pins: [{ id: 'SIG', role: 'pwm-in' }],
    create(_ctx, props): Peripheral {
      return {
        kind: 'acme-servo',
        instanceId: String(props?.instanceId ?? 'x'),
        onTransaction(): void {},
      };
    },
  };
}

describe('paletteEntriesFrom — pure mapping', () => {
  it('maps kind/displayName/version and preserves registration order', () => {
    const entries = paletteEntriesFrom([
      { kind: 'a-one', version: '1.0.0', displayName: 'A One', pins: [], create: () => { throw new Error('unused'); } },
      { kind: 'b-two', version: '0.2.0', displayName: 'B Two', pins: [], create: () => { throw new Error('unused'); } },
    ]);
    expect(entries).toEqual([
      { kind: 'a-one', label: 'A One', version: '1.0.0' },
      { kind: 'b-two', label: 'B Two', version: '0.2.0' },
    ]);
  });

  it('returns an empty list for an empty registry snapshot', () => {
    expect(paletteEntriesFrom([])).toEqual([]);
  });
});

describe('paletteEntries — live registry (PRD §F-EXT-1)', () => {
  it('lists the built-in set with display names and semver versions', () => {
    const entries = paletteEntries();
    const byKind = new Map(entries.map((e) => [e.kind, e]));
    for (const kind of ['led', 'button', 'ssd1306', 'st7789', 'buzzer', 'speaker', 'oscilloscope', 'mic', 'knob', 'sht30']) {
      expect(byKind.has(kind), kind).toBe(true);
      expect(byKind.get(kind)?.label.length).toBeGreaterThan(0);
      expect(byKind.get(kind)?.version).toMatch(/^\d+\.\d+\.\d+/);
    }
    // Palette shows the factory's displayName, not the kind id.
    expect(byKind.get('ssd1306')?.label).toBe('SSD1306 OLED 128x64');
  });

  it('M5 acceptance: a third-party registerPeripheral() appears automatically', () => {
    registerPeripheral(thirdPartyFactory());
    const entry = paletteEntries().find((e) => e.kind === 'acme-servo');
    expect(entry).toEqual({ kind: 'acme-servo', label: 'Acme Servo', version: '2.1.0' });
  });
});
