// PRD: §F-PER-6, §9 — Speaker I2S PCM -> WebAudio playback (dev-plan task P2.4).
// 'audio' snapshots ({samples, sampleRate}) produced by the speaker model are
// scheduled per instance as AudioBufferSourceNodes back-to-back on a playback
// cursor, so a continuous DMA stream becomes a continuous tone.
//
// Split for testability (same pattern as BuzzerAudio/TftRenderer):
// `audioFromSnapshot` is the pure mapping exercised in Node;
// `SpeakerPcmEngine` binds it to a minimal AudioContext surface
// (`PcmAudioContextLike`) so tests run against a stub with no DOM, while the
// browser path lazily builds the real context (autoplay policy: the context
// starts suspended until the first user gesture — `attachGestureResume`
// resumes it on pointerdown).
import type { RenderSnapshot } from '@breadesp/peripherals';

export interface AudioChunk {
  samples: number[]; // mono Float32-range samples
  sampleRate: number;
}

/** Pure mapping: snapshot -> PCM chunk, or null when not an audio snapshot. */
export function audioFromSnapshot(snap: RenderSnapshot | undefined): AudioChunk | null {
  if (!snap || snap.type !== 'audio') return null;
  const p = snap.payload as Partial<{ samples: unknown; sampleRate: unknown }>;
  if (!Array.isArray(p.samples) || typeof p.sampleRate !== 'number') return null;
  if (!Number.isFinite(p.sampleRate) || p.sampleRate <= 0) return null;
  if (p.samples.some((s) => typeof s !== 'number' || !Number.isFinite(s))) return null;
  return { samples: p.samples as number[], sampleRate: p.sampleRate };
}

// --- Minimal WebAudio surface (subset of the DOM types, stub-friendly). ---
export interface AudioBufferLike {
  /** Channel sample storage (index 0; the engine is mono). */
  getChannelData(channel: number): { [i: number]: number; length: number };
}

export interface BufferSourceNodeLike {
  buffer: AudioBufferLike | null;
  connect(target: unknown): void;
  start(when?: number): void;
  stop(): void;
}

export interface SpeakerGainNodeLike {
  gain: { value: number };
  connect(target: unknown): void;
}

export interface PcmAudioContextLike {
  readonly destination: unknown;
  readonly currentTime: number;
  readonly state?: string;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): BufferSourceNodeLike;
  createGain(): SpeakerGainNodeLike;
  resume?(): Promise<unknown> | unknown;
}

/** Minimal event-target surface for the gesture hook (Window-compatible). */
export interface GestureTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface SpeakerPcmEngineOptions {
  /** Playback volume (gain of every instance voice). */
  volume?: number;
  /** Scheduling lead time added to currentTime when (re)starting the cursor. */
  leadSeconds?: number;
  /** A cursor this far behind the clock is treated as underrun and resynced. */
  maxLagSeconds?: number;
}

interface Voice {
  gain: SpeakerGainNodeLike;
  /** End time (ctx clock) of the last scheduled chunk. */
  nextTime: number;
  sources: BufferSourceNodeLike[];
}

/**
 * Owns one shared AudioContext and one playback cursor per speaker instance.
 * `push` appends a chunk to the instance's queue; chunks scheduled at their
 * cursor position play gap-free as long as snapshots keep pace with the
 * AudioContext clock (the sim is near real-time; a stalled stream resyncs
 * once the lag exceeds maxLagSeconds instead of playing stale audio).
 */
export class SpeakerPcmEngine {
  private readonly createContext: () => PcmAudioContextLike | null;
  private readonly volume: number;
  private readonly lead: number;
  private readonly maxLag: number;
  private ctx: PcmAudioContextLike | null | undefined; // undefined = not yet attempted
  private voices = new Map<string, Voice>();

  constructor(createContext: () => PcmAudioContextLike | null, options: SpeakerPcmEngineOptions = {}) {
    this.createContext = createContext;
    this.volume = options.volume ?? 0.5;
    this.lead = options.leadSeconds ?? 0.05;
    this.maxLag = options.maxLagSeconds ?? 0.5;
  }

  /** The shared context, created on first use (null when unavailable). */
  context(): PcmAudioContextLike | null {
    if (this.ctx === undefined) this.ctx = this.createContext();
    return this.ctx;
  }

  /** Queue one PCM chunk for playback (null/empty chunks are ignored). */
  push(instanceId: string, chunk: AudioChunk | null): void {
    if (!chunk || chunk.samples.length === 0) return;
    const ctx = this.context();
    if (!ctx) return;
    const voice = this.voice(ctx, instanceId);

    const buffer = ctx.createBuffer(1, chunk.samples.length, chunk.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < chunk.samples.length; i++) {
      const s = chunk.samples[i];
      data[i] = s > 1 ? 1 : s < -1 ? -1 : s; // hard clip: models may overshoot
    }

    const now = ctx.currentTime;
    // Underrun resync: the cursor ran dry (stream stall or first chunk).
    if (voice.nextTime < now + this.lead - this.maxLag || voice.nextTime < now) {
      voice.nextTime = now + this.lead;
    }
    const startAt = Math.max(voice.nextTime, now + this.lead);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(voice.gain);
    source.start(startAt);
    voice.sources.push(source);
    voice.nextTime = startAt + chunk.samples.length / chunk.sampleRate;
  }

  /**
   * Resume the context after a browser autoplay suspension. Safe to call any
   * time; also invoked by attachGestureResume's one-shot pointerdown hook.
   */
  resume(): void {
    const ctx = this.context();
    if (ctx && ctx.state === 'suspended') void ctx.resume?.();
  }

  /**
   * Browser autoplay policy: an AudioContext created before any user gesture
   * starts suspended. Install a one-shot pointerdown listener that resumes it.
   * Returns an unsubscribe; a no-op when there is no event target.
   */
  attachGestureResume(target: GestureTarget | undefined): () => void {
    if (!target) return () => {};
    const onGesture = (): void => {
      this.resume();
      target.removeEventListener('pointerdown', onGesture);
    };
    target.addEventListener('pointerdown', onGesture);
    return () => target.removeEventListener('pointerdown', onGesture);
  }

  /** Stop every voice and forget them (project close / engine teardown). */
  dispose(): void {
    for (const voice of this.voices.values()) {
      for (const source of voice.sources) {
        try {
          source.stop();
        } catch {
          // A source whose context vanished may throw on stop; teardown continues.
        }
      }
      voice.sources.length = 0;
    }
    this.voices.clear();
  }

  private voice(ctx: PcmAudioContextLike, instanceId: string): Voice {
    const existing = this.voices.get(instanceId);
    if (existing) return existing;
    const gain = ctx.createGain();
    gain.gain.value = this.volume;
    gain.connect(ctx.destination);
    const voice: Voice = { gain, nextTime: 0, sources: [] };
    this.voices.set(instanceId, voice);
    return voice;
  }
}

// --- Browser binding (lazy; tests never touch this path). ---
let shared: SpeakerPcmEngine | undefined;

/** The app-wide engine, bound to the real AudioContext on first use. */
export function sharedSpeakerEngine(): SpeakerPcmEngine {
  if (!shared) {
    shared = new SpeakerPcmEngine(() => {
      if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') {
        return null;
      }
      return new window.AudioContext();
    });
    if (typeof window !== 'undefined') shared.attachGestureResume(window);
  }
  return shared;
}
