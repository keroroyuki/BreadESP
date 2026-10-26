// Step 4: the shared wiring rules must behave exactly like the 2D canvas always
// did, because both views now route pin clicks through this function.
import { describe, expect, it } from 'vitest';
import { MCU_INSTANCE_ID, type WireEndpoint } from '@breadesp/netlist';
import { advanceWiring } from '../src/components/Breadboard/wiringFlow';

const mcu = (pin: string): WireEndpoint => ({ instanceId: MCU_INSTANCE_ID, pin });
const part = (instanceId: string, pin: string): WireEndpoint => ({ instanceId, pin });

describe('advanceWiring (shared 2D/3D wiring rules)', () => {
  it('starts a wire when nothing is pending', () => {
    expect(advanceWiring(null, part('led-1', 'A'))).toEqual({ kind: 'start' });
  });

  it('cancels when the same pin is clicked twice', () => {
    expect(advanceWiring(part('led-1', 'A'), part('led-1', 'A'))).toEqual({ kind: 'cancel' });
  });

  it('compares pin ids, not just the instance, when deciding to cancel', () => {
    // Same instance (the MCU), different pins: this is a real wire request.
    expect(advanceWiring(mcu('GPIO2'), mcu('GPIO4'))).toEqual({
      kind: 'wire',
      from: mcu('GPIO2'),
      to: mcu('GPIO4'),
    });
    // Same instance (a peripheral), different pins: still refused, because neither
    // end is the MCU — the bridge only routes MCU ↔ peripheral.
    expect(advanceWiring(part('led-1', 'A'), part('led-1', 'K'))).toEqual({
      kind: 'not-routable',
    });
  });

  it('refuses peripheral → peripheral wiring', () => {
    expect(advanceWiring(part('led-1', 'A'), part('button-1', '1'))).toEqual({
      kind: 'not-routable',
    });
  });

  it('allows a wire in both directions (part→MCU and MCU→part)', () => {
    expect(advanceWiring(part('led-1', 'A'), mcu('GPIO2'))).toEqual({
      kind: 'wire',
      from: part('led-1', 'A'),
      to: mcu('GPIO2'),
    });
    expect(advanceWiring(mcu('GPIO2'), part('led-1', 'A'))).toEqual({
      kind: 'wire',
      from: mcu('GPIO2'),
      to: part('led-1', 'A'),
    });
  });
});
