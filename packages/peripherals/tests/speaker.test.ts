// PRD: §F-PER-6, §6.4 — Speaker model (dev-plan P2.4): i2s transactions
// (device-forwarded DMA PCM with a format header) decode into mono Float32
// 'audio' snapshots for WebAudio playback.
import { describe, expect, it } from 'vitest';
import type { BusTransaction, Peripheral, PeripheralContext, RenderSnapshot } from '../src/types';
import { decodeI2sPayload, speakerFactory } from '../src/speaker';

function fixture(): { per: Peripheral; snaps: RenderSnapshot[] } {
  const snaps: RenderSnapshot[] = [];
  const ctx: PeripheralContext = {
    emitSnapshot: (s) => snaps.push(s),
    log: () => {},
    onTick: () => () => {},
  };
  return { per: speakerFactory.create(ctx, { instanceId: 'spk1' }), snaps };
}

/** Device wire encoding: rate u32 LE + bits + channels + flags + reserved + PCM. */
function i2sTx(opts: {
  rate: number; bits?: number; channels?: number; flags?: number; pcm: number[];
  ts?: number; dir?: 'read' | 'write'; kind?: BusTransaction['kind'];
}): BusTransaction {
  const { rate, bits = 16, channels = 2, flags = 0, pcm, ts = 1, dir = 'write', kind = 'i2s' } = opts;
  return {
    kind, bus: 0, dir, ts,
    data: Uint8Array.from([
      rate & 0xff, (rate >> 8) & 0xff, (rate >> 16) & 0xff, (rate >> 24) & 0xff,
      bits, channels, flags, 0, ...pcm,
    ]),
  };
}

/** s16le stereo frames (L, R) as a byte array. */
function s16Stereo(frames: [number, number][]): number[] {
  const out: number[] = [];
  for (const [l, r] of frames) {
    for (const s of [l, r]) {
      const v = s & 0xffff;
      out.push(v & 0xff, (v >> 8) & 0xff);
    }
  }
  return out;
}

function audios(snaps: RenderSnapshot[]): { samples: number[]; sampleRate: number }[] {
  return snaps
    .filter((s) => s.type === 'audio')
    .map((s) => s.payload as { samples: number[]; sampleRate: number });
}

describe('speaker model — decodeI2sPayload (PRD §F-PER-6)', () => {
  it('decodes s16le stereo PCM and averages channels to mono', () => {
    const tx = i2sTx({ rate: 16000, pcm: s16Stereo([[32767, 16384], [-32768, -16384], [0, 100]]) });
    const d = decodeI2sPayload(tx.data)!;
    expect(d.sampleRate).toBe(16000);
    expect(d.samples.length).toBe(3);
    expect(d.samples[0]).toBeCloseTo((32767 / 32768 + 16384 / 32768) / 2, 6);
    expect(d.samples[1]).toBeCloseTo((-1 + -0.5) / 2, 3);
    expect(d.samples[2]).toBeCloseTo((100 / 32768) / 2, 6);
  });

  it('decodes mono 16-bit streams', () => {
    const d = decodeI2sPayload(i2sTx({ rate: 8000, channels: 1, pcm: s16Stereo([[16384, 0]]).slice(0, 2) }).data)!;
    expect(d.samples).toEqual([0.5]);
  });

  it('decodes 8-bit PCM (unsigned-looking bytes are signed samples)', () => {
    const d = decodeI2sPayload(i2sTx({ rate: 8000, bits: 8, channels: 1, pcm: [0xff, 0x00, 0x80] }).data)!;
    expect(d.samples[0]).toBeCloseTo(-1 / 128, 6);
    expect(d.samples[1]).toBe(0);
    expect(d.samples[2]).toBeCloseTo(-1, 6);
  });

  it('sign-extends 24-bit PCM', () => {
    // -1 as 24-bit LE = ff ff ff; max = ff ff 7f
    const d = decodeI2sPayload(i2sTx({ rate: 48000, bits: 24, channels: 1, pcm: [0xff, 0xff, 0xff, 0xff, 0xff, 0x7f] }).data)!;
    expect(d.samples[0]).toBeCloseTo(-1 / 8388608, 9);
    expect(d.samples[1]).toBeCloseTo(8388607 / 8388608, 9);
  });

  it('drops a partial trailing frame', () => {
    const d = decodeI2sPayload(i2sTx({ rate: 16000, pcm: [...s16Stereo([[100, 100]]), 0x12, 0x34] }).data)!;
    expect(d.samples.length).toBe(1);
  });

  it('rejects truncated headers, zero rate/channels and odd bit widths', () => {
    expect(decodeI2sPayload(Uint8Array.from([1, 2, 3]))).toBeNull();
    expect(decodeI2sPayload(i2sTx({ rate: 0, pcm: [0, 0] }).data)).toBeNull();
    expect(decodeI2sPayload(i2sTx({ rate: 16000, channels: 0, pcm: [0, 0] }).data)).toBeNull();
    expect(decodeI2sPayload(i2sTx({ rate: 16000, bits: 12, pcm: [0, 0, 0, 0] }).data)).toBeNull();
    expect(decodeI2sPayload(i2sTx({ rate: 16000, pcm: [] }).data)).toBeNull();
  });
});

