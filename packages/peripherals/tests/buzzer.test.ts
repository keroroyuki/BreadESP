// PRD: §F-PER-5, §6.4 — Buzzer model (dev-plan P2.3): LEDC pwm transactions
// (device-decoded freq/duty) and the gpio bit-bang fallback both converge on
// deduplicated 'tone' snapshots.
import { describe, expect, it } from 'vitest';
import type { BusTransaction, Peripheral, PeripheralContext, RenderSnapshot } from '../src/types';
import { buzzerFactory } from '../src/buzzer';

function fixture(): { per: Peripheral; snaps: RenderSnapshot[] } {
  const snaps: RenderSnapshot[] = [];
  const ctx: PeripheralContext = {
    emitSnapshot: (s) => snaps.push(s),
    log: () => {},
    onTick: () => () => {},
  };
  return { per: buzzerFactory.create(ctx, { instanceId: 'buzz1' }), snaps };
}

/** Device wire encoding: freq centi-Hz u32 LE + duty permille u16 LE. */
function pwmTx(freqHz: number, dutyPermille: number, ts = 1): BusTransaction {
  const centi = Math.round(freqHz * 100);
  return {
    kind: 'pwm', bus: 0, target: 4, dir: 'write', ts,
    data: Uint8Array.from([
      centi & 0xff, (centi >> 8) & 0xff, (centi >> 16) & 0xff, (centi >> 24) & 0xff,
      dutyPermille & 0xff, (dutyPermille >> 8) & 0xff,
    ]),
  };
}

function gpioTx(level: 0 | 1, ts: number): BusTransaction {
  return { kind: 'gpio', bus: 0, target: 4, dir: 'write', data: Uint8Array.from([level]), ts };
}

function tones(snaps: RenderSnapshot[]): { freqHz: number; duty: number }[] {
  return snaps.filter((s) => s.type === 'tone').map((s) => s.payload as { freqHz: number; duty: number });
}

describe('buzzer model — pwm path (PRD §F-PER-5, LEDC decoded by the device)', () => {
  it('emits a tone snapshot for a decoded LEDC configuration', () => {
    const { per, snaps } = fixture();
    per.onTransaction(pwmTx(440, 500));
    expect(tones(snaps)).toEqual([{ freqHz: 440, duty: 0.5 }]);
    expect(snaps[0].instanceId).toBe('buzz1');
  });

  it('decodes fractional centihertz frequencies', () => {
    const { per, snaps } = fixture();
    per.onTransaction(pwmTx(439.82, 500));
    expect(tones(snaps)[0].freqHz).toBeCloseTo(439.82, 2);
  });

  it('goes silent on a zero-duty or zero-frequency update', () => {
    const { per, snaps } = fixture();
    per.onTransaction(pwmTx(440, 500));
    per.onTransaction(pwmTx(440, 0));
    expect(tones(snaps)).toEqual([{ freqHz: 440, duty: 0.5 }, { freqHz: 0, duty: 0 }]);
  });

  it('deduplicates a restated tone (steady LEDC config emits once)', () => {
    const { per, snaps } = fixture();
    per.onTransaction(pwmTx(440, 500));
    per.onTransaction(pwmTx(440, 500));
    per.onTransaction(pwmTx(440, 500));
    expect(tones(snaps)).toHaveLength(1);
  });

  it('follows a retune (440 -> 880Hz emits two tones)', () => {
    const { per, snaps } = fixture();
    per.onTransaction(pwmTx(440, 500));
    per.onTransaction(pwmTx(880, 500));
    expect(tones(snaps)).toEqual([
      { freqHz: 440, duty: 0.5 },
      { freqHz: 880, duty: 0.5 },
    ]);
  });

  it('clamps an out-of-range duty to 100%', () => {
    const { per, snaps } = fixture();
    per.onTransaction(pwmTx(440, 2048));
    expect(tones(snaps)[0].duty).toBe(1);
  });

  it('ignores truncated pwm payloads', () => {
    const { per, snaps } = fixture();
    per.onTransaction({ kind: 'pwm', bus: 0, target: 4, dir: 'write', data: Uint8Array.from([1, 2, 3]), ts: 1 });
    expect(snaps).toHaveLength(0);
  });

  it('ignores reads and unrelated transaction kinds', () => {
    const { per, snaps } = fixture();
    per.onTransaction({ kind: 'pwm', bus: 0, target: 4, dir: 'read', data: new Uint8Array(0), ts: 1 });
    per.onTransaction({ kind: 'i2c', bus: 0, target: 0x3c, dir: 'write', data: Uint8Array.from([0]), ts: 1 });
    expect(snaps).toHaveLength(0);
  });
});

describe('buzzer model — gpio bit-bang fallback', () => {
  /** Rising edges every `periodMs` (a hand-toggled square wave). */
  function bitBang(per: Peripheral, periodMs: number, cycles: number, startTs = 0): void {
    let ts = startTs;
    for (let i = 0; i < cycles; i++) {
      per.onTransaction(gpioTx(1, ts));
      per.onTransaction(gpioTx(0, ts + periodMs / 2));
      ts += periodMs;
    }
  }

  it('derives the frequency from rising-edge periods', () => {
    const { per, snaps } = fixture();
    bitBang(per, 1, 8); // 1ms period = 1000Hz
    const t = tones(snaps);
    expect(t).toHaveLength(1);
    expect(t[0].freqHz).toBeCloseTo(1000, 6);
    expect(t[0].duty).toBe(0.5); // assumed square wave
  });

  it('needs at least four rising edges before estimating', () => {
    const { per, snaps } = fixture();
    bitBang(per, 1, 3);
    expect(tones(snaps)).toHaveLength(0);
  });

  it('does not re-emit while the estimate stays inside the drift band', () => {
    const { per, snaps } = fixture();
    bitBang(per, 1, 30); // long steady 1kHz burst, quantized timestamps
    expect(tones(snaps)).toHaveLength(1);
  });

  it('tracks a frequency change in the edge stream', () => {
    const { per, snaps } = fixture();
    bitBang(per, 1, 8);
    bitBang(per, 0.5, 8, 100); // 1kHz -> 2kHz
    const t = tones(snaps);
    expect(t[0].freqHz).toBeCloseTo(1000, 6);
    expect(t.at(-1)!.freqHz).toBeCloseTo(2000, 6);
  });

  it('ignores implausible periods (contact noise, sub-audible)', () => {
    const { per, snaps } = fixture();
    bitBang(per, 0.01, 8); // 100kHz: above the audible band
    expect(tones(snaps)).toHaveLength(0);
  });
});
