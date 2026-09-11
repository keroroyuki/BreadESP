// PRD: §6.2, §F-BB-3 — Rotary knob model (dev-plan P3.4): rotate() queues detent
// steps that play back as a quadrature (Gray code) transition sequence on the
// A/B pins via ctx.drivePin, one transition per stepMs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Peripheral, PeripheralContext, RenderSnapshot } from '../src/types';
import { knobConfigFromProps, knobFactory, quadratureLevels, KNOB_LIMITS } from '../src/knob';

interface DriveCall { pinId: string; level: 0 | 1 }

function fixture(props?: Record<string, unknown>, drivePin?: (pinId: string, level: 0 | 1) => boolean) {
  const drives: DriveCall[] = [];
  const logs: { level: string; msg: string }[] = [];
  const snapshots: RenderSnapshot[] = [];
  const ctx: PeripheralContext = {
    emitSnapshot: (s) => snapshots.push(s),
    log: (level, msg) => logs.push({ level, msg }),
    onTick: () => () => {},
    drivePin: drivePin ?? ((pinId, level) => { drives.push({ pinId, level }); return true; }),
  };
  return { per: knobFactory.create(ctx, { instanceId: 'knob1', ...props }), drives, logs, snapshots };
}

/** Collapse drive calls into the (A,B) level trajectory they produce. */
function trajectory(drives: DriveCall[]): [number, number][] {
  let a = 0, b = 0;
  const states: [number, number][] = [];
  for (const d of drives) {
    if (d.pinId === 'A') a = d.level;
    if (d.pinId === 'B') b = d.level;
    states.push([a, b]);
  }
  return states;
}

describe('knobConfigFromProps (P3.4)', () => {
  it('applies documented defaults for absent props', () => {
    expect(knobConfigFromProps()).toEqual({ stepMs: 5 });
  });

  it('clamps out-of-range and non-finite values', () => {
    expect(knobConfigFromProps({ stepMs: 0 }).stepMs).toBe(KNOB_LIMITS.stepMs.min);
    expect(knobConfigFromProps({ stepMs: 10000 }).stepMs).toBe(KNOB_LIMITS.stepMs.max);
    expect(knobConfigFromProps({ stepMs: Number.NaN }).stepMs).toBe(5);
    expect(knobConfigFromProps({ stepMs: 'fast' }).stepMs).toBe(5);
  });
});

describe('quadratureLevels (P3.4)', () => {
  it('encodes the four Gray phases (A leads B clockwise)', () => {
    expect(quadratureLevels(0)).toEqual([0, 0]);
    expect(quadratureLevels(1)).toEqual([1, 0]);
    expect(quadratureLevels(2)).toEqual([1, 1]);
    expect(quadratureLevels(3)).toEqual([0, 1]);
  });

  it('wraps the phase modulo 4', () => {
    expect(quadratureLevels(4)).toEqual([0, 0]);
    expect(quadratureLevels(7)).toEqual([0, 1]);
  });
});

