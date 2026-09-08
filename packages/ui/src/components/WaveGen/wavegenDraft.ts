// PRD: §F-PER-7 — Waveform generator draft + preview helpers (dev-plan task P3.3).
// Pure module (no React/store imports) so the panel logic is unit-testable
// under plain Node; the WaveGen component is a thin wiring layer over this.
// Normalization deliberately delegates to the mic model's own
// micConfigFromProps/MIC_LIMITS — the panel can never offer a configuration
// the model would reject.
import { micConfigFromProps, waveformSample, type MicConfig } from '@breadesp/peripherals';

/** Normalize a mic instance's netlist props into a full draft (model semantics/clamps). */
export function draftFromProps(props?: Record<string, unknown>): MicConfig {
  return micConfigFromProps(props);
}

/**
 * The panel-editable subset as a netlist props patch. `bus`/`chunkMs` are
 * deliberately excluded: the store merge preserves their persisted/default
 * values.
 */
export function draftPatch(draft: MicConfig): Record<string, unknown> {
  const { waveform, freqHz, amplitude, sampleRate, bits, channels } = draft;
  return { waveform, freqHz, amplitude, sampleRate, bits, channels };
}

/** Deterministic preview noise (xorshift32, local seed — independent of the model's stream). */
function previewNoise(seed = 0x2f6e2b1): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    // Map uint32 onto [-1, 1).
    return ((state >>> 0) / 0x100000000) * 2 - 1;
  };
}

/**
 * Preview samples in [-1, 1] of the configured waveform over a fixed
 * wall-time window, so frequency changes are visible (unlike a
 * normalized-period preview, where only waveform/amplitude would show).
 */
export function previewTrace(cfg: MicConfig, windowMs = 5, samples = 96): number[] {
  const n = Math.max(2, Math.round(samples));
  const noise = previewNoise();
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const tSec = (i / (n - 1)) * (windowMs / 1000);
    const phase = (tSec * cfg.freqHz) % 1;
    out.push(waveformSample(cfg, phase, noise));
  }
  return out;
}

/**
 * Canvas binding: dark background, dim center line, one polyline trace.
 * Exported for the recording-2d-context unit tests (traceBuilder precedent).
 */
export function renderWavePreview(canvas: HTMLCanvasElement, samples: readonly number[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = '#0b1120';
  ctx.fillRect(0, 0, w, h);
  // Center line (zero level).
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  if (samples.length < 2) return;
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  samples.forEach((s, i) => {
    const x = (i / (samples.length - 1)) * w;
    const clamped = Math.min(1, Math.max(-1, s));
    const y = h / 2 - clamped * (h / 2 - 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}
