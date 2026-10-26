// 3D model: 5 mm through-hole LED — flange, epoxy dome and two legs. The dome is
// emissive with `level` (0..1), so the identical model reads as "off" and "lit".
import { Leg } from './shared';
import type { PartModelProps } from './types';
import { PIN_ROWS_3D } from '../wiring/pinRows3d';

const ROW = PIN_ROWS_3D.led;

export function LedModel({ level = 0, color = '#ef4444' }: Partial<PartModelProps> & { color?: string }) {
  return (
    <group>
      <Leg x={-ROW.spacing / 2} z={ROW.z} from={ROW.base + ROW.length} to={ROW.base} />
      <Leg x={ROW.spacing / 2} z={ROW.z} from={ROW.base + ROW.length} to={ROW.base} />
      {/* Flange: the wider rim the dome grows out of. */}
      <mesh position={[0, 2.4, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[8.6, 8.6, 1.8, 32]} />
        <meshStandardMaterial color="#d7dde5" roughness={0.5} metalness={0.1} />
      </mesh>
      {/* Half-sphere dome: only the upper hemisphere is drawn, so nothing dips
          under the board and the silhouette stays a clean bulb. */}
      <mesh position={[0, 3.2, 0]} scale={[1, 1.32, 1]} castShadow>
        <sphereGeometry args={[8, 32, 18, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.12 + level * 2.4}
          roughness={0.22}
          metalness={0.04}
          transparent
          opacity={0.92}
        />
      </mesh>
    </group>
  );
}
