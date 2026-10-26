// Step 4: 3D wiring goes through a store because both the in-scene pin hit areas
// and the canvas-level keyboard/background handlers drive it. These tests pin the
// behaviour the 2D canvas already had: two picks make a wire, a repeat cancels,
// and illegal/duplicate attempts never touch the netlist.
import { beforeEach, describe, expect, it } from 'vitest';
import { MCU_INSTANCE_ID, type WireEndpoint } from '@breadesp/netlist';
import { useProjectStore } from '../src/store/projectStore';
import { useWiring3DStore } from '../src/store/wiring3dStore';

const mcu = (pin: string): WireEndpoint => ({ instanceId: MCU_INSTANCE_ID, pin });
const part = (instanceId: string, pin: string): WireEndpoint => ({ instanceId, pin });

const wires = (): number => useProjectStore.getState().netlist.wires.length;

describe('3D wiring store', () => {
  beforeEach(() => {
    useProjectStore.getState().resetProject(null);
    useWiring3DStore.getState().cancel();
  });

  it('starts on the first pick and creates the wire on the second', () => {
    useWiring3DStore.getState().pickPin(part('led-1', 'A'));
    expect(useWiring3DStore.getState().pending).toEqual(part('led-1', 'A'));
    expect(wires()).toBe(0);

    useWiring3DStore.getState().pickPin(mcu('GPIO2'));
    expect(useWiring3DStore.getState().pending).toBeNull();
    expect(wires()).toBe(1);
    expect(useProjectStore.getState().netlist.wires[0]).toMatchObject({
      from: part('led-1', 'A'),
      to: mcu('GPIO2'),
    });
  });

  it('cancels the pending wire when the same pin is picked twice', () => {
    useWiring3DStore.getState().pickPin(part('led-1', 'A'));
    useWiring3DStore.getState().pickPin(part('led-1', 'A'));
    expect(useWiring3DStore.getState().pending).toBeNull();
    expect(wires()).toBe(0);
  });

  it('refuses peripheral → peripheral wiring', () => {
    useWiring3DStore.getState().pickPin(part('led-1', 'A'));
    useWiring3DStore.getState().pickPin(part('button-1', '1'));
    expect(useWiring3DStore.getState().pending).toBeNull();
    expect(wires()).toBe(0);
  });

  it('never adds a duplicate wire', () => {
    useWiring3DStore.getState().pickPin(part('led-1', 'A'));
    useWiring3DStore.getState().pickPin(mcu('GPIO2'));
    useWiring3DStore.getState().pickPin(part('led-1', 'A'));
    useWiring3DStore.getState().pickPin(mcu('GPIO2'));
    expect(wires()).toBe(1);
  });

  it('tracks and clears the rubber-band end', () => {
    useWiring3DStore.getState().setHover({ x: 10, z: 20 });
    expect(useWiring3DStore.getState().hover).toEqual({ x: 10, z: 20 });
    useWiring3DStore.getState().cancel();
    expect(useWiring3DStore.getState().hover).toBeNull();
  });
});
