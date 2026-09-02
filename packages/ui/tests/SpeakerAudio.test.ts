// PRD: §F-PER-6, §9 — SpeakerAudio (dev-plan P2.4): the pure snapshot->chunk
// mapping plus the SpeakerPcmEngine scheduling behavior against a stub
// AudioContext (same DOM-free pattern as BuzzerAudio).
import { describe, expect, it } from 'vitest';
import type { RenderSnapshot } from '@breadesp/peripherals';
import {
  audioFromSnapshot,
  SpeakerPcmEngine,
  type AudioBufferLike,
  type BufferSourceNodeLike,
  type PcmAudioContextLike,
} from '../src/audio/SpeakerAudio';

function audioSnap(samples: number[], sampleRate = 16000): RenderSnapshot {
  return { instanceId: 'spk1', type: 'audio', payload: { samples, sampleRate } };
}

describe('audioFromSnapshot (pure mapping)', () => {
  it('maps an audio snapshot to a PCM chunk', () => {
    expect(audioFromSnapshot(audioSnap([0.5, -0.5], 16667))).toEqual({ samples: [0.5, -0.5], sampleRate: 16667 });
  });

  it('returns null for non-audio snapshots and malformed payloads', () => {
    expect(audioFromSnapshot(undefined)).toBeNull();
    expect(audioFromSnapshot({ instanceId: 's', type: 'tone', payload: { freqHz: 440, duty: 0.5 } })).toBeNull();
    expect(audioFromSnapshot({ instanceId: 's', type: 'audio', payload: { samples: 'x', sampleRate: 16000 } } as never)).toBeNull();
    expect(audioFromSnapshot({ instanceId: 's', type: 'audio', payload: { samples: [0.1], sampleRate: 0 } } as never)).toBeNull();
    expect(audioFromSnapshot({ instanceId: 's', type: 'audio', payload: { samples: [0.1, Number.NaN], sampleRate: 16000 } } as never)).toBeNull();
  });
});

// --- Stub WebAudio surface ---------------------------------------------------
class StubBuffer implements AudioBufferLike {
  private data: number[];
  constructor(length: number) {
    this.data = new Array<number>(length).fill(0);
  }
  getChannelData(): { [i: number]: number; length: number } {
    return this.data;
  }
  channel0(): number[] {
    return this.data;
  }
}

class StubSource implements BufferSourceNodeLike {
  buffer: AudioBufferLike | null = null;
  startedAt: number | undefined;
  stopped = false;
  connectedTo: unknown;
  connect(target: unknown): void {
    this.connectedTo = target;
  }
  start(when?: number): void {
    this.startedAt = when;
  }
  stop(): void {
    this.stopped = true;
  }
}

class StubAudioContext implements PcmAudioContextLike {
  readonly destination = { dest: true };
  state = 'running';
  currentTime = 100;
  buffers: { buffer: StubBuffer; channels: number; sampleRate: number }[] = [];
  sources: StubSource[] = [];
  gains: { gain: { value: number }; connectedTo: unknown }[] = [];
  resumed = 0;

  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike {
    const buffer = new StubBuffer(length);
    this.buffers.push({ buffer, channels, sampleRate });
    return buffer;
  }
  createBufferSource(): BufferSourceNodeLike {
    const source = new StubSource();
    this.sources.push(source);
    return source;
  }
  createGain(): { gain: { value: number }; connect(target: unknown): void } {
    const gain = { gain: { value: 0 }, connectedTo: undefined as unknown, connect(target: unknown) { gain.connectedTo = target; } };
    this.gains.push(gain);
    return gain;
  }
  resume(): void {
    this.resumed++;
    this.state = 'running';
  }
}

function engineFixture(volume?: number): { engine: SpeakerPcmEngine; ctx: StubAudioContext } {
  const ctx = new StubAudioContext();
  return { engine: new SpeakerPcmEngine(() => ctx, volume === undefined ? {} : { volume }), ctx };
}

