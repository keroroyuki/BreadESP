// PRD: §F-PER-5, §6.4 — BuzzerAudio tone mapping and the WebAudio binding
// (dev-plan P2.3). The pure mapping (toneFromSnapshot) and the engine's
// voice lifecycle run against a stub AudioContext, so no DOM is needed
// (same pattern as the TftRenderer canvas stub).
import { describe, expect, it } from 'vitest';
import type { RenderSnapshot } from '@breadesp/peripherals';
import {
  BuzzerToneEngine,
  isSounding,
  toneFromSnapshot,
  type AudioContextLike,
  type GainNodeLike,
  type OscillatorNodeLike,
} from '../src/audio/BuzzerAudio';

function toneSnap(freqHz: number, duty: number, instanceId = 'buzz1'): RenderSnapshot {
  return { instanceId, type: 'tone', payload: { freqHz, duty } };
}

// --- Stub WebAudio surface ---------------------------------------------------
class StubParam {
  value = 0;
}

class StubOsc implements OscillatorNodeLike {
  type = '';
  frequency = new StubParam();
  connections: unknown[] = [];
  started = false;
  stopped = false;
  connect(target: unknown): void { this.connections.push(target); }
  start(): void { this.started = true; }
  stop(): void { this.stopped = true; }
}

class StubGain implements GainNodeLike {
  gain = new StubParam();
  connections: unknown[] = [];
  connect(target: unknown): void { this.connections.push(target); }
}

class StubContext implements AudioContextLike {
  readonly destination = { name: 'destination' };
  state: string = 'running';
  oscs: StubOsc[] = [];
  gains: StubGain[] = [];
  resumeCalls = 0;
  createOscillator(): OscillatorNodeLike {
    const o = new StubOsc();
    this.oscs.push(o);
    return o;
  }
  createGain(): GainNodeLike {
    const g = new StubGain();
    this.gains.push(g);
    return g;
  }
  resume(): void { this.resumeCalls++; this.state = 'running'; }
}

function engineWith(stub: StubContext, volume?: number): BuzzerToneEngine {
  return new BuzzerToneEngine(() => stub, volume !== undefined ? { volume } : undefined);
}

describe('toneFromSnapshot (pure mapping)', () => {
  it('maps a tone snapshot to its params', () => {
    expect(toneFromSnapshot(toneSnap(440, 0.5))).toEqual({ freqHz: 440, duty: 0.5 });
  });

  it('returns null for non-tone snapshots and missing snapshots', () => {
    expect(toneFromSnapshot(undefined)).toBeNull();
    expect(toneFromSnapshot({ instanceId: 'x', type: 'level', payload: { level: 1 } })).toBeNull();
    expect(toneFromSnapshot({ instanceId: 'x', type: 'tone', payload: { text: 'nope' } as never })).toBeNull();
  });

  it('clamps duty into 0..1 and rejects non-finite values', () => {
    expect(toneFromSnapshot(toneSnap(440, 7))).toEqual({ freqHz: 440, duty: 1 });
    expect(toneFromSnapshot(toneSnap(Number.NaN, 0.5))).toBeNull();
    expect(toneFromSnapshot(toneSnap(440, Number.POSITIVE_INFINITY))).toBeNull();
  });

  it('isSounding requires a positive frequency and duty', () => {
    expect(isSounding({ freqHz: 440, duty: 0.5 })).toBe(true);
    expect(isSounding({ freqHz: 0, duty: 0.5 })).toBe(false);
    expect(isSounding({ freqHz: 440, duty: 0 })).toBe(false);
    expect(isSounding(null)).toBe(false);
  });
});

