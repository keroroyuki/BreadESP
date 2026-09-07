// PRD: §F-PER-7, §6.6 — Local microphone capture (dev-plan task P3.2).
// Captures the host microphone with getUserMedia + WebAudio and forwards mono
// Float32 chunks (at the AudioContext's native rate) per mic instance towards
// the Bridge (`per:captureChunk`), where the mic model resamples them into
// I2sInjection frames. A ScriptProcessorNode taps the stream; it is wired
// through a zero-gain mute node to the destination because a ScriptProcessor
// only runs while connected — and the mute keeps the local mic from playing
// back through the speakers (feedback).
//
// Split for testability (same pattern as SpeakerAudio): `MicCaptureEngine`
// binds to a minimal capture surface (`CaptureEnvironment`) so tests run
// against stubs with no DOM, while the browser path lazily resolves the real
// `navigator.mediaDevices` / `AudioContext` in `sharedMicCapture()`.
// The engine never imports the IPC bridge — the caller injects `emit`.

/** One captured chunk: mono samples in [-1, 1] at the context's rate. */
export interface MicChunk {
  samples: number[];
  rate: number;
}

// --- Minimal capture surface (subset of the DOM types, stub-friendly). ---
export interface MediaStreamLike {
  getTracks(): { stop(): void }[];
}

export interface CaptureNodeLike {
  connect(target: unknown): void;
  disconnect(): void;
}

export interface CaptureProcessorLike extends CaptureNodeLike {
  onaudioprocess: ((e: { inputBuffer: { getChannelData(ch: number): ArrayLike<number> } }) => void) | null;
}

export interface CaptureGainLike extends CaptureNodeLike {
  gain: { value: number };
}

export interface CaptureContextLike {
  readonly sampleRate: number;
  readonly destination: unknown;
  createMediaStreamSource(stream: MediaStreamLike): CaptureNodeLike;
  createScriptProcessor(bufferSize: number, inputs: number, outputs: number): CaptureProcessorLike;
  createGain(): CaptureGainLike;
  close?(): Promise<unknown> | unknown;
}

export interface CaptureEnvironment {
  /** Resolves the host mic stream; rejects when permission is denied/absent. */
  getUserMedia(): Promise<MediaStreamLike>;
  /** Null when the platform has no AudioContext. */
  createContext(): CaptureContextLike | null;
}

export interface MicCaptureEngineOptions {
  /** ScriptProcessor buffer size in frames (per emitted chunk). */
  bufferSize?: number;
  /** Called with each captured chunk, tagged by mic instance. */
  emit: (instanceId: string, chunk: MicChunk) => void;
}

interface Session {
  stream: MediaStreamLike;
  ctx: CaptureContextLike;
  nodes: CaptureNodeLike[];
}

/**
 * Owns one getUserMedia stream + WebAudio tap per mic instance. `start` is
 * idempotent per instance; `stop` tears down the nodes, tracks and context so
 * the OS capture indicator goes out. A `start` rejection always releases the
 * mic stream it acquired.
 */
export class MicCaptureEngine {
  private readonly env: CaptureEnvironment;
  private readonly bufferSize: number;
  private readonly emit: (instanceId: string, chunk: MicChunk) => void;
  private sessions = new Map<string, Session>();

  constructor(env: CaptureEnvironment, options: MicCaptureEngineOptions) {
    this.env = env;
    this.bufferSize = options.bufferSize ?? 2048;
    this.emit = options.emit;
  }

  isCapturing(instanceId: string): boolean {
    return this.sessions.has(instanceId);
  }

  async start(instanceId: string): Promise<void> {
    if (this.sessions.has(instanceId)) return;
    const stream = await this.env.getUserMedia();
    try {
      const ctx = this.env.createContext();
      if (ctx === null) throw new Error('AudioContext unavailable');
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(this.bufferSize, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      processor.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        this.emit(instanceId, { samples: Array.from(data), rate: ctx.sampleRate });
      };
      source.connect(processor);
      processor.connect(mute);
      mute.connect(ctx.destination);
      this.sessions.set(instanceId, { stream, ctx, nodes: [source, processor, mute] });
    } catch (err) {
      for (const track of stream.getTracks()) track.stop();
      throw err;
    }
  }

  stop(instanceId: string): void {
    const session = this.sessions.get(instanceId);
    if (!session) return;
    this.sessions.delete(instanceId);
    for (const node of session.nodes) {
      try {
        node.disconnect();
      } catch {
        // Disconnecting an already-torn-down node may throw; teardown continues.
      }
    }
    for (const track of session.stream.getTracks()) track.stop();
    void session.ctx.close?.();
  }

  /** Stop every session (project close / engine teardown). */
  dispose(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }
}

// --- Browser binding (lazy; tests never touch this path). ---
let shared: MicCaptureEngine | undefined;

/**
 * Wrap a real AudioContext in the minimal capture surface. DOM boundary: the
 * casts here bridge the full DOM types (MediaStream, AudioProcessingEvent)
 * onto the stub-friendly shapes; the runtime objects satisfy both.
 */
function adaptContext(ctx: AudioContext): CaptureContextLike {
  return {
    sampleRate: ctx.sampleRate,
    destination: ctx.destination,
    createMediaStreamSource: (stream) => ctx.createMediaStreamSource(stream as MediaStream),
    createScriptProcessor: (bufferSize, inputs, outputs) => {
      const proc = ctx.createScriptProcessor(bufferSize, inputs, outputs);
      const wrapper: CaptureProcessorLike = {
        connect: (target) => proc.connect(target as AudioNode),
        disconnect: () => proc.disconnect(),
        onaudioprocess: null,
      };
      // Forward the DOM event to the minimal shape the engine consumes.
      Object.defineProperty(wrapper, 'onaudioprocess', {
        set: (cb: CaptureProcessorLike['onaudioprocess']) => {
          proc.onaudioprocess = cb === null ? null : (e) => cb(e);
        },
      });
      return wrapper;
    },
    createGain: () => ctx.createGain(),
    close: () => ctx.close(),
  };
}

/**
 * The app-wide engine, bound to the real capture devices on first use.
 * `emit` is supplied by the caller so this module stays bridge-free (the
 * bridge module throws at import time when no preload ran, e.g. in tests).
 */
export function sharedMicCapture(emit: (instanceId: string, chunk: MicChunk) => void): MicCaptureEngine {
  if (!shared) {
    shared = new MicCaptureEngine(
      {
        getUserMedia: () => {
          if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
            return Promise.reject(new Error('mediaDevices unavailable'));
          }
          return navigator.mediaDevices.getUserMedia({ audio: true });
        },
        createContext: () => {
          if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') {
            return null;
          }
          return adaptContext(new window.AudioContext());
        },
      },
      { emit },
    );
  }
  return shared;
}
