// 3D model: bench oscilloscope — light grey enclosure, inset screen and two
// front-panel knobs, with the probe/GND pin strip at its rear edge.
import { RoundedBox } from '@react-three/drei';
import { PinRow } from './shared';
import type { PartModelProps } from './types';
import { PIN_ROWS_3D } from '../wiring/pinRows3d';

const ROW = PIN_ROWS_3D.oscilloscope;

export function ScopeModel({ pins = 5 }: Partial<PartModelProps>) {
  return (
    <group>
      {/* Feet. */}
      {[[-30, -18], [30, -18], [-30, 18], [30, 18]].map(([x, z]) => (
        <mesh key={`${x}:${z}`} position={[x, 2, z]} castShadow>
          <cylinderGeometry args={[3, 3, 4, 12]} />
          <meshStandardMaterial color="#111827" roughness={0.8} />
        </mesh>
      ))}
      {/* Enclosure. */}
      <RoundedBox
        args={[72, 30, 44]}
        radius={3}
        smoothness={3}
        position={[0, 17, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color="#cdd5df" roughness={0.55} metalness={0.1} />
      </RoundedBox>
      {/* Screen bezel, then the lit trace area inset into the front face. */}
      <RoundedBox args={[54, 20, 1.2]} radius={1} smoothness={3} position={[0, 21, 22.2]}>
        <meshStandardMaterial color="#0b1120" roughness={0.25} metalness={0.2} />
      </RoundedBox>
      <mesh position={[0, 21, 22.9]}>
        <boxGeometry args={[50, 17, 0.2]} />
        <meshStandardMaterial
          color="#0e7490"
          emissive="#0e7490"
          emissiveIntensity={0.25}
          roughness={0.2}
        />
      </mesh>
      {/* Front-panel knobs (cylinders laid on the front face). */}
      {[-18, -6].map((x) => (
        <mesh key={x} position={[x, 9, 22.4]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <cylinderGeometry args={[4.2, 4.2, 2.4, 24]} />
          <meshStandardMaterial color="#111827" roughness={0.5} />
        </mesh>
      ))}
      {/* Probe inputs along the rear edge. */}
      <PinRow count={pins} spacing={ROW.spacing} z={ROW.z} base={ROW.base} length={ROW.length} />
    </group>
  );
}
