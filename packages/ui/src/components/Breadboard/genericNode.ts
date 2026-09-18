// PRD: §F-EXT-1, §6.4 — Generic breadboard node body for peripheral kinds
// without a bespoke renderer (dev-plan P5.1). A third-party peripheral shows
// up on the canvas the moment it is registered: pins and wiring come from the
// factory contract, and this module turns its latest snapshot into a neutral
// lamp + one-line status so the model's state is visible without custom UI.
import type { RenderSnapshot } from '@breadesp/peripherals';

export interface GenericNodeStatus {
  /**
   * Lamp intensity 0..1, or null when the snapshot type has no level-like
   * state (the node then shows an inactive lamp).
   */
  lamp: number | null;
  /** One-line status text under the lamp. */
  text: string;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Max status line length; longer text is ellipsized so the node never overflows. */
const MAX_TEXT = 20;

function truncate(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`;
}

/** Map any snapshot to a neutral lamp + status line for the generic node body. */
export function describeGenericSnapshot(snap: RenderSnapshot | undefined): GenericNodeStatus {
  if (snap === undefined) return { lamp: null, text: 'no data' };
  switch (snap.type) {
    case 'level': {
      const { level } = snap.payload as { level: number };
      const lamp = Number.isFinite(level) ? clamp01(level) : 0;
      return { lamp, text: `${Math.round(lamp * 100)}%` };
    }
    case 'tone': {
      const { freqHz, duty } = snap.payload as { freqHz: number; duty: number };
      const on = freqHz > 0 && duty > 0;
      return { lamp: on ? clamp01(duty) : 0, text: on ? `${Math.round(freqHz)} Hz` : 'silent' };
    }
    case 'text':
      return { lamp: null, text: truncate((snap.payload as { text: string }).text) };
    case 'pixels': {
      const p = snap.payload as { width: number; height: number; format: string };
      return { lamp: null, text: `${p.width}x${p.height} ${p.format}` };
    }
    case 'audio': {
      const p = snap.payload as { samples: number[]; sampleRate: number };
      return { lamp: p.samples.length > 0 ? 1 : 0, text: `${(p.sampleRate / 1000).toFixed(1)} kHz` };
    }
    case 'waveform': {
      const p = snap.payload as { channels?: unknown[] };
      const n = Array.isArray(p.channels) ? p.channels.length : 0;
      return { lamp: null, text: n > 0 ? `${n} ch` : 'waveform' };
    }
    default:
      // Unknown future snapshot type (additive §6.4 union): stay renderable.
      return { lamp: null, text: snap.type };
  }
}
