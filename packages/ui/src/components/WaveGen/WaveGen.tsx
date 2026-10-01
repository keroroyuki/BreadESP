// PRD: §F-PER-7 — Waveform generator panel (dev-plan task P3.3).
// One editor card per mic instance on the breadboard: waveform
// (sine/square/noise/silence), frequency, amplitude and the I2S format
// (sample rate, bit depth, channels). Edits merge into the instance's netlist
// props via projectStore.updatePeripheralProps — a logic-only edit whose
// netlist identity change re-fires App's bb:applyNetlist effect, so the
// Bridge rebuilds the mic with the new synth config (no dedicated IPC).
// Unlike capture (P3.2), the generator config persists in netlist.json.
// All normalization/preview math lives in ./wavegenDraft (pure, unit-tested).
import { useEffect, useRef } from 'react';
import { MIC_LIMITS, type MicConfig, type MicWaveform } from '@breadesp/peripherals';
import { useProjectStore } from '../../store/projectStore';
import { useCaptureStore } from '../../store/captureStore';
import { useT } from '../../i18n';
import { draftFromProps, draftPatch, previewTrace, renderWavePreview } from './wavegenDraft';

const PREVIEW_W = 260;
const PREVIEW_H = 56;

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
    <div style={card}>
      <div style={cardTitle}>{instanceId}</div>
      <canvas
        ref={canvasRef}
        width={PREVIEW_W}
        height={PREVIEW_H}
        style={{ width: PREVIEW_W, height: PREVIEW_H, display: 'block', borderRadius: 4 }}
      />
      {capturing && <div style={note}>{t('wavegen.captureNote')}</div>}

      <label style={row}>
        <span style={lbl}>{t('wavegen.waveform')}</span>
        <select
          value={draft.waveform}
          onChange={(e) => {
            // Boundary: the option values below are exactly the MicWaveform members.
            apply({ waveform: e.target.value as MicWaveform });
          }}
        >
          {MIC_LIMITS.waveforms.map((w) => (
            <option key={w} value={w}>{w}</option>
          ))}
        </select>
      </label>

      <label style={row}>
        <span style={lbl}>{t('wavegen.frequency')}</span>
        <input
          type="number"
          min={MIC_LIMITS.freqHz.min}
          max={MIC_LIMITS.freqHz.max}
          value={draft.freqHz}
          onChange={(e) => applyNumber(e.target.value, 'freqHz')}
          style={num}
        />
        <span style={unit}>Hz</span>
      </label>

      <label style={row}>
        <span style={lbl}>{t('wavegen.amplitude')}</span>
        <input
          type="range"
          min={MIC_LIMITS.amplitude.min}
          max={MIC_LIMITS.amplitude.max}
          step={0.05}
          value={draft.amplitude}
          onChange={(e) => apply({ amplitude: Number(e.target.value) })}
          style={{ flex: 1 }}
        />
        <span style={unit}>{Math.round(draft.amplitude * 100)}%</span>
      </label>

      <label style={row}>
        <span style={lbl}>{t('wavegen.sampleRate')}</span>
        <input
          type="number"
          min={MIC_LIMITS.sampleRate.min}
          max={MIC_LIMITS.sampleRate.max}
          step={1000}
          value={draft.sampleRate}
          onChange={(e) => applyNumber(e.target.value, 'sampleRate')}
          style={num}
        />
        <span style={unit}>Hz</span>
      </label>

      <label style={row}>
        <span style={lbl}>{t('wavegen.bitDepth')}</span>
        <select
          value={String(draft.bits)}
          onChange={(e) => apply({
            // Boundary: the option values below are exactly MIC_LIMITS.bits members.
            bits: Number(e.target.value) as MicConfig['bits'],
          })}
        >
          {MIC_LIMITS.bits.map((b) => (
            <option key={b} value={b}>{b}-bit</option>
          ))}
        </select>
      </label>

      <label style={row}>
        <span style={lbl}>{t('wavegen.channels')}</span>
        <select
          value={String(draft.channels)}
          onChange={(e) => apply({
            // Boundary: the option values below are exactly MIC_LIMITS.channels members.
            channels: Number(e.target.value) as MicConfig['channels'],
          })}
        >
          <option value={1}>{t('wavegen.mono')}</option>
          <option value={2}>{t('wavegen.stereo')}</option>
        </select>
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
    <div style={{ flex: 1, width: '100%', boxSizing: 'border-box', padding: 8, overflowY: 'auto' }}>
      <h3 style={h3}>{t('wavegen.title')}</h3>
      {mics.length === 0 && <div style={muted}>{t('wavegen.empty')}</div>}
      {mics.map((p) => (
        <MicWavegenCard key={p.instanceId} instanceId={p.instanceId} props={p.props} />
      ))}
    </div>
  );
}

const h3: React.CSSProperties = { margin: '0 0 8px', fontSize: 13 };
const muted: React.CSSProperties = { color: '#999', fontSize: 12 };
const card: React.CSSProperties = { marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid #e2e8f0' };
const cardTitle: React.CSSProperties = { fontSize: 11, color: '#475569', marginBottom: 4 };
const note: React.CSSProperties = { fontSize: 11, color: '#b45309', margin: '4px 0' };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12 };
const lbl: React.CSSProperties = { width: 76, color: '#334155' };
const num: React.CSSProperties = { width: 80, padding: 2 };
const unit: React.CSSProperties = { color: '#94a3b8', fontSize: 11 };
