// PRD: §F-PER-7 — Waveform generator panel (dev-plan task P3.3).
// One editor card per mic instance on the breadboard: waveform
// (sine/square/noise/silence), frequency, amplitude and the I2S format
// (sample rate, bit depth, channels). Edits merge into the instance's netlist
// props via projectStore.updatePeripheralProps — a logic-only edit whose
// netlist identity change re-fires App's bb:applyNetlist effect, so the
// Bridge rebuilds the mic with the new synth config (no dedicated IPC).
// Unlike capture (P3.2), the generator config persists in netlist.json.
// All normalization/preview math lives in ./wavegenDraft (pure, unit-tested).
//
// Presentation follows the shared control vocabulary: the card is a fieldset of
// label/control rows so a 300 px dock column scans as "one knob per line".
import { useEffect, useRef } from 'react';
import { MIC_LIMITS, type MicConfig, type MicWaveform } from '@breadesp/peripherals';
import { useProjectStore } from '../../store/projectStore';
import { useCaptureStore } from '../../store/captureStore';
import { useT, type MessageKey } from '../../i18n';
import { Select } from '../ui/Select';
import { draftFromProps, draftPatch, previewTrace, renderWavePreview } from './wavegenDraft';

const PREVIEW_W = 260;
const PREVIEW_H = 56;

/** Waveform id → localized label (unknown ids fall through verbatim). */
const WAVE_KEYS: Record<string, MessageKey> = {
  sine: 'wavegen.wave.sine',
  square: 'wavegen.wave.square',
  noise: 'wavegen.wave.noise',
  silence: 'wavegen.wave.silence',
};

const rowCls = 'flex items-center gap-2 text-xs text-bb-ink';
const labelCls = 'w-[68px] shrink-0 text-bb-muted';
const numCls =
  'h-6 w-[74px] rounded border border-bb-line bg-white px-1.5 font-mono text-xs text-bb-ink focus:border-bb-primary focus:outline-none';

function MicWavegenCard({ instanceId, props }: { instanceId: string; props?: Record<string, unknown> }) {
  const updatePeripheralProps = useProjectStore((s) => s.updatePeripheralProps);
  const capturing = useCaptureStore((s) => s.capturing[instanceId] === true);
  const t = useT();
  const draft = draftFromProps(props);
  const samples = previewTrace(draft);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvasRef.current) renderWavePreview(canvasRef.current, samples);
  }, [samples]);

  /** Merge one edited field into the draft and push the whole editable subset. */
  const apply = (patch: Partial<MicConfig>): void => {
    updatePeripheralProps(instanceId, draftPatch({ ...draft, ...patch }));
  };
  const applyNumber = (raw: string, field: 'freqHz' | 'sampleRate'): void => {
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) return; // empty/garbage input: keep the last valid value
    if (field === 'freqHz') apply({ freqHz: v });
    else apply({ sampleRate: v });
  };

  return (
    <div className="mb-3 flex flex-col gap-1.5 rounded-md border border-bb-line bg-white p-2 last:mb-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-mono text-[11px] font-medium text-bb-ink" title={instanceId}>
          {instanceId}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-bb-muted">
          {draft.freqHz} Hz · {draft.sampleRate / 1000}k
        </span>
      </div>

      {/* Fixed intrinsic size: the preview is drawn at 260×56, so CSS-stretching
          it to the column would blur the trace instead of sharpening it. */}
      <canvas
        ref={canvasRef}
        width={PREVIEW_W}
        height={PREVIEW_H}
        className="mx-auto block rounded border border-bb-line bg-slate-50"
        style={{ width: PREVIEW_W, height: PREVIEW_H }}
      />
      {capturing && <div className="text-[11px] text-bb-warn">{t('wavegen.captureNote')}</div>}

      <label className={rowCls}>
        <span className={labelCls}>{t('wavegen.waveform')}</span>
        <Select
          block
          value={draft.waveform}
          onChange={(e) => {
            // Boundary: the option values below are exactly the MicWaveform members.
            apply({ waveform: e.target.value as MicWaveform });
          }}
        >
          {MIC_LIMITS.waveforms.map((w) => {
            const key = WAVE_KEYS[w];
            return <option key={w} value={w}>{key === undefined ? w : t(key)}</option>;
          })}
        </Select>
      </label>

      <label className={rowCls}>
        <span className={labelCls}>{t('wavegen.frequency')}</span>
        <input
          type="number"
          min={MIC_LIMITS.freqHz.min}
          max={MIC_LIMITS.freqHz.max}
          value={draft.freqHz}
          onChange={(e) => applyNumber(e.target.value, 'freqHz')}
          className={numCls}
        />
        <span className="text-[11px] text-bb-muted">Hz</span>
      </label>

      <label className={rowCls}>
        <span className={labelCls}>{t('wavegen.amplitude')}</span>
        <input
          type="range"
          min={MIC_LIMITS.amplitude.min}
          max={MIC_LIMITS.amplitude.max}
          step={0.05}
          value={draft.amplitude}
          onChange={(e) => apply({ amplitude: Number(e.target.value) })}
          className="min-w-0 flex-1 accent-bb-primary"
        />
        <span className="w-9 shrink-0 text-right font-mono text-[11px] text-bb-muted">
          {Math.round(draft.amplitude * 100)}%
        </span>
      </label>

      <label className={rowCls}>
        <span className={labelCls}>{t('wavegen.sampleRate')}</span>
        <input
          type="number"
          min={MIC_LIMITS.sampleRate.min}
          max={MIC_LIMITS.sampleRate.max}
          step={1000}
          value={draft.sampleRate}
          onChange={(e) => applyNumber(e.target.value, 'sampleRate')}
          className={numCls}
        />
        <span className="text-[11px] text-bb-muted">Hz</span>
      </label>

      <label className={rowCls}>
        <span className={labelCls}>{t('wavegen.bitDepth')}</span>
        <Select
          value={String(draft.bits)}
          onChange={(e) => apply({
            // Boundary: the option values below are exactly MIC_LIMITS.bits members.
            bits: Number(e.target.value) as MicConfig['bits'],
          })}
        >
          {MIC_LIMITS.bits.map((b) => (
            <option key={b} value={b}>{b}-bit</option>
          ))}
        </Select>
      </label>

      <label className={rowCls}>
        <span className={labelCls}>{t('wavegen.channels')}</span>
        <Select
          value={String(draft.channels)}
          onChange={(e) => apply({
            // Boundary: the option values below are exactly MIC_LIMITS.channels members.
            channels: Number(e.target.value) as MicConfig['channels'],
          })}
        >
          <option value={1}>{t('wavegen.mono')}</option>
          <option value={2}>{t('wavegen.stereo')}</option>
        </Select>
      </label>
    </div>
  );
}

export function WaveGen() {
  // Select the stable peripherals array (inline filter would re-render forever).
  const peripherals = useProjectStore((s) => s.netlist.peripherals);
  const mics = peripherals.filter((p) => p.kind === 'mic');
  const t = useT();

  return (
    <div className="flex h-full w-full min-w-0 flex-col gap-2 overflow-y-auto p-2">
      <h3 className="m-0 text-xs font-semibold text-bb-ink">{t('wavegen.title')}</h3>
      {mics.length === 0 && <div className="text-[11px] text-bb-muted">{t('wavegen.empty')}</div>}
      {mics.map((p) => (
        <MicWavegenCard key={p.instanceId} instanceId={p.instanceId} props={p.props} />
      ))}
    </div>
  );
}