describe('SpeakerPcmEngine (playback scheduling)', () => {
  it('schedules a chunk into a mono buffer at its own sample rate', () => {
    const { engine, ctx } = engineFixture();
    engine.push('spk1', { samples: [0.25, -0.25], sampleRate: 16667 });
    expect(ctx.buffers).toHaveLength(1);
    expect(ctx.buffers[0].channels).toBe(1);
    expect(ctx.buffers[0].sampleRate).toBe(16667);
    expect(ctx.buffers[0].buffer.channel0()).toEqual([0.25, -0.25]);
    expect(ctx.sources[0].connectedTo).toBe(ctx.gains[0]);
    expect(ctx.gains[0].connectedTo).toBe(ctx.destination);
  });

  it('starts the first chunk after the lead time and chains later chunks gap-free', () => {
    const { engine, ctx } = engineFixture();
    engine.push('spk1', { samples: [0, 0, 0, 0], sampleRate: 16000 }); // 250µs
    engine.push('spk1', { samples: [0, 0], sampleRate: 16000 });
    const first = ctx.sources[0].startedAt!;
    expect(first).toBeCloseTo(100.05, 6); // currentTime + lead
    const second = ctx.sources[1].startedAt!;
    expect(second).toBeCloseTo(first + 4 / 16000, 6); // chained at the cursor
  });

  it('keeps an independent cursor per instance', () => {
    const { engine, ctx } = engineFixture();
    engine.push('spk1', { samples: [0, 0], sampleRate: 16000 });
    engine.push('spk2', { samples: [0, 0], sampleRate: 16000 });
    expect(ctx.gains).toHaveLength(2);
    expect(ctx.sources[0].startedAt).toBeCloseTo(ctx.sources[1].startedAt!, 6);
  });

  it('resyncs the cursor after an underrun instead of playing stale audio', () => {
    const { engine, ctx } = engineFixture();
    engine.push('spk1', { samples: [0, 0], sampleRate: 16000 });
    ctx.currentTime += 2; // stream stalled for 2s
    engine.push('spk1', { samples: [0, 0], sampleRate: 16000 });
    expect(ctx.sources[1].startedAt).toBeCloseTo(ctx.currentTime + 0.05, 6);
  });

  it('hard-clips overshoot samples', () => {
    const { engine, ctx } = engineFixture();
    engine.push('spk1', { samples: [2, -2], sampleRate: 16000 });
    expect(ctx.buffers[0].buffer.channel0()).toEqual([1, -1]);
  });

  it('applies the configured volume and is silent when no context exists', () => {
    const { engine, ctx } = engineFixture(0.25);
    engine.push('spk1', { samples: [0], sampleRate: 16000 });
    expect(ctx.gains[0].gain.value).toBe(0.25);

    const silent = new SpeakerPcmEngine(() => null);
    silent.push('spk1', { samples: [0], sampleRate: 16000 }); // must not throw
    expect(silent.context()).toBeNull();
  });

  it('ignores null/empty chunks', () => {
    const { engine, ctx } = engineFixture();
    engine.push('spk1', null);
    engine.push('spk1', { samples: [], sampleRate: 16000 });
    expect(ctx.buffers).toHaveLength(0);
  });

  it('resume() only resumes a suspended context; the gesture hook is one-shot', () => {
    const { engine, ctx } = engineFixture();
    ctx.state = 'suspended';
    engine.resume();
    expect(ctx.resumed).toBe(1);

    const listeners = new Map<string, () => void>();
    const target = {
      addEventListener: (t: string, l: () => void) => listeners.set(t, l),
      removeEventListener: (t: string) => listeners.delete(t),
    };
    engine.attachGestureResume(target);
    ctx.state = 'suspended';
    listeners.get('pointerdown')!();
    expect(ctx.resumed).toBe(2);
    expect(listeners.has('pointerdown')).toBe(false); // removed after the gesture
  });

  it('dispose stops every scheduled source and forgets the voices', () => {
    const { engine, ctx } = engineFixture();
    engine.push('spk1', { samples: [0, 0], sampleRate: 16000 });
    engine.push('spk1', { samples: [0, 0], sampleRate: 16000 });
    engine.dispose();
    expect(ctx.sources.every((s) => s.stopped)).toBe(true);
    // A later push rebuilds the voice from scratch (fresh gain node).
    engine.push('spk1', { samples: [0], sampleRate: 16000 });
    expect(ctx.gains).toHaveLength(2);
  });
});
