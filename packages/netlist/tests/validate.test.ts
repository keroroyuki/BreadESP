// PRD: §6.5 — Unit tests for netlist validation (structural + semantic).
import { describe, expect, it } from 'vitest';
import { validateNetlist } from '../src/validate';
import type { Netlist } from '../src/types';

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
