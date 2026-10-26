// 3D view: draws the project's parts and makes them interactive (step 4).
//
// Dragging: the part follows the pointer on the board plane (raycast via the input
// bridge), snapping to the same grid and clamping to the same bounds the 2D canvas
// uses, so a saved layout is identical whichever view moved it. Per-frame moves go
// through `movePeripheral`, whose coalescing keeps a whole drag to one undo step.
// While a part is dragged the orbit controls are switched off, so the same left
// button that rotates the scene on empty space moves a part under the pointer.
import { useCallback, useEffect, useRef } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import { useThree } from '@react-three/fiber';
import type { LayoutItem } from '@breadesp/netlist';
import type { RenderSnapshot } from '@breadesp/peripherals';
import { DoubleSide } from 'three';
import { useCaptureStore } from '../../store/captureStore';
import { useProjectStore } from '../../store/projectStore';
import { useSelectionStore } from '../../store/selectionStore';
import { useSimulationStore } from '../../store/simulationStore';
import { snappedPlacement } from '../Breadboard/canvasView';
import { MCU_NODE, NODE_H, NODE_W, peripheralPins } from '../Breadboard/pinLayout';
import { boardPosition } from './boardSpace';
import { canvas3DInput } from './interaction/inputBridge';
import { partModelFor } from './modelRegistry';
import { McuModel } from './models/McuModel';
import { useScreenTexture } from './wiring/useScreenTexture';

/** Kinds whose body has a framebuffer pane (their snapshots are 'pixels'). */
const SCREEN_KINDS: ReadonlySet<string> = new Set(['ssd1306', 'st7789']);

const clamp01 = (v: number): number => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

/**
 * 0..1 drive level from the latest snapshot: level = brightness, tone = duty while
 * sounding, audio = activity while PCM flows.
 */
function driveLevel(snap: RenderSnapshot | undefined): number {
  if (snap === undefined) return 0;
  if (snap.type === 'level') return clamp01((snap.payload as { level: number }).level);
  if (snap.type === 'tone') {
    const tone = snap.payload as { freqHz: number; duty: number };
    return tone.freqHz > 0 && tone.duty > 0 ? clamp01(tone.duty) : 0;
  }
  if (snap.type === 'audio') {
    const audio = snap.payload as { samples: number[] };
    return Array.isArray(audio.samples) && audio.samples.length > 0 ? 0.85 : 0;
  }
  return 0;
}

/** The subset of OrbitControls this file touches. */
interface OrbitLike {
  enabled: boolean;
}

function PartBody({ item }: { item: LayoutItem }) {
  const Model = partModelFor(item.kind);
  const snap = useSimulationStore((s) => s.snapshots[item.instanceId]);
  const captured = useCaptureStore((s) => s.capturing[item.instanceId] === true);
  const selected = useSelectionStore((s) => s.instanceId === item.instanceId);
  const selectInstance = useSelectionStore((s) => s.selectInstance);
  const movePeripheral = useProjectStore((s) => s.movePeripheral);
  const controls = useThree((s) => s.controls) as unknown as OrbitLike | null;

  const isScreen = SCREEN_KINDS.has(item.kind);
  const screen = useScreenTexture(item.instanceId, isScreen);
  const pins = peripheralPins(item.kind).length;
  // The mic's acoustic port doubles as its LIVE lamp.
  const level = item.kind === 'mic' && captured ? 1 : driveLevel(snap);

  /** Pointer-to-part offset in layout coordinates, fixed for the whole gesture. */
  const dragOffset = useRef<{ x: number; z: number } | null>(null);
  const detach = useRef<(() => void) | null>(null);

  const endDrag = useCallback((): void => {
    dragOffset.current = null;
    if (controls !== null) controls.enabled = true;
    document.body.style.cursor = '';
    detach.current?.();
    detach.current = null;
  }, [controls]);

  // A part can disappear mid-drag (mode switch, delete, undo): release the window
  // listeners so a stale handler cannot keep moving an instance that is gone.
  useEffect(() => () => detach.current?.(), []);

  const onPointerDown = (e: ThreeEvent<PointerEvent>): void => {
    if (e.nativeEvent.button !== 0) return;
    e.stopPropagation();
    selectInstance(item.instanceId);
    const start = canvas3DInput()?.screenToBoard(e.nativeEvent.clientX, e.nativeEvent.clientY);
    if (start === null || start === undefined) return;
    dragOffset.current = { x: start.x - item.x, z: start.z - item.y };
    if (controls !== null) controls.enabled = false;
    document.body.style.cursor = 'grabbing';

    const onMove = (ev: PointerEvent): void => {
      const offset = dragOffset.current;
      if (offset === null) return;
      const point = canvas3DInput()?.screenToBoard(ev.clientX, ev.clientY);
      if (point === null || point === undefined) return;
      const snapped = snappedPlacement(point.x - offset.x, point.z - offset.z, NODE_W, NODE_H);
      movePeripheral(item.instanceId, snapped.x, snapped.y);
    };
    const onUp = (): void => endDrag();

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    detach.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  };

  return (
    <group
      position={boardPosition(item.x + NODE_W / 2, item.y + NODE_H / 2)}
      onPointerDown={onPointerDown}
      onPointerOver={(e) => {
        e.stopPropagation();
        if (dragOffset.current === null) document.body.style.cursor = 'grab';
      }}
      onPointerOut={() => {
        if (dragOffset.current === null) document.body.style.cursor = '';
      }}
    >
      {/* Selection halo on the board: the same state the 2D canvas and the
          properties panel show, so selecting in either view highlights both. */}
      {selected && (
        <mesh position={[0, 0.4, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[26, 29, 48]} />
          <meshBasicMaterial color="#2563eb" transparent opacity={0.85} side={DoubleSide} />
        </mesh>
      )}
      <Model instanceId={item.instanceId} pins={pins} level={level} screen={screen} />
    </group>
  );
}

export function PartsLayer() {
  const layout = useProjectStore((s) => s.layout);
  return (
    <>
      {/* The MCU node is fixed in the project model (MVP), so its board is
          positioned straight from MCU_NODE and is not draggable. */}
      <group position={[MCU_NODE.x + MCU_NODE.w / 2, 0, MCU_NODE.y + MCU_NODE.h / 2]}>
        <McuModel />
      </group>
      {layout.map((item) => (
        <PartBody key={item.instanceId} item={item} />
      ))}
    </>
  );
}
