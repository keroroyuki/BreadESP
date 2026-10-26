// 3D view (step 1: scene skeleton). Scope of this step — the board slab, the
// fine/major grid, lighting and orbit navigation (drag = rotate, wheel = zoom,
// right-drag = pan), plus a live performance badge so WebGL availability and
// frame cost are measurable *before* any model work starts.
//
// Peripheral models, pins and wires land in the following steps. They all
// position themselves through ./boardSpace, so the world mapping pinned here is
// the contract those steps build on; nothing in this file has to change for
// them. Overlays (hint, badge, reset) stay in the DOM rather than in WebGL:
// crisp text at any zoom, and no dependency on troika's CDN-hosted default font
// (an offline desktop app must not fetch a font to draw a label).
import { Component, useCallback, useEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  ErrorInfo,
  ReactNode,
} from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { Grid, Line, OrbitControls, RoundedBox } from '@react-three/drei';
import { DoubleSide, Plane, Raycaster, Vector2, Vector3 } from 'three';
import type { Camera } from 'three';
import { MCU_INSTANCE_ID } from '@breadesp/netlist';
import { tNow, useT } from '../../i18n';
import { useDropGhostStore } from '../../store/dropGhostStore';
import { useProjectStore } from '../../store/projectStore';
import { useSelectionStore } from '../../store/selectionStore';
import { useViewModeStore } from '../../store/viewModeStore';
import { useWiring3DStore } from '../../store/wiring3dStore';
import { toast } from '../../store/toastStore';
import { GRID, GRID_MAJOR, snappedPlacement } from '../Breadboard/canvasView';
import { NODE_H, NODE_W } from '../Breadboard/pinLayout';
import { isEditableTarget } from '../HelpDialog/shortcuts';
import { WORLD_H, WORLD_W } from '../Breadboard/worldSize';
import {
  BOARD_THICKNESS,
  MAX_CAMERA_DISTANCE,
  MIN_CAMERA_DISTANCE,
  boardCenter,
  defaultCameraPosition,
} from './boardSpace';
import { canvas3DInput, clearCanvas3DInput, setCanvas3DInput } from './interaction/inputBridge';
import { mcuPinAnchors, partPinAnchors, PIN_ROWS_3D, type PinAnchor3D } from './wiring/pinRows3d';
import { modelKeyFor } from './modelCatalog';
import { PartsLayer } from './PartsLayer';
import { PinsLayer } from './PinsLayer';
import { WiresLayer } from './WiresLayer';
import { describeRenderer, detectWebGL, type WebGLVersion } from './webglSupport';

/** The subset of OrbitControls this file drives (keeps drei internals out of our types). */
interface OrbitLike {
  target: { set: (x: number, y: number, z: number) => void };
  update: () => void;
}

/**
 * Keeps the orbit target on the board centre (the board starts at the world
 * origin, it is not centred on it) and applies the toolbar's reset request.
 */
function CameraRig({ resetToken }: { resetToken: number }) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as unknown as OrbitLike | null;
  const lastToken = useRef(resetToken);

  // `makeDefault` publishes the controls into the r3f store a tick after mount,
  // so the target is (re)applied whenever that reference arrives.
  useEffect(() => {
    if (controls === null) return;
    controls.target.set(...boardCenter());
    controls.update();
  }, [controls]);

  useEffect(() => {
    if (lastToken.current === resetToken) return;
    lastToken.current = resetToken;
    camera.position.set(...defaultCameraPosition());
    if (controls !== null) {
      controls.target.set(...boardCenter());
      controls.update();
    }
  }, [resetToken, camera, controls]);

  return null;
}

/** Samples the real frame rate ~2×/s and reports it to the DOM badge. */
function FrameProbe({ onSample }: { onSample: (fps: number) => void }) {
  const acc = useRef({ frames: 0, seconds: 0 });
  useFrame((_state, delta) => {
    const a = acc.current;
    a.frames += 1;
    a.seconds += delta;
    if (a.seconds < 0.5) return;
    onSample(Math.round(a.frames / a.seconds));
    a.frames = 0;
    a.seconds = 0;
  });
  return null;
}