describe('BuzzerToneEngine (WebAudio binding over a stub context)', () => {
  it('creates one square-wave voice per instance, started once', () => {
    const stub = new StubContext();
    const engine = engineWith(stub);
    engine.update('buzz1', { freqHz: 440, duty: 0.5 });
    engine.update('buzz1', { freqHz: 440, duty: 0.5 });
    expect(stub.oscs).toHaveLength(1);
    const osc = stub.oscs[0];
    expect(osc.type).toBe('square');
    expect(osc.started).toBe(true);
    expect(osc.frequency.value).toBe(440);
    // osc -> gain -> destination
    expect(osc.connections).toEqual([stub.gains[0]]);
    expect(stub.gains[0].connections).toEqual([stub.destination]);
    // gain = volume * duty
    expect(stub.gains[0].gain.value).toBeCloseTo(0.08 * 0.5, 9);
  });

  it('retunes the running voice on a frequency change', () => {
    const stub = new StubContext();
    const engine = engineWith(stub);
    engine.update('buzz1', { freqHz: 440, duty: 0.5 });
    engine.update('buzz1', { freqHz: 880, duty: 0.5 });
    expect(stub.oscs).toHaveLength(1);
    expect(stub.oscs[0].frequency.value).toBe(880);
  });

  it('silences the voice on a null/zero tone without stopping the oscillator', () => {
    const stub = new StubContext();
    const engine = engineWith(stub);
    engine.update('buzz1', { freqHz: 440, duty: 0.5 });
    engine.update('buzz1', { freqHz: 0, duty: 0 });
    expect(stub.gains[0].gain.value).toBe(0);
    expect(stub.oscs[0].stopped).toBe(false);
    // and it can sound again afterwards
    engine.update('buzz1', { freqHz: 262, duty: 1 });
    expect(stub.oscs[0].frequency.value).toBe(262);
    expect(stub.gains[0].gain.value).toBeCloseTo(0.08, 9);
  });

  it('keeps one voice per instance id', () => {
    const stub = new StubContext();
    const engine = engineWith(stub);
    engine.update('buzz1', { freqHz: 440, duty: 0.5 });
    engine.update('buzz2', { freqHz: 880, duty: 0.25 });
    expect(stub.oscs).toHaveLength(2);
    expect(stub.oscs[0].frequency.value).toBe(440);
    expect(stub.oscs[1].frequency.value).toBe(880);
    engine.update('buzz1', null);
    expect(stub.gains[0].gain.value).toBe(0);
    expect(stub.gains[1].gain.value).toBeCloseTo(0.08 * 0.25, 9);
  });

  it('silencing a never-started instance creates no voice', () => {
    const stub = new StubContext();
    const engine = engineWith(stub);
    engine.update('buzz1', null);
    expect(stub.oscs).toHaveLength(0);
  });

  it('honours a custom full-scale volume', () => {
    const stub = new StubContext();
    engineWith(stub, 0.2).update('buzz1', { freqHz: 440, duty: 0.5 });
    expect(stub.gains[0].gain.value).toBeCloseTo(0.1, 9);
  });

  it('stays silent when no AudioContext is available', () => {
    const engine = new BuzzerToneEngine(() => null);
    engine.update('buzz1', { freqHz: 440, duty: 0.5 });
    expect(engine.context()).toBeNull();
  });

  it('resume() only fires while the context is suspended', () => {
    const stub = new StubContext();
    stub.state = 'suspended';
    const engine = engineWith(stub);
    engine.resume();
    expect(stub.resumeCalls).toBe(1);
    engine.resume(); // now running: no-op
    expect(stub.resumeCalls).toBe(1);
  });

  it('attachGestureResume resumes once on pointerdown and unsubscribes', () => {
    const stub = new StubContext();
    stub.state = 'suspended';
    const engine = engineWith(stub);
    const listeners = new Map<string, () => void>();
    const target = {
      addEventListener: (name: string, cb: () => void) => listeners.set(name, cb),
      removeEventListener: (name: string) => listeners.delete(name),
    };
    const detach = engine.attachGestureResume(target);
    expect(listeners.has('pointerdown')).toBe(true);
    listeners.get('pointerdown')!();
    expect(stub.resumeCalls).toBe(1);
    expect(listeners.has('pointerdown')).toBe(false); // one-shot
    detach(); // idempotent teardown
    expect(listeners.has('pointerdown')).toBe(false);
    expect(engine.attachGestureResume(undefined)).toBeInstanceOf(Function);
  });

  it('dispose() stops every voice and forgets them', () => {
    const stub = new StubContext();
    const engine = engineWith(stub);
    engine.update('buzz1', { freqHz: 440, duty: 0.5 });
    engine.update('buzz2', { freqHz: 880, duty: 0.5 });
    engine.dispose();
    expect(stub.oscs.every((o) => o.stopped)).toBe(true);
    expect(stub.gains.every((g) => g.gain.value === 0)).toBe(true);
    // A post-dispose update starts a fresh voice.
    engine.update('buzz1', { freqHz: 440, duty: 0.5 });
    expect(stub.oscs).toHaveLength(3);
  });
});
