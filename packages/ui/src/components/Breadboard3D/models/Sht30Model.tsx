// 3D model: SHT30 temperature/humidity breakout — white PCB with a black sensor
// package and its vent hole.
import { RoundedBox } from '@react-three/drei';
import { Pcb, PinRow } from './shared';
import type { PartModelProps } from './types';
import { PIN_ROWS_3D } from '../wiring/pinRows3d';

const ROW = PIN_ROWS_3D.sht30;

export function Sht30Model({ pins = 4 }: Partial<PartModelProps>) {
  return (
    <group>
      <Pcb w={34} d={26} h={2.6} color="#e2e8f0" />
      {/* Sensor package. */}
      <RoundedBox args={[10, 2.2, 8]} radius={0.4} smoothness={2} position={[0, 3.7, 1]} castShadow>
        <meshStandardMaterial color="#111827" roughness={0.5} />
      </RoundedBox>
      {/* Vent hole. */}
      <mesh position={[0, 4.75, 1]}>
        <cylinderGeometry args={[1.1, 1.1, 0.14, 12]} />
        <meshStandardMaterial color="#e2e8f0" roughness={0.6} />
      </mesh>
      <PinRow count={pins} spacing={ROW.spacing} z={ROW.z} base={ROW.base} length={ROW.length} />
    </group>
  );
}
