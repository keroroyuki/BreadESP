// Canvas viewport math: zoom-anchor invariants, coordinate round-trips,
// grid snapping/clamping and viewport-clipped grid line generation (T2.1).
import { describe, expect, it } from 'vitest';
import {
  GRID,
  GRID_MAJOR,
  IDENTITY_VIEW,
  SCALE_MAX,
  SCALE_MIN,
  clampScale,
  containerToWorld,
  gridSegments,
  snappedPlacement,
  snapToGrid,
  visibleWorldRect,
  worldToContainer,
  zoomAtPoint,
  type View,
} from '../src/components/Breadboard/canvasView';
import { WORLD_H, WORLD_W } from '../src/components/Breadboard/worldSize';

const view = (scale: number, x: number, y: number): View => ({ scale, x, y });

describe('clampScale', () => {
  it('clamps to [0.25, 3]', () => {
    expect(clampScale(0.01)).toBe(SCALE_MIN);
    expect(clampScale(99)).toBe(SCALE_MAX);
    expect(clampScale(1)).toBe(1);
    expect(clampScale(0.5)).toBe(0.5);
  });
});

describe('coordinate transforms', () => {
  it('containerToWorld and worldToContainer are inverses', () => {
    const v = view(1.7, 120, -40);
    const p = { x: 333, y: 91 };
    const world = containerToWorld(v, p);
    expect(worldToContainer(v, world)).toEqual(p);
  });

  it('identity view maps world coordinates straight through', () => {
    expect(containerToWorld(IDENTITY_VIEW, { x: 5, y: 7 })).toEqual({ x: 5, y: 7 });
  });

  it('a panned view shifts world origin by the offset', () => {
    const v = view(1, 100, 50);
    expect(containerToWorld(v, { x: 0, y: 0 })).toEqual({ x: -100, y: -50 });
    expect(worldToContainer(v, { x: 0, y: 0 })).toEqual({ x: 100, y: 50 });
  });
});

describe('zoomAtPoint', () => {
  it('keeps the world point under the pointer fixed (invariant)', () => {
    const v = view(1.2, 60, -15);
    const pointer = { x: 400, y: 210 };
    const before = containerToWorld(v, pointer);
    const next = zoomAtPoint(v, pointer, 1.25);
    expect(containerToWorld(next, pointer)).toEqual(before);
  });

  it('holds the invariant across a chain of zooms (within float epsilon)', () => {
    let v: View = view(0.6, -30, 88);
    const pointer = { x: 512, y: 128 };
    const target = containerToWorld(v, pointer);
    for (const f of [1.1, 0.9, 1.5, 0.5, 1.2]) v = zoomAtPoint(v, pointer, f);
    const after = containerToWorld(v, pointer);
    expect(after.x).toBeCloseTo(target.x, 9);
    expect(after.y).toBeCloseTo(target.y, 9);
  });

  it('saturates at the scale bounds instead of overshooting', () => {
    const v = view(SCALE_MAX, 0, 0);
    const next = zoomAtPoint(v, { x: 100, y: 100 }, 2);
    expect(next.scale).toBe(SCALE_MAX);
    const prev = zoomAtPoint(view(SCALE_MIN, 0, 0), { x: 100, y: 100 }, 0.5);
    expect(prev.scale).toBe(SCALE_MIN);
  });

  it('zooming keeps the world point under the pointer fixed', () => {
    // At identity the world point under (200, 300) IS (200, 300); after 2x
    // zoom the origin moves to (-200, -300) so that point stays put.
    const pointer = { x: 200, y: 300 };
    const next = zoomAtPoint(IDENTITY_VIEW, pointer, 2);
    expect(next).toEqual({ scale: 2, x: -200, y: -300 });
    expect(containerToWorld(next, pointer)).toEqual(pointer);
  });
});

