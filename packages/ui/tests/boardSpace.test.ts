// 3D view step 1: the world -> board mapping is the contract every 3D component
// depends on (parts, pins, wires in later steps), and vitest runs in a node
// environment with no WebGL, so the pure mapping is pinned here rather than
// left to visual inspection.
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import {
  BOARD_THICKNESS,
  CAMERA_FOV,
  DEFAULT_CAMERA_ASPECT,
  MAX_CAMERA_DISTANCE,
  MIN_CAMERA_DISTANCE,
  boardCenter,
  boardPosition,
  defaultCameraDistance,
  defaultCameraPosition,
  footprintBox,
} from '../src/components/Breadboard3D/boardSpace';
import { MCU_NODE } from '../src/components/Breadboard/pinLayout';
import { WORLD_H, WORLD_W } from '../src/components/Breadboard/worldSize';

describe('boardSpace (3D world mapping)', () => {
  it('maps a world point onto the XZ plane with +Y up', () => {
    expect(boardPosition(120, 340)).toEqual([120, 0, 340]);
    expect(boardPosition(120, 340, 25)).toEqual([120, 25, 340]);
  });

  it('centres the board on half of the world extent', () => {
    expect(boardCenter()).toEqual([WORLD_W / 2, 0, WORLD_H / 2]);
  });

  it('starts the camera above the near edge and inside the orbit limits', () => {
    const cam = defaultCameraPosition();
    expect(cam[1]).toBeGreaterThan(0); // above the board surface
    expect(cam[2]).toBeGreaterThan(WORLD_H / 2); // on the viewer's side
    const distance = Math.hypot(cam[0] - WORLD_W / 2, cam[1], cam[2] - WORLD_H / 2);
    expect(distance).toBeGreaterThan(MIN_CAMERA_DISTANCE);
    expect(distance).toBeLessThan(MAX_CAMERA_DISTANCE);
  });

  // The regression this fit exists for: a fixed camera distance framed one
  // viewport shape and clipped the near corners on a narrower one (resizing the
  // window, or collapsing the dock, which makes the canvas taller).
  it('keeps the whole board inside the frustum on every canvas shape', () => {
    for (const aspect of [1.0, 1.2, 1.32, 1.56, 2.0, 2.6]) {
      const camera = new PerspectiveCamera(CAMERA_FOV, aspect, 1, 9000);
      camera.position.set(...defaultCameraPosition(aspect));
      camera.lookAt(new Vector3(...boardCenter()));
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      for (const [x, z] of [
        [0, 0],
        [WORLD_W, 0],
        [0, WORLD_H],
        [WORLD_W, WORLD_H],
      ]) {
        const ndc = new Vector3(x, 0, z).project(camera);
        expect(Math.abs(ndc.x), `x at aspect ${aspect}`).toBeLessThan(0.9);
        expect(Math.abs(ndc.y), `y at aspect ${aspect}`).toBeLessThan(0.9);
      }
    }
  });

  it('leaves the framing at the default window unchanged', () => {
    // 0.87 of the frustum reproduces the shipped framing at the default canvas
    // (731×469): the board keeps the margins the README screenshots show.
    const cam = defaultCameraPosition(DEFAULT_CAMERA_ASPECT);
    expect(cam[1]).toBeCloseTo(760, -1);
    // The old position sat at z = WORLD_H + 440, i.e. 720 beyond the centre.
    expect(cam[2] - WORLD_H / 2).toBeCloseTo(720, -1);
  });

  it('pulls back on a narrow canvas and moves in on a wide one', () => {
    const base = defaultCameraDistance(DEFAULT_CAMERA_ASPECT);
    expect(defaultCameraDistance(1.0)).toBeGreaterThan(base);
    expect(defaultCameraDistance(2.6)).toBeLessThan(base);
  });

  it('falls back to the default aspect for degenerate input', () => {
    const base = defaultCameraDistance(DEFAULT_CAMERA_ASPECT);
    expect(defaultCameraDistance(Number.NaN)).toBe(base);
    expect(defaultCameraDistance(0)).toBe(base);
    expect(defaultCameraDistance(-3)).toBe(base);
  });

  it('never places the camera beyond the orbit limit', () => {
    // An extremely narrow canvas asks for a distance the orbit limits forbid;
    // clamping there keeps the camera and the controls in agreement.
    expect(defaultCameraDistance(0.2)).toBeLessThanOrEqual(MAX_CAMERA_DISTANCE);
  });

  it('turns a footprint into a box centred on its own base', () => {
    const box = footprintBox({ x: 10, y: 20, w: 150, h: 70 }, 16);
    expect(box.size).toEqual([150, 16, 70]);
    // Half the height above the base: the box sits ON the board (y=0), not in it.
    expect(box.position).toEqual([10 + 75, 8, 20 + 35]);
  });

  it('honours a non-zero base for stacked parts', () => {
    const box = footprintBox({ x: 0, y: 0, w: 10, h: 10 }, 4, 12);
    expect(box.position[1]).toBe(14);
  });

  it('sinks the board slab by its thickness so the top surface is y = 0', () => {
    expect(BOARD_THICKNESS).toBeGreaterThan(0);
    expect(-BOARD_THICKNESS / 2).toBeLessThan(0);
  });

  it('places the MCU placeholder inside the board bounds', () => {
    const box = footprintBox(MCU_NODE, 16);
    const [x, , z] = box.position;
    expect(x).toBeGreaterThan(0);
    expect(z).toBeGreaterThan(0);
    expect(x).toBeLessThan(WORLD_W);
    expect(z).toBeLessThan(WORLD_H);
  });
});
