// 3D view (step 1): the single place that maps the 2D world coordinates used
// by layout.json (x/y over WORLD_W × WORLD_H, y growing "down" on screen) onto
// the 3D board. The board lies on the XZ plane with +Y up, so a world point
// (x, y) becomes (x, height, y) — an affine, lossless mapping. That is what
// keeps the 3D view a pure view: the persisted project format never changes
// (PRD §F-BB-4 logic/visual separation), and a project saved in 2D opens in 3D
// unchanged and vice versa.
//
// Pure functions only. vitest runs in a node environment with no WebGL, so the
// geometry later steps share (part footprints, pin anchors, wire routing) has
// to be verifiable without rendering anything.
import { WORLD_H, WORLD_W } from '../Breadboard/worldSize';

/** Board slab thickness in world units (visual only — never persisted). */
export const BOARD_THICKNESS = 14;

/** A point on the board plane, `height` world units above its top surface. */
export function boardPosition(x: number, y: number, height = 0): [number, number, number] {
  return [x, height, y];
}

/** Board centre — the default orbit target and the scene's anchor point. */
export function boardCenter(): [number, number, number] {
  return [WORLD_W / 2, 0, WORLD_H / 2];
}

/** Default camera: elevated above the viewer-side edge, looking at the board. */
export function defaultCameraPosition(): [number, number, number] {
  return [WORLD_W / 2, 560, WORLD_H + 430];
}

/** Orbit distance limits (world units) — close enough to inspect a part,
 *  far enough to frame the whole board without clipping the camera far plane. */
export const MIN_CAMERA_DISTANCE = 160;
export const MAX_CAMERA_DISTANCE = 2600;

export interface Box3D {
  position: [number, number, number];
  size: [number, number, number];
}

/** A rectangle on the board plane (world x/y + w/h), e.g. MCU_NODE or a node box. */
export interface Footprint {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A footprint as a box of `height` sitting on `base`, centred on its own
 * footprint so callers position a part from its layout rectangle alone — the
 * same rectangle the 2D canvas draws, which is what keeps pin anchors aligned
 * between the two views.
 */
export function footprintBox(rect: Footprint, height: number, base = 0): Box3D {
  return {
    position: [rect.x + rect.w / 2, base + height / 2, rect.y + rect.h / 2],
    size: [rect.w, height, rect.h],
  };
}