/**
 * Dev-only scene probe. Publishes a tiny read-only inspector on `window` so
 * automation (and a curious developer in devtools) can ask what the scene really
 * contains — layout size vs. mounted meshes — instead of inferring it from
 * screenshots. `import.meta.env.DEV` is statically false in production builds, so
 * none of this ships there.
 *
 * The window hook is installed once at module scope and never deleted: binding it
 * to a component's mount/unmount left a window where the mode toggle had
 * remounted the canvas but the hook was still missing (or, worse, deleted by the
 * outgoing instance's cleanup after the new one installed it).
 */
let probedScene: { traverse: (cb: (o: { type: string }) => void) => void } | null = null;
/** Camera/renderer of the live scene, so automation can project world → screen. */
let probedView: {
  camera: Camera;
  gl: { domElement: HTMLCanvasElement };
} | null = null;

if (import.meta.env.DEV) {
  const w = window as unknown as {
    __bb_scene?: () => unknown;
    __bb_project?: (x: number, y: number, z: number) => { x: number; y: number } | null;
    __bb_pick?: (x: number, y: number) => { instanceId: string; pin: string } | null;
  };

  w.__bb_scene = () => {
    let meshes = 0;
    let objects = 0;
    if (probedScene !== null) {
      probedScene.traverse((o) => {
        objects += 1;
        if (o.type === 'Mesh') meshes += 1;
      });
    }
    const project = useProjectStore.getState();
    return {
      parts: project.layout.length,
      layout: project.layout.map((l) => ({ id: l.instanceId, x: l.x, y: l.y })),
      wires: project.netlist.wires.length,
      selectedInstance: useSelectionStore.getState().instanceId,
      selectedWire: useSelectionStore.getState().wireId,
      sceneAttached: probedScene !== null,
      meshes,
      objects,
    };
  };

  // World → client pixels. Dev-only helper so automation can click a specific pin
  // instead of guessing where the camera put it.
  w.__bb_project = (x, y, z) => {
    if (probedView === null) return null;
    const v = new Vector3(x, y, z).project(probedView.camera);
    const rect = probedView.gl.domElement.getBoundingClientRect();
    return {
      x: rect.left + ((v.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - v.y) / 2) * rect.height,
    };
  };

  // Same picker the pointer path uses, exposed so a harness can tell "nothing was
  // under the cursor" apart from "the click never reached the canvas".
  w.__bb_pick = (x, y) => nearestPin(x, y);
}

function SceneProbe() {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    // Overwrite only — never clear on unmount. The outgoing canvas disposes
    // asynchronously, so a cleanup that nulled the slot could erase the scene the
    // remounted canvas had already installed. A stale reference is harmless:
    // it only means the probe reports the previous (now empty) scene.
    probedScene = scene as unknown as typeof probedScene;
    probedView = { camera, gl };
  }, [scene, camera, gl]);
  return null;
}

/**
 * Nearest pin to a client point.
 *
 * Scene-graph hit testing cannot do this job: an LED's legs sit under its dome, a
 * module's header is under its own bezel, and the MCU's pads are inside the header
 * strip — the ray always hits the body first.
 *
 * The pick is therefore a data query, decided on the *board plane*: the cursor is
 * projected onto y = 0 and a pin is a candidate only when the cursor is within a
 * fraction of that kind's pin spacing of the pin's (x, z). Using world distance
 * instead of comparing against the part's centre keeps the decision stable at any
 * zoom and camera tilt: a click in the middle of a small part is ~half a spacing
 * from either pin and therefore selects the part, while a click on a pin is
 * unambiguous. A screen-space cap keeps pins unpickable when they are too far away
 * to aim at.
 */
