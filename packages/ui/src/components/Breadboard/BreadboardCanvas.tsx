// PRD: §F-BB-1, §F-BB-2, §F-BB-4 — Breadboard canvas (Konva).
// Interactions: drop from the palette places a peripheral (snapped to the
// grid); dragging a node moves it (layout-only edit, snapped on release);
// clicking pin -> pin wires the two endpoints (netlist-only edit, applied to
// the Bridge by App via bb:applyNetlist); clicking a wire twice (or Delete)
// removes it; Esc cancels the pending wire.
// T2.2-T2.6: the Stage is container-sized (ResizeObserver) and zooms/pans via
// the canvasView transform (wheel = zoom at pointer, background drag = pan
// with a 4px click threshold); a grid underlays the world; drop shows a ghost
// preview; pins/wires highlight on hover; feedback goes through toasts.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Circle, Group, Layer, Path, Rect, Shape, Stage, Text } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import type { Stage as KonvaStage } from 'konva/lib/Stage';
import { MCU_INSTANCE_ID, type WireEndpoint } from '@breadesp/netlist';
import { useProjectStore } from '../../store/projectStore';
import { useSimulationStore } from '../../store/simulationStore';
import { useCanvasViewStore } from '../../store/canvasViewStore';
import { useCaptureStore } from '../../store/captureStore';
import { useSelectionStore } from '../../store/selectionStore';
import { toast } from '../../store/toastStore';
import { useT } from '../../i18n';
import { bridge } from '../../ipc/bridge';
import { wirePath } from './Wire';
import {
  containerToWorld,
  gridSegments,
  snappedPlacement,
  visibleWorldRect,
} from './canvasView';
import { WORLD_W, WORLD_H } from './worldSize';
import { CanvasToolbar } from './CanvasToolbar';
import { EmptyGuide } from './EmptyGuide';
import { isEditableTarget } from '../HelpDialog/shortcuts';
import { adjustSht30 } from './sensorDraft';
import { describeGenericSnapshot } from './genericNode';
import { sht30ConfigFromProps, sht30FormatReading } from '@breadesp/peripherals';
import {
  MCU_GPIO_PINS,
  MCU_NODE,
  NODE_H,
  NODE_W,
  PIN_R,
  PIN_LABEL_GAP,
  mcuPinLayout,
  peripheralPinOffset,
  peripheralPins,
  wireAnchors,
  type Anchor,
} from './pinLayout';

/** Pointer travel (container px) below which a background drag counts as a click. */
const PAN_CLICK_THRESHOLD = 4;

interface PendingWire {
  endpoint: WireEndpoint;
  anchor: Anchor;
}

