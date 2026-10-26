// Bridge between the DOM overlay and the WebGL scene (step 4).
//
// Drop/drag handlers live on the container <div> outside the canvas, but turning a
// client point into a board point needs the live camera and raycaster, which only
// exist inside the r3f tree (a separate React root — context does not cross that
// boundary). A module-level slot is the smallest honest link, and it mirrors the
// existing `window.__bb_drag_kind` scratch variable the palette already uses.
export interface BoardPoint {
  x: number;
  z: number;
}

export interface Canvas3DInputApi {
  /** Board-plane (y = 0) point under a client-space point, or null if the ray misses. */
  screenToBoard(clientX: number, clientY: number): BoardPoint | null;
  /**
   * World point in client pixels. Used by the pin picker: a pin often sits behind
   * its own part body (an LED's legs are under the dome), so picking must not
   * depend on what the ray hits first.
   */
  project(x: number, y: number, z: number): { x: number; y: number } | null;
  /**
   * Distance from the click ray to a world point. Pick tolerance must not compare a
   * board-plane point with a pin standing above it — the height offset alone is
   * ~3 world units at a typical camera tilt, which is the same order as a small
   * part's pin spacing. The true ray distance has no such bias.
   */
  rayDistance(clientX: number, clientY: number, x: number, y: number, z: number): number;
}

let api: Canvas3DInputApi | null = null;

/** Overwrite-only registration: last mounted canvas wins. */
export function setCanvas3DInput(next: Canvas3DInputApi | null): void {
  api = next;
}

/** Clear only if `current` is still the registered API (an outgoing canvas must not
 *  clobber the one a remounted canvas just installed). */
export function clearCanvas3DInput(current: Canvas3DInputApi): void {
  if (api === current) api = null;
}

export function canvas3DInput(): Canvas3DInputApi | null {
  return api;
}
