// PRD: §F-PER-7, §6.6 — Local mic capture state (dev-plan task P3.2).
// Owns which mic instances are capturing from the host microphone. The actual
// capture lives in audio/MicCapture (getUserMedia + WebAudio); each chunk is
// forwarded to the Bridge via `per:captureChunk`, where the mic model
// resamples and injects it into the firmware's I2S RX DMA. Capture is a
// runtime-only state — it is never persisted to the netlist, so reopening a
// project cannot silently request the microphone.
import { create } from 'zustand';
import { bridge } from '../ipc/bridge';
import { sharedMicCapture } from '../audio/MicCapture';

interface CaptureState {
  /** instanceId -> capturing. Record (not Set) so zustand identity changes render. */
  capturing: Record<string, boolean>;
  /** Last capture failure (permission denied, no device), surfaced in the node hint. */
  error: string | null;
  /** Start host-mic capture for a mic instance (idempotent). */
  startCapture: (instanceId: string) => Promise<void>;
  /** Stop capture; the mic model falls back to its synth waveform. */
  stopCapture: (instanceId: string) => void;
  /** Stop every instance whose id is not in `aliveIds` (netlist edits/close). */
  reconcile: (aliveIds: Set<string>) => void;
}

export const useCaptureStore = create<CaptureState>((set, get) => ({
  capturing: {},
  error: null,

  startCapture: async (instanceId) => {
    if (get().capturing[instanceId]) return;
    const engine = sharedMicCapture((id, chunk) => {
      // Fire-and-forget: the audio callback must not await IPC round-trips.
      void bridge.per.captureChunk({ instanceId: id, rate: chunk.rate, samples: chunk.samples }).catch(() => {});
    });
    try {
      await engine.start(instanceId);
      set({ capturing: { ...get().capturing, [instanceId]: true }, error: null });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      set({ error: `[BB-210] microphone capture failed: ${reason}` });
    }
  },

  stopCapture: (instanceId) => {
    if (!get().capturing[instanceId]) return;
    sharedMicCapture(() => {}).stop(instanceId);
    const capturing = { ...get().capturing };
    delete capturing[instanceId];
    set({ capturing });
  },

  reconcile: (aliveIds) => {
    for (const id of Object.keys(get().capturing)) {
      if (!aliveIds.has(id)) get().stopCapture(id);
    }
  },
}));