/** Ghost preview while dragging a palette entry over the canvas (T2.4). */
interface Ghost {
  kind: string;
  x: number;
  y: number;
}

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
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const snapshots = useSimulationStore((s) => s.snapshots);
  // P3.2: which mic instances are capturing host audio (drives REC/LIVE toggle).
  const capturing = useCaptureStore((s) => s.capturing);
  const startCapture = useCaptureStore((s) => s.startCapture);
  const stopCapture = useCaptureStore((s) => s.stopCapture);

  const view = useCanvasViewStore((s) => s.view);
  const zoomAt = useCanvasViewStore((s) => s.zoomAt);
  const panBy = useCanvasViewStore((s) => s.panBy);

  const t = useT();
  const [pending, setPending] = useState<PendingWire | null>(null);
  /** Rubber-band end — WORLD coordinates (converted from the pointer). */
  const [pointer, setPointer] = useState<Anchor>({ x: 0, y: 0 });
  // T4.1: selection lives in the selectionStore so the PropsPanel follows it.
  const selectedWireId = useSelectionStore((s) => s.wireId);
  const selectedInstance = useSelectionStore((s) => s.instanceId);
  const selectInstance = useSelectionStore((s) => s.selectInstance);
  const selectWire = useSelectionStore((s) => s.selectWire);
  const clearSelection = useSelectionStore((s) => s.clear);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  /** Hover keys: `${instanceId}:${pin}` for pins, wire id for wires (T2.5). */
  const [hoverPin, setHoverPin] = useState<string | null>(null);
  const [hoverWireId, setHoverWireId] = useState<string | null>(null);
  const [size, setSize] = useState({ w: WORLD_W, h: WORLD_H });

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<KonvaStage | null>(null);
  const dragStartPointer = useRef<{ x: number; y: number } | null>(null);

  // T2.2: the Stage follows its container's size (window resize, dock folds).
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Esc cancels the pending wire / selections; Delete removes the selected wire
  // or instance. Ctrl+Z / Ctrl+Y (plus Ctrl+Shift+Z) drive undo/redo (F-BB-5).
  // Text-entry surfaces (serial console, wavegen fields) keep native shortcuts:
  // canvas keys never fire while an input has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
        if (isEditableTarget(e.target)) return;
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (e.ctrlKey && !e.altKey && (e.key === 'y' || e.key === 'Y')) {
        if (isEditableTarget(e.target)) return;
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === 'Escape') {
        if (isEditableTarget(e.target)) return;
        setPending(null);
        clearSelection();
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (isEditableTarget(e.target)) return;
        if (selectedWireId !== null) {
          removeWire(selectedWireId);
          selectWire(null);
        } else if (selectedInstance !== null) {
          removePeripheral(selectedInstance);
          selectInstance(null);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedWireId, selectedInstance, removeWire, removePeripheral, undo, redo, selectWire, selectInstance, clearSelection]);

  const clearPending = (message?: () => void): void => {
    setPending(null);
    if (message !== undefined) message();
  };

  const onPinClick =
    (endpoint: WireEndpoint, anchor: Anchor) => (e: KonvaEventObject<MouseEvent>) => {
      e.cancelBubble = true;
      if (pending === null) {
        setPending({ endpoint, anchor });
        setPointer(anchor);
        toast.info(t('canvas.wiringFrom', { pin: endpointLabel(endpoint) }));
        return;
      }
      if (pending.endpoint.instanceId === endpoint.instanceId && pending.endpoint.pin === endpoint.pin) {
        clearPending(() => toast.info(t('canvas.wireCancelled')));
        return;
      }
      if (
        pending.endpoint.instanceId !== MCU_INSTANCE_ID &&
        endpoint.instanceId !== MCU_INSTANCE_ID
      ) {
        clearPending(() => toast.warning(t('canvas.wireNotRoutable')));
        return;
      }
      const id = addWire(pending.endpoint, endpoint);
      if (id === null) {
        clearPending(() => toast.warning(t('canvas.wireExists')));
      } else {
        clearPending(() =>
          toast.success(t('canvas.wireCreated', {
            from: endpointLabel(pending.endpoint),
            to: endpointLabel(endpoint),
          })),
        );
      }
    };

  // Rubber band: the pointer is converted into world coordinates so the band
  // stays glued to the cursor at any zoom/pan (T2.6).
  const onStageMouseMove = (e: KonvaEventObject<MouseEvent>): void => {
    if (pending === null) return;
    const p = e.target.getStage()?.getPointerPosition();
    if (p) setPointer(containerToWorld(view, p));
  };

  // Wheel = zoom at the pointer (ctrl held = fine steps).
  const onWheel = (e: KonvaEventObject<WheelEvent>): void => {
    e.evt.preventDefault();
    const p = e.target.getStage()?.getPointerPosition();
    if (p == null) return;
    const step = e.evt.ctrlKey ? 1.01 : 1.1;
    zoomAt(p, e.evt.deltaY < 0 ? step : 1 / step);
  };

  // Background pan: the drag delta is absorbed into the view each frame (the
  // rect itself stays at the origin); releasing under PAN_CLICK_THRESHOLD px
  // of travel is treated as a plain click (clears selection) — we do not bet
  // on Konva's click-after-drag semantics (T2.2).
  // A perfectly still click never starts a Konva drag (dragDistance ≈ 3px), so
  // dragEnd alone would leave a dead zone; the Rect also tracks mouse down/up
  // through the same ref. Whichever handler runs first consumes the ref, so a
  // gesture is never handled twice.
  const onBgDragStart = (e: KonvaEventObject<globalThis.DragEvent>): void => {
    dragStartPointer.current = e.target.getStage()?.getPointerPosition() ?? null;
  };
  const onBgMouseDown = (e: KonvaEventObject<MouseEvent>): void => {
    dragStartPointer.current = e.target.getStage()?.getPointerPosition() ?? null;
  };
  const onBgMouseUp = (e: KonvaEventObject<MouseEvent>): void => {
    const start = dragStartPointer.current;
    dragStartPointer.current = null;
    const end = e.target.getStage()?.getPointerPosition();
    if (start == null || end == null) return;
    const dist = Math.hypot(end.x - start.x, end.y - start.y);
    if (dist < PAN_CLICK_THRESHOLD) onBackgroundClick();
  };
  const onBgDragMove = (e: KonvaEventObject<globalThis.DragEvent>): void => {
    const node = e.target;
    const dx = node.x();
    const dy = node.y();
    node.position({ x: 0, y: 0 });
    panBy(dx, dy);
  };
  const onBgDragEnd = (e: KonvaEventObject<globalThis.DragEvent>): void => {
    const start = dragStartPointer.current;
    dragStartPointer.current = null;
    const end = e.target.getStage()?.getPointerPosition();
    if (start == null || end == null) return;
    const dist = Math.hypot(end.x - start.x, end.y - start.y);
    if (dist < PAN_CLICK_THRESHOLD) onBackgroundClick();
  };

  const onBackgroundClick = (): void => {
    if (pending !== null) {
      clearPending(() => toast.info(t('canvas.wireCancelled')));
      return;
    }
    clearSelection();
  };

  // T2.4: ghost preview follows the drag in world coordinates (grid-snapped).
  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const kind = (window as unknown as { __bb_drag_kind?: string }).__bb_drag_kind;
    if (kind === undefined) return;
    const rect = stageRef.current?.container().getBoundingClientRect();
    if (rect === undefined) return;
    const world = containerToWorld(view, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    const p = snappedPlacement(world.x, world.y, NODE_W, NODE_H);
    setGhost((prev) =>
      prev !== null && prev.kind === kind && prev.x === p.x && prev.y === p.y ? prev : { kind, ...p },
    );
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    const w = window as unknown as { __bb_drag_kind?: string };
    const kind = w.__bb_drag_kind;
    if (!kind) return;
    w.__bb_drag_kind = undefined;
    setGhost(null);
    // Measure against the Stage container so internal scrolling cannot offset the drop.
    const rect = stageRef.current?.container().getBoundingClientRect();
    if (!rect) return;
    const world = containerToWorld(view, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    // Snap to the grid and keep the node fully inside the world (T2.3).
    const p = snappedPlacement(world.x, world.y, NODE_W, NODE_H);
    const instanceId = addPeripheral(kind, p.x, p.y);
    selectInstance(instanceId);
    toast.info(t('canvas.placed', { kind }));
  };

  const onDragMove = (instanceId: string) => (e: KonvaEventObject<globalThis.DragEvent>): void => {
    movePeripheral(instanceId, e.target.x(), e.target.y());
  };

  // T2.3: release snaps the node to the grid (the drag itself stays free-form
  // so it feels attached to the cursor) and keeps it on the board.
  const onNodeDragEnd = (instanceId: string) => (e: KonvaEventObject<globalThis.DragEvent>): void => {
    const p = snappedPlacement(e.target.x(), e.target.y(), NODE_W, NODE_H);
    e.target.position({ x: p.x, y: p.y });
    movePeripheral(instanceId, p.x, p.y);
  };

  const deleteInstance = (instanceId: string): void => {
    removePeripheral(instanceId);
    clearSelection(); // the selected wire may have gone with the instance
    toast.info(t('canvas.removedInstance', { id: instanceId }));
  };

  const onWireClick = (wireId: string) => (e: KonvaEventObject<MouseEvent>): void => {
    e.cancelBubble = true;
    if (selectedWireId === wireId) {
      removeWire(wireId);
      selectWire(null);
      toast.info(t('canvas.removedWire'));
    } else {
      selectWire(wireId);
      toast.info(t('canvas.wireSelected'));
    }
  };

  const hoverCursor = (style: string) => (e: KonvaEventObject<MouseEvent>): void => {
    const c = e.target.getStage()?.container();
    if (c) c.style.cursor = style;
  };

  // T2.3: grid lines restricted to the visible world rect; stroke widths are
  // divided by the scale so they stay 1px on screen at any zoom.
  const grid = useMemo(() => gridSegments(visibleWorldRect(view, size)), [view, size]);

  return (
    <div
      ref={containerRef}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={() => setGhost(null)}
      style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#dfe6ef' }}
    >
      <Stage
        ref={stageRef}
        width={size.w}
        height={size.h}
        scaleX={view.scale}
        scaleY={view.scale}
        x={view.x}
        y={view.y}
        onMouseMove={onStageMouseMove}
        onWheel={onWheel}
      >
        <Layer>
          {/* The board itself — pannable background; outside it is the chrome color. */}
          <Rect
            x={0}
            y={0}
            width={WORLD_W}
            height={WORLD_H}
            fill="#eef2f7"
            draggable
            onMouseDown={onBgMouseDown}
            onMouseUp={onBgMouseUp}
            onDragStart={onBgDragStart}
            onDragMove={onBgDragMove}
            onDragEnd={onBgDragEnd}
          />

          {/* Grid (T2.3): fine 10px lines + major 50px lines, viewport-clipped. */}
          <Shape
            listening={false}
            sceneFunc={(ctx) => {
              ctx.beginPath();
              for (const s of grid.fine) {
                ctx.moveTo(s.x1, s.y1);
                ctx.lineTo(s.x2, s.y2);
              }
              ctx.strokeStyle = '#d9e1ec';
              ctx.lineWidth = 1 / view.scale;
              ctx.stroke();
              ctx.beginPath();
              for (const s of grid.major) {
                ctx.moveTo(s.x1, s.y1);
                ctx.lineTo(s.x2, s.y2);
              }
              ctx.strokeStyle = '#c6d1e0';
              ctx.lineWidth = 1 / view.scale;
              ctx.stroke();
            }}
          />

          {/* Ghost preview of the drop position (T2.4). */}
          {ghost !== null && (
            <Group x={ghost.x} y={ghost.y} listening={false}>
              <Rect
                width={NODE_W}
                height={NODE_H}
                fill="#2563eb"
                opacity={0.08}
                stroke="#2563eb"
                strokeWidth={1.5}
                dash={[6, 4]}
                cornerRadius={8}
              />
              <Text
                x={8}
                y={6}
                width={NODE_W - 16}
                text={ghost.kind}
                fontSize={10}
                fill="#2563eb"
              />
            </Group>
          )}

          {/* Wires (netlist logic) — under the nodes, click to select, click again to remove. */}
          {netlist.wires.map((w) => {
            const a = wireAnchors(w, layout);
            if (a === null) return null; // endpoint not on the canvas (unknown instance/pin)
            const sel = selectedWireId === w.id;
            const hovered = hoverWireId === w.id;
            return (
              <Path
                key={w.id}
                data={wirePath({ x1: a.from.x, y1: a.from.y, x2: a.to.x, y2: a.to.y })}
                stroke={sel ? '#dc2626' : hovered ? '#2563eb' : '#475569'}
                strokeWidth={sel || hovered ? 3 : 2}
                hitStrokeWidth={10 / Math.max(view.scale, 0.5)}
                onClick={onWireClick(w.id)}
                onMouseEnter={(e) => {
                  setHoverWireId(w.id);
                  hoverCursor('pointer')(e);
                }}
                onMouseLeave={() => setHoverWireId(null)}
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
              const pinKey = `mcu:${pin}`;
              const hovered = hoverPin === pinKey;
              return (
                <Group key={pin}>
                  <Circle
                    x={l.anchor.x}
                    y={l.anchor.y}
                    radius={hovered ? PIN_R + 2 : PIN_R}
                    fill={hovered ? '#2563eb' : '#94a3b8'}
                    stroke="#0f2744"
                    strokeWidth={1}
                    onClick={onPinClick({ instanceId: MCU_INSTANCE_ID, pin }, l.anchor)}
                    onMouseEnter={(e) => {
                      setHoverPin(pinKey);
                      hoverCursor('crosshair')(e);
                    }}
                    onMouseLeave={() => setHoverPin(null)}
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
                onDragEnd={onNodeDragEnd(item.instanceId)}
                onClick={(e) => {
                  e.cancelBubble = true;
                  selectInstance(item.instanceId);
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
                  const pinKey = `${item.instanceId}:${p.id}`;
                  const hovered = hoverPin === pinKey;
                  return (
                    <Group key={p.id}>
                      <Circle
                        x={off.x}
                        y={off.y}
                        radius={hovered ? PIN_R + 2 : PIN_R}
                        fill={active || hovered ? '#2563eb' : p.optional ? '#94a3b8' : '#334155'}
                        stroke={active ? '#2563eb' : '#0f172a'}
                        strokeWidth={active ? 2 : 1}
                        onClick={onPinClick(
                          { instanceId: item.instanceId, pin: p.id },
                          { x: item.x + off.x, y: item.y + off.y },
                        )}
                        onMouseEnter={(e) => {
                          setHoverPin(pinKey);
                          hoverCursor('crosshair')(e);
                        }}
                        onMouseLeave={() => setHoverPin(null)}
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
        </Layer>
      </Stage>
      {layout.length === 0 && <EmptyGuide />}
      <CanvasToolbar size={size} />
    </div>
  );
}
