// 3D model: piezo buzzer — a black pot with a recessed lid, centre sound hole and
// a concentric ring. The pot's rim glows with the tone duty (`level`), so the part
// visibly reacts while the firmware drives it.
import { Leg } from './shared';
import type { PartModelProps } from './types';
import { PIN_ROWS_3D } from '../wiring/pinRows3d';

const ROW = PIN_ROWS_3D.buzzer;

export function BuzzerModel({ level = 0 }: Partial<PartModelProps>) {
  return (
    <group>
      <Leg x={-ROW.spacing / 2} z={ROW.z} from={ROW.base + ROW.length} to={ROW.base} />
      <Leg x={ROW.spacing / 2} z={ROW.z} from={ROW.base + ROW.length} to={ROW.base} />
      {/* Pot. */}
      <mesh position={[0, 8, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[16, 16, 14, 40]} />
        <meshStandardMaterial color="#1f242b" roughness={0.7} />
      </mesh>
      {/* Recessed lid; the ring is what brightens with the tone. */}
      <mesh position={[0, 15.1, 0]} castShadow>
        <cylinderGeometry args={[15, 15, 1.4, 40]} />
        <meshStandardMaterial
          color="#0b0e12"
          emissive="#fbbf24"
          emissiveIntensity={level * 0.9}
          roughness={0.6}
        />
      </mesh>
      {/* Centre sound hole. */}
      <mesh position={[0, 15.9, 0]}>
        <cylinderGeometry args={[3, 3, 0.8, 20]} />
        <meshStandardMaterial color="#000000" roughness={0.95} />
      </mesh>
      {/* Concentric ring around the hole. */}
      <mesh position={[0, 15.85, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[8.4, 0.5, 8, 40]} />
        <meshStandardMaterial color="#3a424c" roughness={0.8} />
      </mesh>
    </group>
  );
}
