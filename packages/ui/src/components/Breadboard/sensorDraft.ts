// PRD: §F-BB-3 — SHT30 canvas-node editing logic (dev-plan task P3.4).
// Pure functions: the node's +/- buttons adjust the reading by fixed steps,
// and all normalization/clamping is delegated to the model's own
// sht30ConfigFromProps/SHT30_LIMITS (single source of truth — the UI never
// offers a value the model would reject). The returned patch merges into the
// instance's netlist props via projectStore.updatePeripheralProps; the netlist
// identity change re-fires bb:applyNetlist, rebuilding the sensor in place.
import { sht30ConfigFromProps, SHT30_LIMITS } from '@breadesp/peripherals';

/** Per-click adjustment steps: ±1 °C, ±5 %RH. */
export const SHT30_STEP = { temperatureC: 1, humidityRh: 5 } as const;

export type Sht30Field = keyof typeof SHT30_STEP;

/**
 * Compute the props patch for one adjustment click. The result is clamped to
 * the model's limits, so holding a button saturates instead of overflowing.
 */
export function adjustSht30(
  props: Record<string, unknown> | undefined,
  field: Sht30Field,
  direction: 1 | -1,
): Record<string, unknown> {
  const cfg = sht30ConfigFromProps(props);
  const next = cfg[field] + direction * SHT30_STEP[field];
  const clamped = Math.min(SHT30_LIMITS[field].max, Math.max(SHT30_LIMITS[field].min, next));
  return { [field]: clamped };
}
