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

/** Vertical field of view of the 3D camera (degrees). Canvas3D passes the same
 *  value to <Canvas>, so the framing below and the renderer cannot drift apart. */
export const CAMERA_FOV = 45;

/** Aspect ratio (width / height) assumed before the canvas has been measured —
 *  r3f reports 0×0 on its first commit. Equals the canvas of the default
 *  1280×800 window (731×469). */
export const DEFAULT_CAMERA_ASPECT = 1.56;

/** Fraction of the frustum the board may fill; the rest is the margin that keeps
 *  the near corners off the viewport edge. 0.87 reproduces the framing the app
 *  shipped with at the default window, so existing screenshots stay valid. */
const FRAME_FILL = 0.87;

/** Camera elevation above the board plane (degrees): ~46.5° shows the surface as
 *  a surface seen from above rather than a wall, with headroom for nameplates. */
const CAMERA_ELEVATION_DEG = 46.5;

function elevationBasis(): { sin: number; cos: number } {
  const rad = (CAMERA_ELEVATION_DEG * Math.PI) / 180;
  return { sin: Math.sin(rad), cos: Math.cos(rad) };
}

/**
 * Distance from the board centre at which the whole board fits a canvas of
 * `aspect` (width / height).
 *
 * Perspective magnifies the near edge, so this is solved per corner instead of
 * from a bounding sphere (a sphere fit would pull back far more than needed).
 * A corner at offset (x, 0, z) from the board centre projects inside the frustum
 * when |x| ≤ tanH·(d − along) and |up| ≤ tanV·(d − along), where `along` is its
 * offset along the view ray and `up` its offset along the camera's up axis.
 * Solving for d and taking the maximum over the four corners yields the closest
 * camera that keeps the board whole.
 *
 * The old fixed distance was correct for one viewport shape only: narrowing the
 * window (or collapsing the dock, which makes the canvas taller) lowered the
 * aspect and pushed the near corners out of frame.
 */
export function defaultCameraDistance(aspect: number = DEFAULT_CAMERA_ASPECT): number {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_CAMERA_ASPECT;
  const tanV = Math.tan((CAMERA_FOV * Math.PI) / 360) * FRAME_FILL;
  const tanH = tanV * a;
  const { sin, cos } = elevationBasis();
  let distance = MIN_CAMERA_DISTANCE;
  for (const x of [0, WORLD_W]) {
    const dx = x - WORLD_W / 2;
    for (const z of [0, WORLD_H]) {
      const dz = z - WORLD_H / 2;
      const along = dz * cos;
      const up = -dz * sin;
      distance = Math.max(distance, along + Math.abs(dx) / tanH, along + Math.abs(up) / tanV);
    }
  }
  return Math.min(distance, MAX_CAMERA_DISTANCE);
}

/** Default camera: elevated above the viewer-side edge, framing the whole board
 *  for the canvas's current shape. */
export function defaultCameraPosition(
  aspect: number = DEFAULT_CAMERA_ASPECT,
): [number, number, number] {
  const distance = defaultCameraDistance(aspect);
  const { sin, cos } = elevationBasis();
  return [WORLD_W / 2, distance * sin, WORLD_H / 2 + distance * cos];
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