describe('speaker model — transaction handling (PRD §6.2)', () => {
  it('batches PCM into >=512-sample audio snapshots', () => {
    const { per, snaps } = fixture();
    // 600 stereo frames in one transaction -> one 600-sample snapshot.
    const frames: [number, number][] = Array.from({ length: 600 }, (_, i) => [i % 100, i % 100]);
    per.onTransaction(i2sTx({ rate: 16667, pcm: s16Stereo(frames) }));
    const a = audios(snaps);
    expect(a.length).toBe(1);
    expect(a[0].sampleRate).toBe(16667);
    expect(a[0].samples.length).toBe(600);
    expect(snaps[0].instanceId).toBe('spk1');
  });

  it('accumulates small transactions across the batch threshold', () => {
    const { per, snaps } = fixture();
    for (let i = 0; i < 300; i++) {
      per.onTransaction(i2sTx({ rate: 16000, pcm: s16Stereo([[1, 1], [2, 2]]), ts: i * 10 }));
    }
    // 600 samples total: the batch flushes exactly once at the 512 threshold;
    // the remaining 88 stay pending for the next transactions.
    const a = audios(snaps);
    expect(a.length).toBe(1);
    expect(a[0].samples.length).toBe(512);
  });

  it('rejoins PCM frames split across transactions (device ticks split mid-frame)', () => {
    const { per, snaps } = fixture();
    // One stereo frame (4 bytes) split 3+1 across two transactions, repeated
    // until the batch threshold flushes: every sample must decode in order.
    const frames: [number, number][] = [[32767, 32767]];
    const whole = s16Stereo(frames);
    for (let i = 0; i < 512; i++) {
      per.onTransaction(i2sTx({ rate: 16000, pcm: whole.slice(0, 3) }));
      per.onTransaction(i2sTx({ rate: 16000, pcm: whole.slice(3) }));
    }
    const a = audios(snaps);
    expect(a.length).toBe(1);
    expect(a[0].samples.length).toBe(512);
    expect(a[0].samples.every((s) => s > 0.99)).toBe(true);
  });

  it('flushes pending samples at the old rate when the format changes', () => {
    const { per, snaps } = fixture();
    per.onTransaction(i2sTx({ rate: 16000, pcm: s16Stereo([[1, 1]]) }));
    expect(audios(snaps)).toEqual([]); // below the batch threshold
    per.onTransaction(i2sTx({ rate: 8000, pcm: s16Stereo([[2, 2]]) }));
    const a = audios(snaps);
    expect(a.length).toBe(1);
    expect(a[0].sampleRate).toBe(16000); // the flush keeps the pre-change rate
    expect(a[0].samples.length).toBe(1);
  });

  it('ignores non-i2s kinds, reads and malformed payloads', () => {
    const { per, snaps } = fixture();
    per.onTransaction(i2sTx({ rate: 16000, pcm: s16Stereo([[1, 1]]), kind: 'spi' }));
    per.onTransaction(i2sTx({ rate: 16000, pcm: s16Stereo([[1, 1]]), dir: 'read' }));
    per.onTransaction({ kind: 'i2s', bus: 0, dir: 'write', ts: 1, data: Uint8Array.from([1, 2]) });
    expect(snaps).toEqual([]);
  });

  it('keeps emitting for a continuous stream (no dedupe across chunks)', () => {
    const { per, snaps } = fixture();
    for (let i = 0; i < 5; i++) {
      const frames: [number, number][] = Array.from({ length: 512 }, () => [i, i]);
      per.onTransaction(i2sTx({ rate: 16000, pcm: s16Stereo(frames), ts: i * 10 }));
    }
    expect(audios(snaps).length).toBe(5);
  });

  it('exposes the i2s-data-in pin and bus default used by routing', () => {
    expect(speakerFactory.pins.some((p) => p.role === 'i2s-data-in')).toBe(true);
    expect(speakerFactory.defaults?.bus).toBe(0);
  });
});
