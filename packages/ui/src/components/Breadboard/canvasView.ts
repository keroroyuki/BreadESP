// Canvas viewport math (T2.1) — pure functions, single source of truth for
// the two coordinate systems used by the Konva Stage:
//   world     — layout.json coordinates (MCU node, peripheral x/y, wire anchors)
//   container — Stage-local pixels (what getPointerPosition()/drop report)
// The Stage transform maps world -> container as `p*scale + view.xy`, so
// container -> world is `(p - view.xy) / scale`. Every zoom/pan/drop site in
// BreadboardCanvas goes through these helpers — no ad-hoc math that can drift.
import { WORLD_W, WORLD_H } from './worldSize';

export const SCALE_MIN = 0.25;
export const SCALE_MAX = 3;

/** Stage transform: world origin offset (container px) + zoom factor. */
export interface View {
  scale: number;
  x: number;
  y: number;
}

export interface Pt {
  x: number;
  y: number;
}

export const IDENTITY_VIEW: View = { scale: 1, x: 0, y: 0 };

export function clampScale(scale: number): number {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale));
}

export function containerToWorld(view: View, p: Pt): Pt {
  return { x: (p.x - view.x) / view.scale, y: (p.y - view.y) / view.scale };
}

export function worldToContainer(view: View, p: Pt): Pt {
  return { x: p.x * view.scale + view.x, y: p.y * view.scale + view.y };
}

/**
 * Zoom by `factor` keeping the world point under `pointer` (container px)
 * fixed. When the clamped scale saturates, the offset still follows the
 * pointer so the motion direction never inverts.
 */
export function zoomAtPoint(view: View, pointer: Pt, factor: number): View {
  const scale = clampScale(view.scale * factor);
  const world = containerToWorld(view, pointer);
  return { scale, x: pointer.x - world.x * scale, y: pointer.y - world.y * scale };
}

/** Snap a world coordinate to the nearest grid multiple (`+0` normalizes -0). */
export function snapToGrid(v: number, grid = GRID): number {
  return Math.round(v / grid) * grid + 0;
}

/** Grid pitch (world px) for the fine grid; the coarse grid is GRID_MAJOR. */
export const GRID = 10;
export const GRID_MAJOR = 50;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GridLines {
  fine: Segment[];
  major: Segment[];
}

/**
 * Grid segments restricted to the visible world rect: only lines that cross
 * `rect` are returned, so the canvas never draws thousands of off-screen
 * lines at low zoom. Multiples of GRID_MAJOR go to `major` (drawn thicker);
 * other GRID multiples to `fine`.
 */
export function gridSegments(rect: Rect, small = GRID, major = GRID_MAJOR): GridLines {
  const fine: Segment[] = [];
  const majorLines: Segment[] = [];
  const isMajor = (v: number): boolean => Math.abs(v % major) < 1e-9;

  const vStart = Math.ceil(rect.x / small) * small;
  for (let x = vStart; x <= rect.x + rect.w + 1e-9; x += small) {
    const seg = { x1: x, y1: rect.y, x2: x, y2: rect.y + rect.h };
    (isMajor(x) ? majorLines : fine).push(seg);
  }
  const hStart = Math.ceil(rect.y / small) * small;
  for (let y = hStart; y <= rect.y + rect.h + 1e-9; y += small) {
    const seg = { x1: rect.x, y1: y, x2: rect.x + rect.w, y2: y };
    (isMajor(y) ? majorLines : fine).push(seg);
  }
  return { fine, major: majorLines };
}

/**
 * Drop/snap placement: snap to grid, then clamp into the world bounds so a
 * node dropped near an edge stays fully on the board. A node larger than the
 * world clamps to the origin rather than to a negative bound.
 */
export function snappedPlacement(x: number, y: number, nodeW: number, nodeH: number): Pt {
  const maxX = Math.max(0, WORLD_W - nodeW);
  const maxY = Math.max(0, WORLD_H - nodeH);
  return {
    x: Math.min(maxX, Math.max(0, snapToGrid(x))),
    y: Math.min(maxY, Math.max(0, snapToGrid(y))),
  };
}

/** Visible world rect for a container of `size` px under `view`. */
export function visibleWorldRect(view: View, size: { w: number; h: number }): Rect {
  const tl = containerToWorld(view, { x: 0, y: 0 });
  const br = containerToWorld(view, { x: size.w, y: size.h });
  return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
}
