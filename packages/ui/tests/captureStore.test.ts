// PRD: §F-PER-7, §6.6 — captureStore (dev-plan task P3.2): capture lifecycle
// state per mic instance. The bridge and the MicCapture module are mocked:
// these tests pin the store's state transitions and the chunk->IPC wiring.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MicChunk } from '../src/audio/MicCapture';

const mocks = vi.hoisted(() => ({
  captureChunk: vi.fn(),
  engine: {
    start: vi.fn(),
    stop: vi.fn(),
    isCapturing: vi.fn(),
    dispose: vi.fn(),
  },
  /** The emit callback the store hands to sharedMicCapture. */
  emitFn: { current: (_instanceId: string, _chunk: MicChunk): void => {} },
}));

vi.mock('../src/ipc/bridge', () => ({ bridge: { per: { captureChunk: mocks.captureChunk } } }));
vi.mock('../src/audio/MicCapture', () => ({
  sharedMicCapture: (emit: (instanceId: string, chunk: MicChunk) => void) => {
    mocks.emitFn.current = emit;
    return mocks.engine;
  },
}));

import { useCaptureStore } from '../src/store/captureStore';

const { captureChunk, engine } = mocks;

beforeEach(() => {
  vi.clearAllMocks();
  captureChunk.mockResolvedValue(undefined);
  engine.start.mockResolvedValue(undefined);
  useCaptureStore.setState({ capturing: {}, error: null });
});

describe('captureStore (P3.2, PRD §F-PER-7)', () => {
  it('startCapture marks the instance capturing and clears the error', async () => {
    useCaptureStore.setState({ error: 'stale' });
    await useCaptureStore.getState().startCapture('mic1');
    expect(engine.start).toHaveBeenCalledWith('mic1');
    expect(useCaptureStore.getState().capturing).toEqual({ mic1: true });
    expect(useCaptureStore.getState().error).toBeNull();
  });

  it('startCapture is idempotent for an already-capturing instance', async () => {
    await useCaptureStore.getState().startCapture('mic1');
    await useCaptureStore.getState().startCapture('mic1');
    expect(engine.start).toHaveBeenCalledTimes(1);
  });

  it('surfaces a start failure as [BB-210] without marking capture active', async () => {
    engine.start.mockRejectedValueOnce(new Error('denied'));
    await useCaptureStore.getState().startCapture('mic1');
    expect(useCaptureStore.getState().capturing).toEqual({});
    expect(useCaptureStore.getState().error).toBe('[BB-210] microphone capture failed: denied');
  });

  it('forwards engine chunks to the Bridge as per:captureChunk', async () => {
    await useCaptureStore.getState().startCapture('mic1');
    mocks.emitFn.current('mic1', { samples: [0.1, -0.1], rate: 48000 });
    expect(captureChunk).toHaveBeenCalledWith({ instanceId: 'mic1', rate: 48000, samples: [0.1, -0.1] });
  });

  it('stopCapture stops the engine session and clears the flag', async () => {
    await useCaptureStore.getState().startCapture('mic1');
    useCaptureStore.getState().stopCapture('mic1');
    expect(engine.stop).toHaveBeenCalledWith('mic1');
    expect(useCaptureStore.getState().capturing).toEqual({});
    // Stopping a non-capturing instance is a no-op.
    useCaptureStore.getState().stopCapture('mic1');
    expect(engine.stop).toHaveBeenCalledTimes(1);
  });

  it('reconcile stops captures whose instance left the netlist', async () => {
    await useCaptureStore.getState().startCapture('mic1');
    await useCaptureStore.getState().startCapture('mic2');
    useCaptureStore.getState().reconcile(new Set(['mic2']));
    expect(engine.stop).toHaveBeenCalledWith('mic1');
    expect(engine.stop).not.toHaveBeenCalledWith('mic2');
    expect(useCaptureStore.getState().capturing).toEqual({ mic2: true });
  });
});
