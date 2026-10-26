// 3D model: small I2S speaker module — green breakout PCB, black basket and the
// truncated cone of the driver with its dust cap. `level` brightens the cone while
// audio is playing.
import { Pcb, PinRow } from './shared';
import type { PartModelProps } from './types';
import { PIN_ROWS_3D } from '../wiring/pinRows3d';

const ROW = PIN_ROWS_3D.speaker;

export function SpeakerModel({ pins = 4, level = 0 }: Partial<PartModelProps>) {
  return (
    <group>
      <Pcb w={34} d={34} h={3} color="#155e34" />
      {/* Basket. */}
      <mesh position={[0, 7, 0]} castShadow>
        <cylinderGeometry args={[15, 15, 4, 40]} />
        <meshStandardMaterial color="#14181d" roughness={0.65} />
      </mesh>
      {/* Cone: wide at the top, narrow at the voice coil. */}
      <mesh position={[0, 10, 0]} castShadow>
        <cylinderGeometry args={[14.4, 5.5, 3.4, 40]} />
        <meshStandardMaterial
          color="#2a2f36"
          emissive="#38bdf8"
          emissiveIntensity={level * 0.55}
          roughness={0.55}
          metalness={0.15}
        />
      </mesh>
      {/* Dust cap. */}
      <mesh position={[0, 11.6, 0]} scale={[1, 0.45, 1]}>
        <sphereGeometry args={[5.4, 24, 16]} />
        <meshStandardMaterial color="#0b0e12" roughness={0.5} />
      </mesh>
      <PinRow count={pins} spacing={ROW.spacing} z={ROW.z} base={ROW.base} length={ROW.length} />
    </group>
  );
}
