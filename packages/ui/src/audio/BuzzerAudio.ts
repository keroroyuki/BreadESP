// PRD: §F-PER-5, §9 — Buzzer WebAudio synthesis (dev-plan task P2.3).
// 'tone' snapshots ({freqHz, duty}) drive one square-wave OscillatorNode per
// buzzer instance through a per-instance GainNode (the duty scales the gain:
// perceived loudness of a square wave tracks its high-time fraction).
//
// Split for testability (same pattern as TftRenderer): `toneFromSnapshot` is
// the pure mapping exercised in Node; `BuzzerToneEngine` binds it to a minimal
// AudioContext surface (`AudioContextLike`) so tests run against a stub with
// no DOM, while the browser path lazily builds the real context (autoplay
// policy: the context starts suspended until the first user gesture —
// `attachGestureResume` resumes it on pointerdown).
import type { RenderSnapshot } from '@breadesp/peripherals';

export interface ToneParams {
  freqHz: number;
  duty: number; // 0..1
}

/** Pure mapping: snapshot -> tone params, or null when not a tone snapshot. */
export function toneFromSnapshot(snap: RenderSnapshot | undefined): ToneParams | null {
  if (!snap || snap.type !== 'tone') return null;
  const p = snap.payload as Partial<{ freqHz: unknown; duty: unknown }>;
  if (typeof p.freqHz !== 'number' || typeof p.duty !== 'number') return null;
  if (!Number.isFinite(p.freqHz) || !Number.isFinite(p.duty)) return null;
  return { freqHz: p.freqHz, duty: Math.min(1, Math.max(0, p.duty)) };
}

/** A tone is sounding iff it has a positive frequency and non-zero duty. */
export function isSounding(tone: ToneParams | null): tone is ToneParams {
  return tone !== null && tone.freqHz > 0 && tone.duty > 0;
}

// --- Minimal WebAudio surface (subset of the DOM types, stub-friendly). ---
export interface AudioParamLike {
  value: number;
}

export interface OscillatorNodeLike {
  type: string;
  frequency: AudioParamLike;
  connect(target: unknown): void;
  start(): void;
  stop(): void;
}

export interface GainNodeLike {
  gain: AudioParamLike;
  connect(target: unknown): void;
}

export interface AudioContextLike {
  readonly destination: unknown;
  readonly state?: string;
  createOscillator(): OscillatorNodeLike;
  createGain(): GainNodeLike;
  resume?(): Promise<unknown> | unknown;
}

/** Minimal event-target surface for the gesture hook (Window-compatible). */
export interface GestureTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

interface Voice {
  osc: OscillatorNodeLike;
  gain: GainNodeLike;
}

export interface BuzzerToneEngineOptions {
  /** Full-scale gain of a 100%-duty tone (kept low: square waves are harsh). */
  volume?: number;
}

/**
 * Owns one shared AudioContext and one square-wave voice per buzzer instance.
 * `update` is idempotent: repeated steady-tone snapshots only restate the
 * oscillator frequency/gain (cheap param writes, no node churn).
 */
export class BuzzerToneEngine {
  private readonly createContext: () => AudioContextLike | null;
  private readonly volume: number;
  private ctx: AudioContextLike | null | undefined; // undefined = not yet attempted
  private voices = new Map<string, Voice>();

  constructor(createContext: () => AudioContextLike | null, options: BuzzerToneEngineOptions = {}) {
    this.createContext = createContext;
    this.volume = options.volume ?? 0.08;
  }

  /** The shared context, created on first use (null when unavailable). */
  context(): AudioContextLike | null {
    if (this.ctx === undefined) this.ctx = this.createContext();
    return this.ctx;
  }

  /** Apply the latest tone of one instance (null/inaudible = silence it). */
  update(instanceId: string, tone: ToneParams | null): void {
    const sounding = isSounding(tone);
    const voice = sounding ? this.voice(instanceId) : this.voices.get(instanceId);
    if (!voice) return; // silencing a never-started voice: nothing to do
    if (sounding && tone) {
      voice.osc.frequency.value = tone.freqHz;
      voice.gain.gain.value = this.volume * tone.duty;
    } else {
      voice.gain.gain.value = 0;
    }
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
      voice.gain.gain.value = 0;
      try {
        voice.osc.stop();
      } catch {
        // A voice whose context vanished may throw on stop; teardown continues.
      }
    }
    this.voices.clear();
  }

  private voice(instanceId: string): Voice | undefined {
    const existing = this.voices.get(instanceId);
    if (existing) return existing;
    const ctx = this.context();
    if (!ctx) return undefined;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    const voice: Voice = { osc, gain };
    this.voices.set(instanceId, voice);
    return voice;
  }
}

// --- Browser binding (lazy; tests never touch this path). ---
let shared: BuzzerToneEngine | undefined;

/** The app-wide engine, bound to the real AudioContext on first use. */
export function sharedBuzzerEngine(): BuzzerToneEngine {
  if (!shared) {
    shared = new BuzzerToneEngine(() => {
      if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') {
        return null;
      }
      return new window.AudioContext();
    });
    if (typeof window !== 'undefined') shared.attachGestureResume(window);
  }
  return shared;
}
