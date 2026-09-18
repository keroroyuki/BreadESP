// PRD: §F-BB-1, §F-BB-2, §F-BB-4 — Breadboard canvas (Konva).
// Interactions: drop from the palette places a peripheral; dragging a node
// moves it (layout-only edit); clicking pin -> pin wires the two endpoints
// (netlist-only edit, applied to the Bridge by App via bb:applyNetlist);
// clicking a wire twice (or Delete) removes it; Esc cancels the pending wire.
import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Circle, Group, Layer, Path, Rect, Stage, Text } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import type { Stage as KonvaStage } from 'konva/lib/Stage';
import { MCU_INSTANCE_ID, type WireEndpoint } from '@breadesp/netlist';
import { useProjectStore } from '../../store/projectStore';
import { useSimulationStore } from '../../store/simulationStore';
import { useCaptureStore } from '../../store/captureStore';
import { bridge } from '../../ipc/bridge';
import { wirePath } from './Wire';
import { adjustSht30 } from './sensorDraft';
import { describeGenericSnapshot } from './genericNode';
import { sht30ConfigFromProps, sht30FormatReading } from '@breadesp/peripherals';
import {
  MCU_GPIO_PINS,
  MCU_NODE,
  NODE_H,
  NODE_W,
  PIN_LABEL_GAP,
  PIN_R,
  mcuPinLayout,
  peripheralPinOffset,
  peripheralPins,
  wireAnchors,
  type Anchor,
} from './pinLayout';

const CANVAS_W = 960;
const CANVAS_H = 560;

