// PRD: §F-PER-7, §6.6 — MicCapture engine (dev-plan task P3.2): getUserMedia +
// ScriptProcessor tap per mic instance, mono chunks at the context rate pushed
// to the injected emit. Runs against stub media/WebAudio surfaces (no DOM).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MicCaptureEngine,
  type CaptureContextLike,
  type CaptureNodeLike,
  type CaptureProcessorLike,
  type MediaStreamLike,
  type MicChunk,
} from '../src/audio/MicCapture';

interface StubNode extends CaptureNodeLike {
  connections: unknown[];
  disconnected: boolean;
}

function makeNode(): StubNode {
  return {
    connections: [],
    disconnected: false,
    connect(target: unknown) {
      this.connections.push(target);
    },
    disconnect() {
      this.disconnected = true;
    },
  };
}

interface StubProcessor extends StubNode {
  onaudioprocess: CaptureProcessorLike['onaudioprocess'];
  fire(samples: number[]): void;
}

function makeProcessor(): StubProcessor {
  return {
    ...makeNode(),
    onaudioprocess: null,
    fire(samples: number[]) {
      this.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
    },
  };
}

function makeStream(): MediaStreamLike & { tracks: { stop: ReturnType<typeof vi.fn> }[] } {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  return { tracks, getTracks: () => tracks };
}

function makeContext(sampleRate = 48000) {
  const destination = { id: 'destination' };
  const source = makeNode();
  const processor = makeProcessor();
  const mute = { ...makeNode(), gain: { value: 1 } };
  const ctx: CaptureContextLike & {
    source: StubNode;
    processor: StubProcessor;
    mute: StubNode & { gain: { value: number } };
    closed: boolean;
  } = {
    sampleRate,
    destination,
    source,
    processor,
    mute,
    closed: false,
    createMediaStreamSource: () => source,
    createScriptProcessor: () => processor,
    createGain: () => mute,
    close() {
      this.closed = true;
    },
  };
  return ctx;
}

function fixture(env?: { getUserMedia?: () => Promise<MediaStreamLike>; createContext?: () => CaptureContextLike | null }) {
  const emitted: { instanceId: string; chunk: MicChunk }[] = [];
  const ctx = makeContext();
  const stream = makeStream();
  const getUserMedia = env?.getUserMedia ?? vi.fn().mockResolvedValue(stream);
  const createContext = env?.createContext ?? (() => ctx);
  const engine = new MicCaptureEngine(
    { getUserMedia, createContext },
    { emit: (instanceId, chunk) => emitted.push({ instanceId, chunk }) },
  );
  return { engine, emitted, ctx, stream, getUserMedia };
}

describe('MicCaptureEngine (P3.2, PRD §F-PER-7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('wires source -> processor -> zero-gain mute -> destination on start', async () => {
    const { engine, ctx, stream } = fixture();
    await engine.start('mic1');
    expect(engine.isCapturing('mic1')).toBe(true);
    expect(ctx.mute.gain.value).toBe(0); // never play the local mic back (feedback)
    expect(ctx.source.connections).toEqual([ctx.processor]);
    expect(ctx.processor.connections).toEqual([ctx.mute]);
    expect(ctx.mute.connections).toEqual([ctx.destination]);
    expect(ctx.processor.onaudioprocess).not.toBeNull();
    expect(stream.tracks.every((t) => t.stop.mock.calls.length === 0)).toBe(true);
  });

  it('emits mono chunks tagged with the instance at the context rate', async () => {
    const { engine, emitted, ctx } = fixture();
    await engine.start('mic1');
    ctx.processor.fire([0.1, -0.2, 0.3]);
    expect(emitted).toEqual([{ instanceId: 'mic1', chunk: { samples: [0.1, -0.2, 0.3], rate: 48000 } }]);
  });

  it('keeps one session per instance (start is idempotent)', async () => {
    const { engine, getUserMedia } = fixture();
    await engine.start('mic1');
    await engine.start('mic1');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('tracks multiple instances independently', async () => {
    const created: ReturnType<typeof makeContext>[] = [];
    const stream = makeStream();
    const emitted: { instanceId: string; chunk: MicChunk }[] = [];
    const engine = new MicCaptureEngine(
      {
        getUserMedia: vi.fn().mockResolvedValue(stream),
        createContext: () => {
          const ctx = makeContext(created.length === 0 ? 48000 : 44100);
          created.push(ctx);
          return ctx;
        },
      },
      { emit: (instanceId, chunk) => emitted.push({ instanceId, chunk }) },
    );
    await engine.start('mic1');
    await engine.start('mic2');
    expect(created.length).toBe(2);
    created[0].processor.fire([0.1]);
    created[1].processor.fire([0.2]);
    // Each instance's chunks carry their own id and context rate.
    expect(emitted).toEqual([
      { instanceId: 'mic1', chunk: { samples: [0.1], rate: 48000 } },
      { instanceId: 'mic2', chunk: { samples: [0.2], rate: 44100 } },
    ]);
    engine.stop('mic1');
    expect(engine.isCapturing('mic1')).toBe(false);
    expect(engine.isCapturing('mic2')).toBe(true);
    created[1].processor.fire([0.3]); // mic2 keeps streaming after mic1 stops
    expect(emitted[2]).toEqual({ instanceId: 'mic2', chunk: { samples: [0.3], rate: 44100 } });
    engine.dispose();
    expect(engine.isCapturing('mic2')).toBe(false);
  });

  it('propagates a getUserMedia rejection without starting a session', async () => {
    const { engine } = fixture({ getUserMedia: vi.fn().mockRejectedValue(new Error('denied')) });
    await expect(engine.start('mic1')).rejects.toThrow('denied');
    expect(engine.isCapturing('mic1')).toBe(false);
  });

  it('releases the mic stream when no AudioContext is available', async () => {
    const { engine, stream } = fixture({ createContext: () => null });
    await expect(engine.start('mic1')).rejects.toThrow('AudioContext unavailable');
    expect(engine.isCapturing('mic1')).toBe(false);
    expect(stream.tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
  });

  it('stop disconnects the graph, stops tracks and closes the context', async () => {
    const { engine, ctx, stream } = fixture();
    await engine.start('mic1');
    engine.stop('mic1');
    expect(engine.isCapturing('mic1')).toBe(false);
    expect(ctx.source.disconnected).toBe(true);
    expect(ctx.processor.disconnected).toBe(true);
    expect(ctx.mute.disconnected).toBe(true);
    expect(stream.tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
    expect(ctx.closed).toBe(true);
    // Stopping again is a no-op.
    engine.stop('mic1');
    expect(stream.tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
  });

  it('dispose tears down every live session', async () => {
    const { engine, ctx, stream } = fixture();
    await engine.start('mic1');
    engine.dispose();
    expect(engine.isCapturing('mic1')).toBe(false);
    expect(ctx.closed).toBe(true);
    expect(stream.tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
  });
});