function nearestPin(clientX: number, clientY: number): { instanceId: string; pin: string } | null {
  const api = canvas3DInput();
  if (api === null) return null;
  const layout = useProjectStore.getState().layout;
  let best: { instanceId: string; pin: string } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  const consider = (instanceId: string, anchors: PinAnchor3D[], radius: number): void => {
    for (const anchor of anchors) {
      const [px, py, pz] = anchor.position;
      // True 3D distance from the click ray: independent of how high the pin stands.
      const distance = api.rayDistance(clientX, clientY, px, py, pz);
      if (distance > radius || distance >= bestDistance) continue;
      bestDistance = distance;
      best = { instanceId, pin: anchor.pin };
    }
  };

  // MCU pads are 5.4 wide and far from any part centre, so they tolerate a wider pick.
  consider(MCU_INSTANCE_ID, mcuPinAnchors(), 4.5);
  for (const item of layout) {
    const spacing = PIN_ROWS_3D[modelKeyFor(item.kind)].spacing;
    // Under half a spacing, so a click in the middle of a small part (e.g. the LED
    // between its two legs) still picks the part instead of a pin.
    const radius = Math.min(4.5, Math.max(2.2, spacing * 0.38));
    consider(
      item.instanceId,
      partPinAnchors(item.kind, item.x + NODE_W / 2, item.y + NODE_H / 2),
      radius,
    );
  }
  return best;
}

/** Clicking empty board clears the selection, or cancels a wire in progress (2D parity). */
function clearSelectionOrPendingWire(): void {
  if (useWiring3DStore.getState().pending !== null) {
    useWiring3DStore.getState().cancel();
    toast.info(tNow('canvas.wireCancelled'));
    return;
  }
  useSelectionStore.getState().clear();
}

/** Board slab, grid, lighting, wiring and the project's modelled parts. */
function BoardScene() {
  const downAt = useRef<{ x: number; y: number } | null>(null);

  const onBoardPointerDown = (e: ThreeEvent<PointerEvent>): void => {
    if (e.nativeEvent.button === 0) downAt.current = { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY };
  };

  const onBoardPointerUp = (e: ThreeEvent<PointerEvent>): void => {
    const start = downAt.current;
    downAt.current = null;
    if (start === null) return;
    // Same threshold as the 2D canvas: a drag that travelled is an orbit, not a click.
    if (Math.hypot(e.nativeEvent.clientX - start.x, e.nativeEvent.clientY - start.y) >= 4) return;
    clearSelectionOrPendingWire();
  };

  return (
    <>
      <hemisphereLight args={['#ffffff', '#aebccd', 0.55]} />
      <ambientLight intensity={0.35} />
      {/* Key light: high and behind the viewer-side edge so part shadows fall
          towards the far edge instead of under the camera. */}
      <directionalLight
        castShadow
        position={[WORLD_W * 0.75, 620, -260]}
        intensity={1.15}
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-near={100}
        shadow-camera-far={2200}
        shadow-camera-left={-700}
        shadow-camera-right={700}
        shadow-camera-top={700}
        shadow-camera-bottom={-700}
        shadow-bias={-0.0006}
      />
      {/* Fill light: keeps the shadow side readable instead of black. */}
      <directionalLight position={[-360, 420, 900]} intensity={0.3} />

      {/* The board itself: the same 960×560 surface the 2D canvas draws, sunk by
          its thickness so the top surface every part sits on is exactly y = 0. */}
      <RoundedBox
        args={[WORLD_W, BOARD_THICKNESS, WORLD_H]}
        radius={10}
        smoothness={4}
        position={[WORLD_W / 2, -BOARD_THICKNESS / 2, WORLD_H / 2]}
        receiveShadow
        onPointerDown={onBoardPointerDown}
        onPointerUp={onBoardPointerUp}
      >
        <meshStandardMaterial color="#eef2f7" roughness={0.85} metalness={0.04} />
      </RoundedBox>

      {/* Fine 10 / major 50 grid, matching the 2D canvas grid exactly. The grid is
          decorative: it must not swallow the board's click events. */}
      <Grid
        position={[WORLD_W / 2, 0.15, WORLD_H / 2]}
        args={[WORLD_W, WORLD_H]}
        cellSize={GRID}
        cellThickness={0.5}
        cellColor="#d9e1ec"
        sectionSize={GRID_MAJOR}
        sectionThickness={1}
        sectionColor="#c6d1e0"
        fadeDistance={3400}
        fadeStrength={1}
        followCamera={false}
        infiniteGrid={false}
        raycast={() => null}
      />

      {/* Wiring: cables under the parts, then the parts, then the pin endpoints
          (caps sit on top of the headers they mark). */}
      <WiresLayer />
      <PartsLayer />
      <PinsLayer />
      <DropGhostLayer />
    </>
  );
}