describe('knob model (P3.4)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('drives the rest state on creation without warning', () => {
    const { drives, logs, per } = fixture();
    expect(drives).toEqual([
      { pinId: 'A', level: 0 },
      { pinId: 'B', level: 0 },
    ]);
    expect(logs).toHaveLength(0);
    per.dispose();
  });

  it('plays one full clockwise detent as four transitions, one per stepMs', () => {
    const { per, drives } = fixture({ stepMs: 5 });
    drives.length = 0; // ignore the creation-time rest-state sync
    per.rotate?.(1);
    for (let i = 0; i < 4; i++) vi.advanceTimersByTime(5);
    // CW Gray cycle 00 -> 10 -> 11 -> 01 -> 00, one pin flips per step.
    expect(drives).toEqual([
      { pinId: 'A', level: 1 },
      { pinId: 'B', level: 1 },
      { pinId: 'A', level: 0 },
      { pinId: 'B', level: 0 },
    ]);
    expect(trajectory(drives)).toEqual([[1, 0], [1, 1], [0, 1], [0, 0]]);
    per.dispose();
  });

  it('plays counter-clockwise detents in reverse order', () => {
    const { per, drives } = fixture();
    drives.length = 0;
    per.rotate?.(-1);
    vi.advanceTimersByTime(100);
    expect(trajectory(drives)).toEqual([[0, 1], [1, 1], [1, 0], [0, 0]]);
    per.dispose();
  });

  it('coalesces queued detents of mixed direction into the net rotation', () => {
    const { per, drives } = fixture({ stepMs: 1 });
    drives.length = 0;
    per.rotate?.(2);   // +8 transitions queued
    per.rotate?.(-1);  // nets to +4 (the knob cannot visit cancelled positions)
    vi.advanceTimersByTime(1000);
    const states = trajectory(drives);
    expect(states).toHaveLength(4);
    expect(states).toEqual([[1, 0], [1, 1], [0, 1], [0, 0]]); // one clean CW cycle
    per.dispose();
  });

  it('plays a second gesture after the first drained, without skipped states', () => {
    const { per, drives } = fixture({ stepMs: 1 });
    drives.length = 0;
    per.rotate?.(2);
    vi.advanceTimersByTime(1000);
    per.rotate?.(-1);
    vi.advanceTimersByTime(1000);
    const states = trajectory(drives);
    expect(states).toHaveLength(12);
    expect(states.at(-1)).toEqual([0, 0]); // net +1 detent, back at rest
    // No skipped states: consecutive states differ in exactly one pin.
    let prev: [number, number] = [0, 0];
    for (const s of states) {
      expect(Math.abs(s[0] - prev[0]) + Math.abs(s[1] - prev[1])).toBe(1);
      prev = s;
    }
    per.dispose();
  });

  it('rejects non-finite and zero deltas without driving anything', () => {
    const { per, drives } = fixture();
    drives.length = 0;
    per.rotate?.(Number.NaN);
    per.rotate?.(0);
    per.rotate?.(0.4); // truncates to 0
    vi.advanceTimersByTime(1000);
    expect(drives).toHaveLength(0);
    per.dispose();
  });

  it('clamps oversized spins to the per-call detent cap', () => {
    const { per, drives } = fixture({ stepMs: 1 });
    drives.length = 0;
    per.rotate?.(1000); // clamped to 64 detents = 256 transitions
    vi.advanceTimersByTime(10000);
    expect(drives).toHaveLength(KNOB_LIMITS.detentsPerCall * 4);
    per.dispose();
  });

  it('warns once per unwired pin and keeps driving the wired one', () => {
    const { per, drives, logs } = fixture({}, (pinId) => pinId !== 'A'); // A unwired
    drives.length = 0;
    per.rotate?.(2);
    vi.advanceTimersByTime(1000);
    expect(drives.every((d) => d.pinId === 'B')).toBe(true);
    const warns = logs.filter((l) => l.level === 'warn' && l.msg.includes("pin A"));
    expect(warns).toHaveLength(1); // one-shot
    per.dispose();
  });

  it('warns once when the context has no drivePin channel', () => {
    const logs: { level: string; msg: string }[] = [];
    const ctx: PeripheralContext = {
      emitSnapshot: () => {},
      log: (level, msg) => logs.push({ level, msg }),
      onTick: () => () => {},
      // no drivePin: old Bridge
    };
    const per: Peripheral = knobFactory.create(ctx, { instanceId: 'knob1' });
    per.rotate?.(1);
    per.rotate?.(1);
    vi.advanceTimersByTime(1000);
    expect(logs.filter((l) => l.level === 'warn' && l.msg.includes('no GPIO input channel'))).toHaveLength(1);
    per.dispose();
  });

  it('dispose stops a queued rotation mid-flight', () => {
    const { per, drives } = fixture({ stepMs: 5 });
    drives.length = 0;
    per.rotate?.(4);
    vi.advanceTimersByTime(5); // one transition
    const before = drives.length;
    per.dispose();
    vi.advanceTimersByTime(1000);
    expect(drives).toHaveLength(before);
  });

  it('exposes factory metadata with A/B/SW gpio-in pins', () => {
    expect(knobFactory.kind).toBe('knob');
    expect(knobFactory.pins.map((p) => [p.id, p.role])).toEqual([
      ['A', 'gpio-in'], ['B', 'gpio-in'], ['SW', 'gpio-in'], ['GND', 'gnd'],
    ]);
    expect(knobFactory.defaults).toEqual({ stepMs: 5 });
  });
});
