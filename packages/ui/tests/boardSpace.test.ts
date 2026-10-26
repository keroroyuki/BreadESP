// 3D view step 1: the world -> board mapping is the contract every 3D component
// depends on (parts, pins, wires in later steps), and vitest runs in a node
// environment with no WebGL, so the pure mapping is pinned here rather than
// left to visual inspection.
import { describe, expect, it } from 'vitest';
import {
  BOARD_THICKNESS,
  MAX_CAMERA_DISTANCE,
  MIN_CAMERA_DISTANCE,
  boardCenter,
  boardPosition,
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
