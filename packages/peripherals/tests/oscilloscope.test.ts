// PRD: §F-PER-8, §6.4 — Oscilloscope model (dev-plan P2.5): gpio edges and
// device-decoded pwm states converge on 'waveform' snapshots carrying the full
// scrolling-window state of every active channel.
import { describe, expect, it } from 'vitest';
import type {
  BusTransaction,
  Peripheral,
  PeripheralContext,
  RenderSnapshot,
  WaveformPayload,
} from '../src/types';
import { oscilloscopeFactory } from '../src/oscilloscope';

function fixture(props?: Record<string, unknown>): { per: Peripheral; snaps: RenderSnapshot[] } {
  const snaps: RenderSnapshot[] = [];
  const ctx: PeripheralContext = {
    emitSnapshot: (s) => snaps.push(s),
    log: () => {},
    onTick: () => () => {},
  };
  return { per: oscilloscopeFactory.create(ctx, { instanceId: 'scope1', ...props }), snaps };
}

function gpioTx(level: 0 | 1, ts: number): BusTransaction {
  return { kind: 'gpio', bus: 0, target: 2, dir: 'write', data: Uint8Array.from([level]), ts };
}

/** Device wire encoding: freq centi-Hz u32 LE + duty permille u16 LE. */
function pwmTx(freqHz: number, dutyPermille: number, ts: number): BusTransaction {
  const centi = Math.round(freqHz * 100);
  return {
    kind: 'pwm', bus: 0, target: 2, dir: 'write', ts,
    data: Uint8Array.from([
      centi & 0xff, (centi >> 8) & 0xff, (centi >> 16) & 0xff, (centi >> 24) & 0xff,
      dutyPermille & 0xff, (dutyPermille >> 8) & 0xff,
    ]),
  };
}

function waveforms(snaps: RenderSnapshot[]): WaveformPayload[] {
  return snaps
    .filter((s) => s.type === 'waveform' && 'channels' in (s.payload as object))
    .map((s) => s.payload as WaveformPayload);
}

describe('oscilloscope model — gpio capture (PRD §F-PER-8)', () => {
  it('records a level edge on the channel the transaction arrived via', () => {
    const { per, snaps } = fixture();
    per.onTransaction(gpioTx(1, 10), 'CH1');
    const wf = waveforms(snaps);
    expect(wf).toHaveLength(1);
    expect(wf[0].channels).toHaveLength(1);
    expect(wf[0].channels[0].label).toBe('CH1');
    expect(wf[0].channels[0].edges).toEqual([{ t: 200, level: 1 }]);
    expect(wf[0].windowMs).toBe(200);
    expect(wf[0].startMs).toBe(10 - 200);
    expect(snaps[0].instanceId).toBe('scope1');
  });

  it('attributes simultaneous channels to their own via-pins', () => {
    const { per, snaps } = fixture();
    per.onTransaction(gpioTx(1, 10), 'CH1');
    per.onTransaction(gpioTx(1, 20), 'CH3');
    const wf = waveforms(snaps).at(-1)!;
    // Channels keep display order (CH1 before CH3) regardless of arrival order.
    expect(wf.channels.map((c) => c.label)).toEqual(['CH1', 'CH3']);
    expect(wf.channels[0].edges.map((e) => e.t)).toEqual([10 - wf.startMs]);
    expect(wf.channels[1].edges.map((e) => e.t)).toEqual([20 - wf.startMs]);
  });

  it('reconstructs a square wave with correct period spacing', () => {
    const { per, snaps } = fixture();
    // 10 virtual ms half-period -> edges every 10ms.
    for (let i = 0; i <= 8; i++) per.onTransaction(gpioTx(i % 2 === 0 ? 1 : 0, i * 10), 'CH1');
    const wf = waveforms(snaps).at(-1)!;
    const ts = wf.channels[0].edges.map((e) => e.t);
    expect(ts.length).toBeGreaterThanOrEqual(8);
    const deltas = ts.slice(1).map((t, i) => t - ts[i]);
    expect(deltas.every((d) => Math.abs(d - 10) < 1e-9)).toBe(true);
    expect(wf.channels[0].edges[0].level).toBe(1); // rising first
  });

  it('deduplicates a repeated level (no edge, no snapshot)', () => {
    const { per, snaps } = fixture();
    per.onTransaction(gpioTx(1, 10), 'CH1');
    per.onTransaction(gpioTx(1, 20), 'CH1');
    expect(waveforms(snaps)).toHaveLength(1);
  });

  it('prunes edges that scrolled out of the window', () => {
    const { per, snaps } = fixture({ windowMs: 100 });
    per.onTransaction(gpioTx(1, 0), 'CH1');
    per.onTransaction(gpioTx(0, 50), 'CH1');
    per.onTransaction(gpioTx(1, 500), 'CH1'); // window is now [400, 500]
    const wf = waveforms(snaps).at(-1)!;
    expect(wf.startMs).toBe(400);
    // The t=0/t=50 edges are gone; one pre-window keeper may remain, re-anchored to t=0.
    const ts = wf.channels[0].edges.map((e) => e.t);
    expect(ts.at(-1)).toBe(100);
    expect(ts.every((t) => t >= 0 && t <= 100)).toBe(true);
  });

  it('caps the per-channel edge buffer (oldest dropped)', () => {
    const { per, snaps } = fixture({ windowMs: 100_000, maxEdges: 10 });
    for (let i = 0; i <= 20; i++) per.onTransaction(gpioTx(i % 2 === 0 ? 1 : 0, i), 'CH1');
    const wf = waveforms(snaps).at(-1)!;
    expect(wf.channels[0].edges.length).toBeLessThanOrEqual(10);
  });

  it('ignores transactions without a via-pin or with an unknown pin', () => {
    const { per, snaps } = fixture();
    per.onTransaction(gpioTx(1, 10));
    per.onTransaction(gpioTx(1, 10), 'GND');
    per.onTransaction(gpioTx(1, 10), 'CH9');
    expect(waveforms(snaps)).toHaveLength(0);
  });

  it('ignores read transactions, non-finite timestamps and other bus kinds', () => {
    const { per, snaps } = fixture();
    per.onTransaction({ ...gpioTx(1, 10), dir: 'read' }, 'CH1');
    per.onTransaction(gpioTx(1, Number.NaN), 'CH1');
    per.onTransaction({ kind: 'i2c', bus: 0, target: 0x3c, dir: 'write', data: Uint8Array.from([1]), ts: 10 }, 'CH1');
    expect(waveforms(snaps)).toHaveLength(0);
  });
});

