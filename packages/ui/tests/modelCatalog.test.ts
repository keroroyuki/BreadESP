// 3D view step 2: the catalogue is the contract between the peripheral registry
// and the model library. Pinning it here means a new peripheral kind without a
// decided 3D body fails the suite instead of silently shipping a generic blob.
import { describe, expect, it } from 'vitest';
import { listPeripherals, registerBuiltins } from '@breadesp/peripherals';
import { MODELLED_KINDS, modelKeyFor } from '../src/components/Breadboard3D/modelCatalog';

describe('3D model catalogue', () => {
  it('covers every built-in peripheral kind with a bespoke model', () => {
    registerBuiltins();
    const kinds = listPeripherals().map((f) => f.kind);
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) expect(modelKeyFor(kind), kind).not.toBe('generic');
  });

  it('falls back to the generic body for unknown kinds', () => {
    expect(modelKeyFor('third-party-module')).toBe('generic');
    expect(modelKeyFor('')).toBe('generic');
    // Kinds are lowercase kebab-case (registry contract), so casing is a miss.
    expect(modelKeyFor('LED')).toBe('generic');
  });

  it('maps every modelled kind to itself', () => {
    for (const kind of MODELLED_KINDS) expect(modelKeyFor(kind)).toBe(kind);
  });

  it('lists no duplicate kinds', () => {
    expect(new Set(MODELLED_KINDS).size).toBe(MODELLED_KINDS.length);
  });
});
