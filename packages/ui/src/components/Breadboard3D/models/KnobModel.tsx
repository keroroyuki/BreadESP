// 3D model: rotary encoder — metal body, steel shaft and a dark knob with an
// indicator line. The indicator is what tells the user this part turns.
import { RoundedBox } from '@react-three/drei';
import { PinRow } from './shared';
import type { PartModelProps } from './types';
import { PIN_ROWS_3D } from '../wiring/pinRows3d';

const ROW = PIN_ROWS_3D.knob;

export function KnobModel({ pins = 4 }: Partial<PartModelProps>) {
  return (
    <group>
      <PinRow count={pins} spacing={ROW.spacing} z={ROW.z} base={ROW.base} length={ROW.length} />
      {/* Encoder body. */}
      <RoundedBox
        args={[20, 12, 20]}
        radius={1.6}
        smoothness={3}
        position={[0, 8, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color="#9aa3ad" roughness={0.42} metalness={0.55} />
      </RoundedBox>
      {/* Shaft. */}
      <mesh position={[0, 16.5, 0]} castShadow>
        <cylinderGeometry args={[2.6, 2.6, 5, 16]} />
        <meshStandardMaterial color="#cbd5e1" roughness={0.3} metalness={0.9} />
      </mesh>
      {/* Knob, faceted so the rim catches light like a real knurl. */}
      <mesh position={[0, 22, 0]} castShadow>
        <cylinderGeometry args={[9.4, 9.8, 6.4, 24]} />
        <meshStandardMaterial color="#1f2937" roughness={0.65} />
      </mesh>
      {/* Position indicator. */}
      <mesh position={[0, 25.35, 3.2]}>
        <boxGeometry args={[1.4, 0.25, 6]} />
        <meshStandardMaterial color="#e5e7eb" roughness={0.4} />
      </mesh>
    </group>
  );
}
