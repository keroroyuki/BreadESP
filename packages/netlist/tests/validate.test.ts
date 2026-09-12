// PRD: §6.5, §F-BB-4 — Unit tests for netlist + layout validation.
import { describe, expect, it } from 'vitest';
import { validateLayout, validateNetlist } from '../src/validate';
import type { LayoutFile, Netlist } from '../src/types';

const validNetlist: Netlist = {
  version: 1,
  chip: 'esp32',
  peripherals: [{ instanceId: 'led1', kind: 'led' }],
  wires: [
    { id: 'w1', from: { instanceId: 'mcu', pin: 'GPIO2' }, to: { instanceId: 'led1', pin: '1' } },
  ],
};

describe('validateNetlist', () => {
  it('accepts a valid netlist with mcu and one peripheral', () => {
    const res = validateNetlist(validNetlist);
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
  });

  it('accepts every schema chip kind incl. esp32c6 (dev-plan P4.1)', () => {
    for (const chip of ['esp32', 'esp32s3', 'esp32c3', 'esp32c6'] as const) {
      const res = validateNetlist({ ...validNetlist, chip });
      expect(res.ok).toBe(true);
    }
  });

  it('rejects a duplicate peripheral instanceId', () => {
    const res = validateNetlist({
      ...validNetlist,
      peripherals: [
        { instanceId: 'led1', kind: 'led' },
        { instanceId: 'led1', kind: 'button' },
      ],
    });
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.level === 'error' && i.message.includes('Duplicate peripheral instanceId: led1'))).toBe(true);
  });

  it('rejects wires referencing an unknown instance', () => {
    const res = validateNetlist({
      ...validNetlist,
      wires: [{ id: 'w1', from: { instanceId: 'mcu', pin: 'GPIO2' }, to: { instanceId: 'ghost', pin: '1' } }],
    });
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.message.includes('unknown instance ghost'))).toBe(true);
  });

  it('rejects input violating the schema (bad chip)', () => {
    const res = validateNetlist({ ...validNetlist, chip: 'esp8266' });
    expect(res.ok).toBe(false);
    expect(res.issues.length).toBeGreaterThan(0);
  });
});

const validLayout: LayoutFile = {
  version: 1,
  items: [{ instanceId: 'led1', x: 10, y: 20, kind: 'led' }],
};

describe('validateLayout', () => {
  it('accepts a valid layout file', () => {
    const res = validateLayout(validLayout);
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
  });

  it('rejects an unknown version', () => {
    const res = validateLayout({ ...validLayout, version: 2 as unknown as 1 });
    expect(res.ok).toBe(false);
    expect(res.issues.length).toBeGreaterThan(0);
  });

  it('rejects non-numeric / non-finite coordinates', () => {
    const badX = validateLayout({ version: 1, items: [{ ...validLayout.items[0], x: '10' as unknown as number }] });
    expect(badX.ok).toBe(false);
    const nanY = validateLayout({ version: 1, items: [{ ...validLayout.items[0], y: Number.NaN }] });
    expect(nanY.ok).toBe(false);
  });

  it('rejects a duplicate layout instanceId', () => {
    const res = validateLayout({
      version: 1,
      items: [
        { instanceId: 'led1', x: 0, y: 0, kind: 'led' },
        { instanceId: 'led1', x: 5, y: 5, kind: 'led' },
      ],
    });
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.message.includes('Duplicate layout instanceId: led1'))).toBe(true);
  });

  it('rejects non-object input without throwing', () => {
    expect(validateLayout(null).ok).toBe(false);
    expect(validateLayout('nope').ok).toBe(false);
  });
});