describe('oscilloscope model — pwm synthesis (LEDC decode, no pin toggling)', () => {
  it('expands a steady pwm state into edges across the window', () => {
    const { per, snaps } = fixture({ windowMs: 100 });
    // 100Hz -> 10ms period, 50% duty -> 10 rising + 10 falling edges in 100ms.
    per.onTransaction(pwmTx(100, 500, 1), 'CH2');
    const wf = waveforms(snaps).at(-1)!;
    const edges = wf.channels[0].edges;
    expect(wf.channels[0].label).toBe('CH2');
    // Rising edges at 0,10,...,100 (inclusive) + falling at 5,15,...,95 = 21.
    expect(edges.length).toBe(21);
    expect(edges[0]).toEqual({ t: 0, level: 1 });
    expect(edges[1]).toEqual({ t: 5, level: 0 });
    expect(edges[2]).toEqual({ t: 10, level: 1 });
  });

  it('honors the duty cycle in the synthesized high time', () => {
    const { per, snaps } = fixture({ windowMs: 100 });
    per.onTransaction(pwmTx(100, 250, 1), 'CH2'); // 25% duty -> high 2.5ms
    const edges = waveforms(snaps).at(-1)!.channels[0].edges;
    expect(edges[1]).toEqual({ t: 2.5, level: 0 });
  });

  it('emits an edge-free channel when the pwm tone stops', () => {
    const { per, snaps } = fixture({ windowMs: 100 });
    per.onTransaction(pwmTx(100, 500, 1), 'CH2');
    per.onTransaction(pwmTx(100, 0, 2), 'CH2'); // duty 0 = stop
    const wf = waveforms(snaps).at(-1)!;
    expect(wf.channels[0].edges).toEqual([]);
  });

  it('a real gpio write supersedes the synthesized pwm channel', () => {
    const { per, snaps } = fixture({ windowMs: 100 });
    per.onTransaction(pwmTx(100, 500, 1), 'CH2');
    per.onTransaction(gpioTx(1, 50), 'CH2');
    const wf = waveforms(snaps).at(-1)!;
    // Window is [50-100, 50]; the single real edge sits at the right edge.
    expect(wf.channels[0].edges).toEqual([{ t: 100, level: 1 }]);
  });

  it('ignores a truncated pwm payload', () => {
    const { per, snaps } = fixture();
    per.onTransaction({ kind: 'pwm', bus: 0, target: 2, dir: 'write', data: Uint8Array.from([1, 2]), ts: 1 }, 'CH1');
    expect(waveforms(snaps)).toHaveLength(0);
  });

  it('caps synthesized edges for very fast tones', () => {
    const { per, snaps } = fixture({ windowMs: 100, maxEdges: 10 });
    per.onTransaction(pwmTx(100_000, 500, 1), 'CH2'); // 10us period -> 20000 edges uncapped
    const wf = waveforms(snaps).at(-1)!;
    expect(wf.channels[0].edges.length).toBeLessThanOrEqual(10);
  });
});

describe('oscilloscope model — snapshot hygiene', () => {
  it('suppresses an identical consecutive payload', () => {
    const { per, snaps } = fixture();
    per.onTransaction(gpioTx(1, 10), 'CH1');
    // A pwm stop on a silent channel adds nothing; with an older timestamp the
    // window anchor does not move either, so the payload is byte-identical.
    per.onTransaction(pwmTx(0, 0, 5), 'CH2');
    expect(waveforms(snaps)).toHaveLength(1);
  });

  it('keeps the snapshot a restatable state (full window, not a delta)', () => {
    const { per, snaps } = fixture();
    per.onTransaction(gpioTx(1, 10), 'CH1');
    per.onTransaction(gpioTx(0, 20), 'CH1');
    const wf = waveforms(snaps).at(-1)!;
    expect(wf.channels[0].edges).toHaveLength(2); // both edges present, no replay needed
  });
});