/**
 * Drop preview for palette drags: the handlers that receive the HTML drag live on
 * the container outside the canvas, so placement arrives through a small store and
 * this component draws it.
 */
function DropGhostLayer() {
  const ghost = useDropGhostStore((s) => s.ghost);
  if (ghost === null) return null;
  const halfW = NODE_W / 2;
  const halfH = NODE_H / 2;
  return (
    <group position={[ghost.x + halfW, 0.7, ghost.y + halfH]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[NODE_W, NODE_H]} />
        <meshBasicMaterial
          color="#2563eb"
          transparent
          opacity={0.16}
          side={DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <Line
        points={[
          [-halfW, 0, -halfH],
          [halfW, 0, -halfH],
          [halfW, 0, halfH],
          [-halfW, 0, halfH],
          [-halfW, 0, -halfH],
        ]}
        color="#2563eb"
        lineWidth={2}
        dashed
        dashSize={6}
        gapSize={4}
      />
    </group>
  );
}

/**
 * Publishes the camera/raycaster bridge the DOM overlay needs (palette drops, part
 * drags). Mounted inside the Canvas because only the r3f tree owns the camera.
 */
function InputBridge() {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    const raycaster = new Raycaster();
    const boardPlane = new Plane(new Vector3(0, 1, 0), 0);
    const ndc = new Vector2();
    const hit = new Vector3();
    const api = {
      screenToBoard(clientX: number, clientY: number): { x: number; z: number } | null {
        const rect = gl.domElement.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        ndc.set(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1,
        );
        raycaster.setFromCamera(ndc, camera);
        const point = raycaster.ray.intersectPlane(boardPlane, hit);
        return point === null ? null : { x: point.x, z: point.z };
      },
      project(x: number, y: number, z: number): { x: number; y: number } | null {
        const rect = gl.domElement.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        const v = new Vector3(x, y, z).project(camera);
        return {
          x: rect.left + ((v.x + 1) / 2) * rect.width,
          y: rect.top + ((1 - v.y) / 2) * rect.height,
        };
      },
      rayDistance(clientX: number, clientY: number, x: number, y: number, z: number): number {
        const rect = gl.domElement.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return Number.POSITIVE_INFINITY;
        ndc.set(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1,
        );
        raycaster.setFromCamera(ndc, camera);
        return raycaster.ray.distanceToPoint(new Vector3(x, y, z));
      },
    };
    setCanvas3DInput(api);
    return () => clearCanvas3DInput(api);
  }, [camera, gl]);

  return null;
}

/**
 * A WebGL scene can fail at render time (driver reset, context loss, an API
 * mismatch in a dependency). Without a boundary that crashes the whole React
 * tree — including the 2D canvas — so the failure is caught and turned into a
 * card that offers the way back to 2D.
 */
class SceneErrorBoundary extends Component<
  { children: ReactNode; fallback: (message: string) => ReactNode },
  { error: string | null }
> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[BB-3D] scene crashed:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error !== null) return this.props.fallback(this.state.error);
    return this.props.children;
  }
}