describe('snapToGrid', () => {
  it('rounds to the nearest multiple', () => {
    expect(snapToGrid(4)).toBe(0);
    expect(snapToGrid(5)).toBe(GRID);
    expect(snapToGrid(14)).toBe(GRID);
    expect(snapToGrid(15)).toBe(2 * GRID);
    expect(snapToGrid(-4)).toBe(0);
  });

  it('supports a custom grid pitch', () => {
    expect(snapToGrid(24, 25)).toBe(25);
    expect(snapToGrid(49, GRID_MAJOR)).toBe(GRID_MAJOR);
  });
});

describe('snappedPlacement', () => {
  it('snaps and stays inside the world bounds', () => {
    expect(snappedPlacement(34, 67, 150, 70)).toEqual({ x: 30, y: 70 });
  });

  it('clamps coordinates that would push the node off the board', () => {
    expect(snappedPlacement(WORLD_W - 10, WORLD_H - 10, 150, 70)).toEqual({
      x: WORLD_W - 150,
      y: WORLD_H - 70,
    });
    expect(snappedPlacement(-500, -500, 150, 70)).toEqual({ x: 0, y: 0 });
  });

  it('never exceeds the world even when the node is larger than the world', () => {
    // Degrades gracefully: the bound clamps at 0 instead of going negative.
    const p = snappedPlacement(0, 0, WORLD_W + 50, WORLD_H + 50);
    expect(p.x).toBe(0);
    expect(p.y).toBe(0);
  });
});

describe('gridSegments', () => {
  const rect = { x: 0, y: 0, w: 120, h: 80 };

  it('returns only lines inside the visible rect', () => {
    const { fine, major } = gridSegments(rect);
    const xs = fine.map((s) => s.x1).concat(major.map((s) => s.x1));
    for (const x of xs) expect(x).toBeGreaterThanOrEqual(0), expect(x).toBeLessThanOrEqual(120);
  });

  it('multiples of the major pitch land in `major`, others in `fine`', () => {
    const { fine, major } = gridSegments(rect);
    expect(major.map((s) => s.x1)).toContain(GRID_MAJOR);
    expect(fine.map((s) => s.x1)).toContain(GRID);
    expect(fine.map((s) => s.x1)).not.toContain(GRID_MAJOR);
  });

  it('lines span the full visible rect', () => {
    const { fine } = gridSegments(rect);
    const v = fine.find((s) => s.x1 === GRID)!;
    expect(v.y1).toBe(0);
    expect(v.y2).toBe(80);
    const h = fine.find((s) => s.y1 === GRID)!;
    expect(h.x1).toBe(0);
    expect(h.x2).toBe(120);
  });

  it('handles rects that do not start at the origin (panned view)', () => {
    const shifted = { x: 47.3, y: -12.8, w: 100, h: 60 };
    const { fine, major } = gridSegments(shifted);
    // Vertical lines only (x1 === x2): the first is the first grid multiple >= 47.3 -> 50.
    const verticalXs = fine
      .concat(major)
      .filter((s) => s.x1 === s.x2)
      .map((s) => s.x1)
      .sort((a, b) => a - b);
    expect(verticalXs[0]).toBe(50);
  });

  it('an empty rect only yields the origin lines (which are major)', () => {
    const { fine, major } = gridSegments({ x: 0, y: 0, w: 0, h: 0 });
    expect(fine).toEqual([]);
    expect(major).toHaveLength(2); // x=0 and y=0, both multiples of GRID_MAJOR
  });
});

describe('visibleWorldRect', () => {
  it('covers the whole world at identity with a matching container', () => {
    const r = visibleWorldRect(IDENTITY_VIEW, { w: WORLD_W, h: WORLD_H });
    expect(r).toEqual({ x: 0, y: 0, w: WORLD_W, h: WORLD_H });
  });

  it('shrinks and shifts under zoom + pan', () => {
    const r = visibleWorldRect(view(2, 100, 50), { w: 300, h: 200 });
    expect(r).toEqual({ x: -50, y: -25, w: 150, h: 100 });
  });
});
