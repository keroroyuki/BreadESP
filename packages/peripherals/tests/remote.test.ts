// PRD: §6.2, §F-EXT-3 — Remote (catalog-loaded) factory mirroring and the
// loader rollback primitive (dev-plan P5.2). The renderer mirrors Bridge-side
// catalog kinds as metadata-only stubs so the palette/canvas can render them;
// the Bridge loader uses unregisterPeripheral to roll back failed loads.
// The module-level registry is shared within this file (vitest isolates
// module state per test file), so registrations accumulate here.
import { describe, expect, it } from 'vitest';
import {
  getFactory,
  listPeripherals,
  registerRemotePeripheral,
  unregisterPeripheral,
  type PeripheralMeta,
} from '../src/index';

function remoteMeta(overrides: Partial<PeripheralMeta> = {}): PeripheralMeta {
  return {
    kind: 'acme-matrix',
    version: '0.3.1',
    displayName: 'Acme LED Matrix',
    pins: [
      { id: 'DIN', role: 'spi-mosi' },
      { id: 'CS', role: 'spi-cs' },
      { id: 'CLK', role: 'spi-sck' },
    ],
    ...overrides,
  };
}

describe('registerRemotePeripheral — renderer mirror (P5.2, PRD §F-EXT-3)', () => {
  it('registers a metadata-only stub resolvable by kind with pins intact', () => {
    registerRemotePeripheral(remoteMeta());
    const f = getFactory('acme-matrix');
    expect(f).toBeDefined();
    expect(f?.displayName).toBe('Acme LED Matrix');
    expect(f?.version).toBe('0.3.1');
    expect(f?.pins.map((p) => p.id)).toEqual(['DIN', 'CS', 'CLK']);
    expect(listPeripherals().map((x) => x.kind)).toContain('acme-matrix');
  });

  it('stub create() throws a coded [BB-207] tripwire (models are Bridge-only)', () => {
    const f = getFactory('acme-matrix');
    expect(f).toBeDefined();
    expect(() =>
      f?.create({
        emitSnapshot: () => {},
        log: () => {},
        onTick: () => () => {},
      }),
    ).toThrow(/\[BB-207\] peripheral kind 'acme-matrix'.*Bridge process/);
  });

  it('re-runs the full registration gates on the metadata', () => {
    // Malformed kind -> [BB-220]; duplicate kind -> [BB-221]; newer SDK major -> [BB-222].
    expect(() => registerRemotePeripheral(remoteMeta({ kind: 'Bad Kind' }))).toThrow('[BB-220]');
    expect(() => registerRemotePeripheral(remoteMeta())).toThrow("[BB-221] peripheral kind 'acme-matrix' is already registered");
    expect(() => registerRemotePeripheral(remoteMeta({ kind: 'acme-newer', sdkVersion: '99.0.0' }))).toThrow('[BB-222]');
    expect(getFactory('acme-newer')).toBeUndefined();
  });
});

describe('unregisterPeripheral — loader rollback primitive (P5.2)', () => {
  it('removes a registered kind and reports the removal', () => {
    registerRemotePeripheral(remoteMeta({ kind: 'acme-temp' }));
    expect(getFactory('acme-temp')).toBeDefined();
    expect(unregisterPeripheral('acme-temp')).toBe(true);
    expect(getFactory('acme-temp')).toBeUndefined();
    // The kind can be registered again afterwards (rollback leaves no residue).
    expect(() => registerRemotePeripheral(remoteMeta({ kind: 'acme-temp' }))).not.toThrow();
    expect(getFactory('acme-temp')).toBeDefined();
  });

  it('returns false for a kind that was never registered', () => {
    expect(unregisterPeripheral('acme-missing')).toBe(false);
  });
});