interface PendingWire {
  endpoint: WireEndpoint;
  anchor: Anchor;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const endpointLabel = (ep: WireEndpoint): string =>
  `${ep.instanceId === MCU_INSTANCE_ID ? 'MCU' : ep.instanceId}.${ep.pin}`;

/**
 * Kinds with a bespoke canvas body below. Everything else — including any
 * third-party kind registered at runtime (PRD §F-EXT-1, dev-plan P5.1) —
 * gets the generic snapshot-driven body so it is visible without UI code.
 */
const BESPOKE_CANVAS_KINDS: ReadonlySet<string> = new Set([
  'led', 'button', 'buzzer', 'speaker', 'oscilloscope', 'mic', 'knob', 'sht30', 'ssd1306',
]);

export function BreadboardCanvas() {
  const layout = useProjectStore((s) => s.layout);
  const netlist = useProjectStore((s) => s.netlist);
  const addPeripheral = useProjectStore((s) => s.addPeripheral);
  const movePeripheral = useProjectStore((s) => s.movePeripheral);
  const removePeripheral = useProjectStore((s) => s.removePeripheral);
  const addWire = useProjectStore((s) => s.addWire);
  const removeWire = useProjectStore((s) => s.removeWire);
  const updatePeripheralProps = useProjectStore((s) => s.updatePeripheralProps);
  const snapshots = useSimulationStore((s) => s.snapshots);
  // P3.2: which mic instances are capturing host audio (drives REC/LIVE toggle).
  const capturing = useCaptureStore((s) => s.capturing);
  const startCapture = useCaptureStore((s) => s.startCapture);
  const stopCapture = useCaptureStore((s) => s.stopCapture);

  const [pending, setPending] = useState<PendingWire | null>(null);
  const [pointer, setPointer] = useState<Anchor>({ x: 0, y: 0 });
  const [selectedWireId, setSelectedWireId] = useState<string | null>(null);
  const [selectedInstance, setSelectedInstance] = useState<string | null>(null);
  const [hint, setHint] = useState(
    'Drag a peripheral from the palette onto the canvas; click pin -> pin to wire.',
  );
  const stageRef = useRef<KonvaStage | null>(null);

  // Esc cancels the pending wire / selections; Delete removes the selected wire or instance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setPending(null);
        setSelectedWireId(null);
        setSelectedInstance(null);
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedWireId !== null) {
          removeWire(selectedWireId);
          setSelectedWireId(null);
        } else if (selectedInstance !== null) {
          removePeripheral(selectedInstance);
          setSelectedInstance(null);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedWireId, selectedInstance, removeWire, removePeripheral]);

  const clearPending = (msg: string): void => {
    setPending(null);
    setHint(msg);
  };

  const onPinClick =
    (endpoint: WireEndpoint, anchor: Anchor) => (e: KonvaEventObject<MouseEvent>) => {
      e.cancelBubble = true;
      if (pending === null) {
        setPending({ endpoint, anchor });
        setPointer(anchor);
        setHint(`Wiring from ${endpointLabel(endpoint)} — click a target pin (Esc cancels).`);
        return;
      }
      if (pending.endpoint.instanceId === endpoint.instanceId && pending.endpoint.pin === endpoint.pin) {
        clearPending('Wiring cancelled.');
        return;
      }
      if (
        pending.endpoint.instanceId !== MCU_INSTANCE_ID &&
        endpoint.instanceId !== MCU_INSTANCE_ID
      ) {
        clearPending('Peripheral-to-peripheral wires are not routable (MVP) — connect via an MCU pin.');
        return;
      }
      const id = addWire(pending.endpoint, endpoint);
      clearPending(id !== null ? `Wire ${id} created (${endpointLabel(pending.endpoint)} <-> ${endpointLabel(endpoint)}).` : 'Wire already exists.');
    };

  const onStageMouseMove = (e: KonvaEventObject<MouseEvent>): void => {
    if (pending === null) return;
    const p = e.target.getStage()?.getPointerPosition();
    if (p) setPointer({ x: p.x, y: p.y });
  };

  const onBackgroundClick = (): void => {
    if (pending !== null) {
      clearPending('Wiring cancelled.');
      return;
    }
    setSelectedWireId(null);
    setSelectedInstance(null);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    const w = window as unknown as { __bb_drag_kind?: string };
    const kind = w.__bb_drag_kind;
    if (!kind) return;
    w.__bb_drag_kind = undefined;
    // Measure against the Stage container so internal scrolling cannot offset the drop.
    const rect = stageRef.current?.container().getBoundingClientRect();
    if (!rect) return;
    const x = clamp(e.clientX - rect.left, 0, CANVAS_W - NODE_W);
    const y = clamp(e.clientY - rect.top, 0, CANVAS_H - NODE_H);
    const instanceId = addPeripheral(kind, x, y);
    setSelectedInstance(instanceId);
    setHint(`${kind} placed as ${instanceId}. Click its pin, then an MCU GPIO pin, to wire.`);
  };

  const onDragMove = (instanceId: string) => (e: KonvaEventObject<globalThis.DragEvent>): void => {
    movePeripheral(instanceId, e.target.x(), e.target.y());
  };

  const deleteInstance = (instanceId: string): void => {
    removePeripheral(instanceId);
    setSelectedInstance(null);
    setSelectedWireId(null); // the selected wire may have gone with the instance
    setHint(`Removed ${instanceId} (its wires were removed from the netlist).`);
  };

  const onWireClick = (wireId: string) => (e: KonvaEventObject<MouseEvent>): void => {
    e.cancelBubble = true;
    if (selectedWireId === wireId) {
      removeWire(wireId);
      setSelectedWireId(null);
      setHint(`Wire ${wireId} removed.`);
    } else {
      setSelectedWireId(wireId);
      setSelectedInstance(null);
      setHint(`Wire ${wireId} selected — click again or press Delete to remove.`);
    }
  };

  const hoverCursor = (style: string) => (e: KonvaEventObject<MouseEvent>): void => {
    const c = e.target.getStage()?.container();
    if (c) c.style.cursor = style;
  };

  return (
    <div
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
      style={{ flex: 1, overflow: 'auto', background: '#eef2f7' }}
    >
      <Stage ref={stageRef} width={CANVAS_W} height={CANVAS_H} onMouseMove={onStageMouseMove}>
        <Layer>
          <Rect
            x={0}
            y={0}
            width={CANVAS_W}
            height={CANVAS_H}
            fill="#eef2f7"
            onClick={onBackgroundClick}
          />

          {/* Wires (netlist logic) — under the nodes, click to select, click again to remove. */}
          {netlist.wires.map((w) => {
            const a = wireAnchors(w, layout);
            if (a === null) return null; // endpoint not on the canvas (unknown instance/pin)
            const sel = selectedWireId === w.id;
            return (
              <Path
                key={w.id}
                data={wirePath({ x1: a.from.x, y1: a.from.y, x2: a.to.x, y2: a.to.y })}
                stroke={sel ? '#dc2626' : '#475569'}
                strokeWidth={sel ? 3 : 2}
                hitStrokeWidth={10}
                onClick={onWireClick(w.id)}
              />
            );
          })}

          {/* MCU node (fixed position, MVP). */}
          <Group>
            <Rect
              x={MCU_NODE.x}
              y={MCU_NODE.y}
              width={MCU_NODE.w}
              height={MCU_NODE.h}
              fill="#1e3a5f"
              cornerRadius={8}
              stroke="#0f2744"
            />
            <Text
              x={MCU_NODE.x}
              y={MCU_NODE.y + 14}
              width={MCU_NODE.w}
              align="center"
              text="ESP32"
              fill="#cbd5e1"
              fontSize={15}
              fontStyle="bold"
              listening={false}
            />
            {MCU_GPIO_PINS.map((n) => {
              const pin = `GPIO${n}`;
              const l = mcuPinLayout(pin);
              if (l === null) return null;
              const labelX = l.side === 'left' ? MCU_NODE.x + 8 : MCU_NODE.x + MCU_NODE.w - 48;
              return (
                <Group key={pin}>
                  <Circle
                    x={l.anchor.x}
                    y={l.anchor.y}
                    radius={PIN_R}
                    fill="#94a3b8"
                    stroke="#0f2744"
                    strokeWidth={1}
                    onClick={onPinClick({ instanceId: MCU_INSTANCE_ID, pin }, l.anchor)}
                    onMouseEnter={hoverCursor('crosshair')}
                    onMouseLeave={hoverCursor('default')}
                  />
                  <Text
                    x={labelX}
                    y={l.anchor.y - 5}
                    width={40}
                    align={l.side}
                    text={pin}
                    fontSize={9}
                    fill="#cbd5e1"
                    listening={false}
                  />
                </Group>
              );
            })}
          </Group>

          {/* Peripheral instances (layout: position is visual-only, PRD §F-BB-4). */}
          {layout.map((item) => {
            const pins = peripheralPins(item.kind);
            const sel = selectedInstance === item.instanceId;
            const snap = snapshots[item.instanceId];
            const level = snap?.type === 'level' ? (snap.payload as { level: number }).level : 0;
            const inputPin = pins.find((p) => p.role === 'gpio-in')?.id;
            return (
              <Group
                key={item.instanceId}
                x={item.x}
                y={item.y}
                draggable
                onDragMove={onDragMove(item.instanceId)}
                onDragEnd={onDragMove(item.instanceId)}
                onClick={(e) => {
                  e.cancelBubble = true;
                  setSelectedInstance(item.instanceId);
                  setSelectedWireId(null);
                }}
              >
                <Rect
                  width={NODE_W}
                  height={NODE_H}
                  fill="#ffffff"
                  stroke={sel ? '#2563eb' : '#64748b'}
                  strokeWidth={sel ? 2 : 1}
                  cornerRadius={8}
                  shadowColor="#0f172a"
                  shadowBlur={6}
                  shadowOpacity={0.12}
                />
                <Text
                  x={8}
                  y={6}
                  width={NODE_W - 16}
                  text={`${item.kind} ${item.instanceId}`}
                  fontSize={10}
                  fill="#334155"
                  listening={false}
                />
                {item.kind === 'led' && (
                  <Circle
                    x={NODE_W / 2}
                    y={36}
                    radius={13}
                    fill="#ef4444"
                    opacity={0.15 + 0.85 * level}
                    stroke="#991b1b"
                    listening={false}
                  />
                )}
                {item.kind === 'button' && inputPin !== undefined && (
                  <Group
                    onMouseDown={() => void bridge.per.driveInput({ instanceId: item.instanceId, pin: inputPin, level: 1 }).catch(() => {})}
                    onMouseUp={() => void bridge.per.driveInput({ instanceId: item.instanceId, pin: inputPin, level: 0 }).catch(() => {})}
                    onMouseLeave={() => void bridge.per.driveInput({ instanceId: item.instanceId, pin: inputPin, level: 0 }).catch(() => {})}
                  >
                    <Rect
                      x={20}
                      y={26}
                      width={NODE_W - 40}
                      height={26}
                      fill="#e2e8f0"
                      cornerRadius={6}
                      stroke="#64748b"
                    />
                    <Text
                      x={20}
                      y={32}
                      width={NODE_W - 40}
                      align="center"
                      text="BTN"
                      fontSize={11}
                      fill="#334155"
                      listening={false}
                    />
                  </Group>
                )}
                {item.kind === 'buzzer' && (() => {
                  // 'tone' snapshot (P2.3): duty doubles as the glow level.
                  const tone = snap?.type === 'tone'
                    ? (snap.payload as { freqHz: number; duty: number })
                    : null;
                  const on = tone !== null && tone.freqHz > 0 && tone.duty > 0;
                  const glow = on ? tone.duty : 0;
                  return (
                    <Group listening={false}>
                      <Circle
                        x={NODE_W / 2}
                        y={34}
                        radius={12}
                        fill={on ? '#fbbf24' : '#e2e8f0'}
                        opacity={on ? 0.4 + 0.6 * glow : 1}
                        stroke="#92400e"
                      />
                      <Text
                        x={14}
                        y={48}
                        width={NODE_W - 28}
                        align="center"
                        text={on ? `${Math.round(tone.freqHz)} Hz` : 'silent'}
                        fontSize={9}
                        fill="#64748b"
                      />
                    </Group>
                  );
                })()}
                {item.kind === 'speaker' && (() => {
                  // 'audio' snapshot (P2.4): presence of PCM = playing.
                  const chunk = snap?.type === 'audio'
                    ? (snap.payload as { samples: number[]; sampleRate: number })
                    : null;
                  const on = chunk !== null && Array.isArray(chunk.samples) && chunk.samples.length > 0;
                  return (
                    <Group listening={false}>
                      <Circle
                        x={NODE_W / 2}
                        y={34}
                        radius={12}
                        fill={on ? '#38bdf8' : '#e2e8f0'}
                        stroke="#075985"
                      />
                      <Text
                        x={14}
                        y={48}
                        width={NODE_W - 28}
                        align="center"
                        text={on ? `${(chunk.sampleRate / 1000).toFixed(1)} kHz` : 'silent'}
                        fontSize={9}
                        fill="#64748b"
                      />
                    </Group>
                  );
                })()}
                {item.kind === 'oscilloscope' && (
                  // Live traces render in the Oscilloscope panel (P2.5); the
                  // canvas node is a labeled placeholder like the OLED's.
                  <Group listening={false}>
                    <Rect
                      x={14}
                      y={22}
                      width={NODE_W - 28}
                      height={32}
                      fill="#0b1120"
                      cornerRadius={3}
                      stroke="#475569"
                    />
                    <Text
                      x={14}
                      y={34}
                      width={NODE_W - 28}
                      align="center"
                      text="SCOPE"
                      fontSize={9}
                      fill="#64748b"
                    />
                  </Group>
                )}
                {item.kind === 'mic' && (
                  // Input peripheral (P3.1): the mic injects I2S RX samples
                  // upstream. P3.2: clicking the node toggles local mic
                  // capture (getUserMedia) for this instance; while capturing,
                  // host audio replaces the synth waveform.
                  <Group
                    onClick={(e) => {
                      e.cancelBubble = true;
                      if (capturing[item.instanceId]) stopCapture(item.instanceId);
                      else void startCapture(item.instanceId);
                    }}
                    onMouseEnter={hoverCursor('pointer')}
                    onMouseLeave={hoverCursor('default')}
                  >
                    <Circle
                      x={NODE_W / 2}
                      y={34}
                      radius={12}
                      fill={capturing[item.instanceId] ? '#ef4444' : '#e2e8f0'}
                      stroke="#166534"
                    />
                    <Text
                      x={14}
                      y={48}
                      width={NODE_W - 28}
                      align="center"
                      text={capturing[item.instanceId] ? 'LIVE' : 'REC'}
                      fontSize={9}
                      fill="#64748b"
                      listening={false}
                    />
                  </Group>
                )}
                {item.kind === 'knob' && (
                  // Input peripheral (P3.4, PRD §F-BB-3): the side buttons
                  // rotate the encoder one detent per click; the model plays
                  // the quadrature sequence onto the wired GPIOs.
                  <Group>
                    <Circle
                      x={NODE_W / 2}
                      y={34}
                      radius={12}
                      fill="#cbd5e1"
                      stroke="#334155"
                      listening={false}
                    />
                    {([[-1, 'CCW', 14], [1, 'CW', NODE_W - 48]] as const).map(([dir, label, x]) => (
                      <Group
                        key={label}
                        onClick={(e) => {
                          e.cancelBubble = true;
                          void bridge.per.rotateKnob({ instanceId: item.instanceId, delta: dir }).catch(() => {});
                        }}
                        onMouseEnter={hoverCursor('pointer')}
                        onMouseLeave={hoverCursor('default')}
                      >
                        <Rect x={x} y={26} width={34} height={16} fill="#e2e8f0" cornerRadius={4} stroke="#64748b" />
                        <Text x={x} y={30} width={34} align="center" text={label} fontSize={8} fill="#334155" listening={false} />
                      </Group>
                    ))}
                  </Group>
                )}
                {item.kind === 'sht30' && (() => {
                  // Input peripheral (P3.4, PRD §F-BB-3): the node shows the
                  // model's text snapshot (falling back to the props-derived
                  // reading before the Bridge answers); the +/- buttons edit
                  // netlist props, rebuilt in place by bb:applyNetlist.
                  const props = netlist.peripherals.find((p) => p.instanceId === item.instanceId)?.props;
                  const text = snap?.type === 'text'
                    ? (snap.payload as { text: string }).text
                    : sht30FormatReading(sht30ConfigFromProps(props));
                  const buttons: [string, 'temperatureC' | 'humidityRh', 1 | -1, number][] = [
                    ['T-', 'temperatureC', -1, 8],
                    ['T+', 'temperatureC', 1, 42],
                    ['H-', 'humidityRh', -1, 76],
                    ['H+', 'humidityRh', 1, 110],
                  ];
                  return (
                    <Group>
                      <Rect x={14} y={22} width={NODE_W - 28} height={20} fill="#f0f9ff" cornerRadius={3} stroke="#0284c7" listening={false} />
                      <Text x={14} y={27} width={NODE_W - 28} align="center" text={text} fontSize={10} fill="#0c4a6e" listening={false} />
                      {buttons.map(([label, field, dir, x]) => (
                        <Group
                          key={label}
                          onClick={(e) => {
                            e.cancelBubble = true;
                            updatePeripheralProps(item.instanceId, adjustSht30(props, field, dir));
                          }}
                          onMouseEnter={hoverCursor('pointer')}
                          onMouseLeave={hoverCursor('default')}
                        >
                          <Rect x={x} y={46} width={30} height={14} fill="#e2e8f0" cornerRadius={3} stroke="#64748b" />
                          <Text x={x} y={49} width={30} align="center" text={label} fontSize={8} fill="#334155" listening={false} />
                        </Group>
                      ))}
                    </Group>
                  );
                })()}
                {item.kind === 'ssd1306' && (
                  // Live pixels render in ScreenView; canvas preview is a TODO(PRD §F-PER-3).
                  <Group listening={false}>
                    <Rect
                      x={14}
                      y={22}
                      width={NODE_W - 28}
                      height={32}
                      fill="#0b1120"
                      cornerRadius={3}
                      stroke="#475569"
                    />
                    <Text
                      x={14}
                      y={34}
                      width={NODE_W - 28}
                      align="center"
                      text="128x64"
                      fontSize={9}
                      fill="#64748b"
                    />
                  </Group>
                )}
                {!BESPOKE_CANVAS_KINDS.has(item.kind) && (() => {
                  // Generic body (PRD §F-EXT-1, dev-plan P5.1): any registered
                  // kind without a bespoke renderer — third-party packages
                  // included — shows a neutral lamp plus a one-line status
                  // derived from its latest snapshot, so it is visible and
                  // alive on the canvas with zero per-kind UI code.
                  const st = describeGenericSnapshot(snap);
                  return (
                    <Group listening={false}>
                      <Circle
                        x={NODE_W / 2}
                        y={34}
                        radius={12}
                        fill={st.lamp === null ? '#cbd5e1' : '#10b981'}
                        opacity={st.lamp === null ? 0.6 : 0.15 + 0.85 * st.lamp}
                        stroke="#475569"
                      />
                      <Text
                        x={14}
                        y={48}
                        width={NODE_W - 28}
                        align="center"
                        text={st.text}
                        fontSize={9}
                        fill="#64748b"
                      />
                    </Group>
                  );
                })()}
                {sel && (
                  <Group
                    onClick={(e) => {
                      e.cancelBubble = true;
                      deleteInstance(item.instanceId);
                    }}
                    onMouseEnter={hoverCursor('pointer')}
                    onMouseLeave={hoverCursor('default')}
                  >
                    <Circle x={NODE_W - 16} y={16} radius={9} fill="#fee2e2" stroke="#dc2626" strokeWidth={1.5} />
                    <Text x={NODE_W - 22} y={10} width={12} align="center" text="x" fontSize={11} fill="#b91c1c" fontStyle="bold" />
                  </Group>
                )}
                {pins.map((p, idx) => {
                  const off = peripheralPinOffset(idx, pins.length);
                  const active =
                    pending !== null &&
                    pending.endpoint.instanceId === item.instanceId &&
                    pending.endpoint.pin === p.id;
                  return (
                    <Group key={p.id}>
                      <Circle
                        x={off.x}
                        y={off.y}
                        radius={PIN_R}
                        fill={p.optional ? '#94a3b8' : '#334155'}
                        stroke={active ? '#2563eb' : '#0f172a'}
                        strokeWidth={active ? 2 : 1}
                        onClick={onPinClick(
                          { instanceId: item.instanceId, pin: p.id },
                          { x: item.x + off.x, y: item.y + off.y },
                        )}
                        onMouseEnter={hoverCursor('crosshair')}
                        onMouseLeave={hoverCursor('default')}
                      />
                      <Text
                        x={off.x - 14}
                        y={off.y + PIN_LABEL_GAP - PIN_R}
                        width={28}
                        align="center"
                        text={p.id}
                        fontSize={9}
                        fill="#475569"
                        listening={false}
                      />
                    </Group>
                  );
                })}
              </Group>
            );
          })}

          {/* Pending-wire rubber band and source pin highlight (transient UI state). */}
          {pending !== null && (
            <>
              <Circle
                x={pending.anchor.x}
                y={pending.anchor.y}
                radius={PIN_R + 4}
                stroke="#2563eb"
                strokeWidth={2}
                listening={false}
              />
              <Path
                data={wirePath({
                  x1: pending.anchor.x,
                  y1: pending.anchor.y,
                  x2: pointer.x,
                  y2: pointer.y,
                })}
                stroke="#2563eb"
                strokeWidth={2}
                dash={[7, 5]}
                listening={false}
              />
            </>
          )}

          <Text x={16} y={10} width={CANVAS_W - 32} text={hint} fontSize={12} fill="#334155" listening={false} />
        </Layer>
      </Stage>
    </div>
  );
}
