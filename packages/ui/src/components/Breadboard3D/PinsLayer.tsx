// 3D wiring (step 3/4): electrical endpoints, now interactive.
//
// Each pin gets two things: a coloured cap (what the eye sees) and an invisible but
// raycastable sphere (what the pointer hits — a 1.8-unit cap is far too small to
// click reliably at board scale). Clicking a pin routes through the shared
// `advanceWiring` rules in the wiring store, so 2D and 3D wire identically.
import { QuadraticBezierLine } from '@react-three/drei';
import { DoubleSide } from 'three';
import { useProjectStore } from '../../store/projectStore';
import { useWiring3DStore } from '../../store/wiring3dStore';
import { NODE_H, NODE_W } from '../Breadboard/pinLayout';
import { endpointAnchor } from './wiring/anchors';
import { mcuPinAnchors, partPinAnchors, pinRoleColor } from './wiring/pinRows3d';

function PinCap({ position, color }: { position: [number, number, number]; color: string }) {
  return (
    <mesh position={position} castShadow>
      <sphereGeometry args={[1.8, 12, 10]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.45}
        metalness={0.55}
        roughness={0.35}
      />
    </mesh>
  );
}

/** Source-pin ring plus the rubber band that follows the cursor mid-wire. */
function PendingWire() {
  const pending = useWiring3DStore((s) => s.pending);
  const hover = useWiring3DStore((s) => s.hover);
  const layout = useProjectStore((s) => s.layout);
  if (pending === null) return null;
  const anchor = endpointAnchor(pending, layout);
  if (anchor === null) return null;
  const end: [number, number, number] | null =
    hover === null ? null : [hover.x, 1.5, hover.z];
  return (
    <>
      <mesh position={[anchor[0], anchor[1] + 0.4, anchor[2]]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[5.5, 7.5, 24]} />
        <meshBasicMaterial color="#2563eb" transparent opacity={0.9} side={DoubleSide} />
      </mesh>
      {end !== null && (
        <QuadraticBezierLine
          start={anchor}
          end={end}
          mid={[(anchor[0] + end[0]) / 2, Math.max(anchor[1], end[1]) + 26, (anchor[2] + end[2]) / 2]}
          color="#2563eb"
          lineWidth={2}
        />
      )}
    </>
  );
}

export function PinsLayer() {
  const layout = useProjectStore((s) => s.layout);
  return (
    <>
      {mcuPinAnchors().map((a) => (
        <PinCap key={`mcu:${a.pin}`} position={a.position} color={pinRoleColor(a.role)} />
      ))}
      {layout.map((item) =>
        partPinAnchors(item.kind, item.x + NODE_W / 2, item.y + NODE_H / 2).map((a) => (
          <PinCap key={`${item.instanceId}:${a.pin}`} position={a.position} color={pinRoleColor(a.role)} />
        )),
      )}
      <PendingWire />
    </>
  );
}
