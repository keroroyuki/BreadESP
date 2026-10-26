// 3D model: ESP32 devkit — the 2D canvas' fixed MCU node as a real module: dark
// PCB, steel RF shield, USB shell, antenna keep-out and two header rows.
//
// The header pads are derived from mcuPinLayout — the very anchors the 2D canvas
// wires to — so a wire lands on the pad the user sees, and PinsLayer's coloured
// caps sit exactly on the same points.
import { RoundedBox } from '@react-three/drei';
import { MCU_GPIO_PINS, MCU_NODE, mcuPinLayout } from '../../Breadboard/pinLayout';
import { GOLD, STEEL } from './shared';
import { MCU_BOARD_H, MCU_PIN_STRIP_H, MCU_PIN_Y } from '../wiring/pinRows3d';

const CENTER_X = MCU_NODE.x + MCU_NODE.w / 2;
const CENTER_Z = MCU_NODE.y + MCU_NODE.h / 2;

/** Header pad positions in board-local coordinates (same source as the 2D pins). */
const PADS: readonly { x: number; z: number }[] = (() => {
  const out: { x: number; z: number }[] = [];
  for (const n of MCU_GPIO_PINS) {
    const layout = mcuPinLayout(`GPIO${n}`);
    if (layout !== null) out.push({ x: layout.anchor.x - CENTER_X, z: layout.anchor.y - CENTER_Z });
  }
  return out;
})();

export function McuModel() {
  const w = MCU_NODE.w;
  const d = MCU_NODE.h;
  const columns = [PADS.filter((p) => p.x < 0), PADS.filter((p) => p.x >= 0)];

  return (
    <group>
      <RoundedBox
        args={[w, MCU_BOARD_H, d]}
        radius={4}
        smoothness={3}
        position={[0, MCU_BOARD_H / 2, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color="#0f2f4f" roughness={0.6} metalness={0.15} />
      </RoundedBox>

      {/* Antenna keep-out: bare copper at the far end, as on a real devkit. */}
      <mesh position={[0, MCU_BOARD_H + 0.09, -d / 2 + 42]}>
        <boxGeometry args={[w * 0.42, 0.18, 26]} />
        <meshStandardMaterial color="#b45309" roughness={0.5} metalness={0.4} />
      </mesh>

      {/* RF shield over the radio/SoC area. */}
      <RoundedBox
        args={[w * 0.58, 11, 74]}
        radius={2}
        smoothness={3}
        position={[0, MCU_BOARD_H + 5.5, -d / 2 + 118]}
        castShadow
      >
        <meshStandardMaterial color={STEEL} roughness={0.36} metalness={0.78} />
      </RoundedBox>

      {/* USB shell on the near edge. */}
      <RoundedBox
        args={[26, 11, 14]}
        radius={1.6}
        smoothness={3}
        position={[0, MCU_BOARD_H + 5.5, d / 2 - 14]}
        castShadow
      >
        <meshStandardMaterial color="#b9c2cc" roughness={0.32} metalness={0.85} />
      </RoundedBox>

      {/* Reset and boot buttons. */}
      {[-40, 40].map((x) => (
        <RoundedBox
          key={x}
          args={[12, 4, 8]}
          radius={0.8}
          smoothness={2}
          position={[x, MCU_BOARD_H + 2, d / 2 - 46]}
          castShadow
        >
          <meshStandardMaterial color="#111827" roughness={0.75} />
        </RoundedBox>
      ))}

      {/* Header rows: a black strip on each long edge plus one gold pad per pin. */}
      {columns.map((pads, column) => {
        if (pads.length === 0) return null;
        const zs = pads.map((p) => p.z);
        const zMin = Math.min(...zs);
        const zMax = Math.max(...zs);
        return (
          <group key={column}>
            <mesh
              position={[pads[0].x, MCU_BOARD_H + MCU_PIN_STRIP_H / 2, (zMin + zMax) / 2]}
              castShadow
              receiveShadow
            >
              <boxGeometry args={[9, MCU_PIN_STRIP_H, zMax - zMin + 8]} />
              <meshStandardMaterial color="#111827" roughness={0.8} />
            </mesh>
            {pads.map((pad, i) => (
              <mesh key={i} position={[pad.x, MCU_PIN_Y, pad.z]}>
                <boxGeometry args={[5.4, 0.5, 5.4]} />
                <meshStandardMaterial color={GOLD} metalness={0.85} roughness={0.3} />
              </mesh>
            ))}
          </group>
        );
      })}
    </group>
  );
}
