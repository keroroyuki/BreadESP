// Wiring rules shared by the 2D canvas and the 3D view (step 4).
//
// The two views have completely different input stacks (Konva hit graph vs. WebGL
// raycasting) but must behave identically: clicking a pin starts a wire, clicking
// the same pin again cancels, peripheral→peripheral is refused, and a duplicate
// never lands in the netlist. Keeping that decision here means a rule change can
// never apply to one view only.
import { MCU_INSTANCE_ID, type WireEndpoint } from '@breadesp/netlist';

export type WiringOutcome =
  /** No wire in progress: start one from this pin. */
  | { kind: 'start' }
  /** The same pin was clicked twice: abort the pending wire. */
  | { kind: 'cancel' }
  /** Neither end is the MCU: the bridge cannot route peripheral→peripheral. */
  | { kind: 'not-routable' }
  /** A wire between these two pins should be created (the caller still checks duplicates). */
  | { kind: 'wire'; from: WireEndpoint; to: WireEndpoint };

/** Pure: what a pin click means, given the endpoint that started the wire (or null). */
export function advanceWiring(pending: WireEndpoint | null, next: WireEndpoint): WiringOutcome {
  if (pending === null) return { kind: 'start' };
  if (pending.instanceId === next.instanceId && pending.pin === next.pin) return { kind: 'cancel' };
  if (pending.instanceId !== MCU_INSTANCE_ID && next.instanceId !== MCU_INSTANCE_ID) {
    return { kind: 'not-routable' };
  }
  return { kind: 'wire', from: pending, to: next };
}