export function Canvas3D() {
  const t = useT();
  const setMode = useViewModeStore((s) => s.setMode);
  // Probed once per mount: a context created here is the same kind the scene
  // will get, so an unsupported host is caught before three.js ever loads a scene.
  const [webgl] = useState<WebGLVersion | null>(() => detectWebGL());
  const [fps, setFps] = useState<number | null>(null);
  const [gpu, setGpu] = useState('');
  const [resetToken, setResetToken] = useState(0);

  const onSample = useCallback((value: number) => setFps(value), []);

  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const addPeripheral = useProjectStore((s) => s.addPeripheral);
  const removePeripheral = useProjectStore((s) => s.removePeripheral);
  const removeWire = useProjectStore((s) => s.removeWire);
  const selectInstance = useSelectionStore((s) => s.selectInstance);
  const selectWire = useSelectionStore((s) => s.selectWire);

  // Keyboard parity with the 2D canvas, which owns these shortcuts while it is the
  // mounted view. Text fields keep their native behaviour (same guard as 2D).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isEditableTarget(e.target)) return;
      if (e.ctrlKey && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (e.ctrlKey && !e.altKey && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === 'Escape') {
        useWiring3DStore.getState().cancel();
        useSelectionStore.getState().clear();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const { wireId, instanceId } = useSelectionStore.getState();
        if (wireId !== null) {
          removeWire(wireId);
          selectWire(null);
          toast.info(tNow('canvas.removedWire'));
        } else if (instanceId !== null) {
          removePeripheral(instanceId);
          useSelectionStore.getState().clear();
          toast.info(tNow('canvas.removedInstance', { id: instanceId }));
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, removeWire, removePeripheral, selectWire]);

  // Pin picking in screen space (see nearestPin). A capture listener runs before
  // r3f's canvas handler and consumes the event, so clicking a pin never starts a
  // drag on the part that hides it.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return undefined;
    const onDownCapture = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      const pin = nearestPin(e.clientX, e.clientY);
      if (pin === null) return;
      e.stopPropagation();
      e.preventDefault();
      useWiring3DStore.getState().pickPin(pin);
    };
    const onMoveCapture = (e: PointerEvent): void => {
      // Rubber-band end while wiring.
      if (useWiring3DStore.getState().pending !== null) {
        const point = canvas3DInput()?.screenToBoard(e.clientX, e.clientY);
        if (point !== null && point !== undefined) useWiring3DStore.getState().setHover(point);
      }
      if (nearestPin(e.clientX, e.clientY) !== null) {
        document.body.style.cursor = 'crosshair';
      } else if (document.body.style.cursor === 'crosshair') {
        document.body.style.cursor = '';
      }
    };
    el.addEventListener('pointerdown', onDownCapture, true);
    el.addEventListener('pointermove', onMoveCapture, true);
    return () => {
      el.removeEventListener('pointerdown', onDownCapture, true);
      el.removeEventListener('pointermove', onMoveCapture, true);
    };
  }, []);

  const onDragOver = (e: ReactDragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const kind = (window as unknown as { __bb_drag_kind?: string }).__bb_drag_kind;
    if (kind === undefined) return;
    const point = canvas3DInput()?.screenToBoard(e.clientX, e.clientY);
    if (point === null || point === undefined) return;
    const snapped = snappedPlacement(point.x - NODE_W / 2, point.z - NODE_H / 2, NODE_W, NODE_H);
    const ghost = useDropGhostStore.getState().ghost;
    if (ghost !== null && ghost.kind === kind && ghost.x === snapped.x && ghost.y === snapped.y) {
      return;
    }
    useDropGhostStore.getState().setGhost({ kind, x: snapped.x, y: snapped.y });
  };

  const onDrop = (e: ReactDragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const w = window as unknown as { __bb_drag_kind?: string };
    const kind = w.__bb_drag_kind;
    if (kind === undefined) return;
    w.__bb_drag_kind = undefined;
    useDropGhostStore.getState().setGhost(null);
    const point = canvas3DInput()?.screenToBoard(e.clientX, e.clientY);
    if (point === null || point === undefined) return;
    const snapped = snappedPlacement(point.x - NODE_W / 2, point.z - NODE_H / 2, NODE_W, NODE_H);
    const instanceId = addPeripheral(kind, snapped.x, snapped.y);
    selectInstance(instanceId);
    toast.info(t('canvas.placed', { kind }));
  };

  if (webgl === null) {
    return (
      <div style={container} className="flex items-center justify-center">
        <div className="max-w-sm rounded-md border border-bb-line bg-white/90 p-4 text-center text-xs text-bb-ink">
          <p className="m-0 mb-3">{t('canvas3d.unsupported')}</p>
          <button type="button" className={actionBtn} onClick={() => setMode('2d')}>
            {t('canvas3d.backTo2d')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={container}
      onDragOver={onDragOver}
      onDragLeave={() => useDropGhostStore.getState().setGhost(null)}
      onDrop={onDrop}
    >
      <SceneErrorBoundary
        fallback={(message) => (
          <div className="flex h-full items-center justify-center p-4">
            <div className="max-w-md rounded-md border border-bb-danger bg-white/90 p-4 text-center text-xs text-bb-ink">
              <p className="m-0 mb-2 font-semibold">{t('canvas3d.crashed')}</p>
              <p className="m-0 mb-3 break-all text-bb-muted">{message}</p>
              <button type="button" className={actionBtn} onClick={() => setMode('2d')}>
                {t('canvas3d.backTo2d')}
              </button>
            </div>
          </div>
        )}
      >
        <Canvas
          shadows
          // Capping the pixel ratio at 1.75 keeps the fill rate sane on HiDPI
          // panels; `high-performance` asks the compositor for the discrete GPU on
          // laptops that have one.
          dpr={[1, 1.75]}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
          camera={{ position: defaultCameraPosition(), fov: 45, near: 1, far: 9000 }}
          onCreated={(state) => {
            const gl = state.gl.getContext();
            const renderer = describeRenderer(gl);
            setGpu(renderer);
            // One line at startup: tells hardware and software rendering apart
            // in the dev log without opening devtools.
            console.info('[BB-3D] renderer:', renderer, '|', String(gl.getParameter(gl.VERSION)));
          }}
        >
          <color attach="background" args={['#e9eff7']} />
          <BoardScene />
          {/* Left-drag rotates, wheel dollies, right-drag pans (three's defaults).
              Damping keeps the rotation feeling weighted rather than stepped. */}
          <OrbitControls
            makeDefault
            enableDamping
            dampingFactor={0.08}
            minDistance={MIN_CAMERA_DISTANCE}
            maxDistance={MAX_CAMERA_DISTANCE}
            minPolarAngle={0.15}
            maxPolarAngle={Math.PI / 2 - 0.06}
          />
          <CameraRig resetToken={resetToken} />
          <FrameProbe onSample={onSample} />
          <SceneProbe />
          <InputBridge />
        </Canvas>
      </SceneErrorBoundary>

      <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded border border-bb-line bg-white/85 px-2 py-1 text-[10px] text-bb-muted">
        {t('canvas3d.hint')}
      </div>
      <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded border border-bb-line bg-white/85 px-2 py-1 text-[10px] text-bb-muted tabular-nums">
        <span>{webgl === 'webgl2' ? 'WebGL2' : 'WebGL'}</span>
        {gpu !== '' && <span> · {gpu}</span>}
        {fps !== null && <span> · {fps} FPS</span>}
      </div>
      <button
        type="button"
        className="absolute bottom-3 right-3 z-10 h-7 w-7 cursor-pointer select-none rounded border border-bb-line bg-white/90 text-xs text-bb-ink hover:bg-white active:bg-slate-100"
        title={t('canvas3d.reset')}
        onClick={() => setResetToken((n) => n + 1)}
      >
        ⌖
      </button>
    </div>
  );
}

const container: CSSProperties = {
  flex: 1,
  position: 'relative',
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
  background: '#dfe6ef',
};

const actionBtn =
  'cursor-pointer rounded border border-bb-line bg-white px-3 py-1 text-xs text-bb-ink hover:bg-slate-100';
