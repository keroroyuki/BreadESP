// 3D view step 2: which peripheral kinds have a bespoke model.
//
// Pure data on purpose — the coverage contract is unit-tested in the node test
// environment (no WebGL), and it stays independent of the React components that
// pull three.js in. Adding a peripheral kind without a model does not break the
// app (it falls back to the generic body); the test tells the author to make that
// decision explicitly instead of silently shipping a grey blob.
export const MODELLED_KINDS = [
  'led',
  'button',
  'buzzer',
  'speaker',
  'ssd1306',
  'st7789',
  'oscilloscope',
  'mic',
  'knob',
  'sht30',
] as const;

export type ModelledKind = (typeof MODELLED_KINDS)[number];

/** 'generic' is the fallback body used for kinds without a bespoke model. */
export type ModelKey = ModelledKind | 'generic';

/** Model key for a kind: its own when modelled, otherwise the generic fallback. */
export function modelKeyFor(kind: string): ModelKey {
  return (MODELLED_KINDS as readonly string[]).includes(kind) ? (kind as ModelledKind) : 'generic';
}
