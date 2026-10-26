// 3D model: fallback body for kinds without a bespoke model — any third-party
// package registered at runtime lands here automatically. Deliberately plain: a
// grey carrier board, a neutral lamp and a header sized to the factory's pin
// count, so it never pretends to be a specific component.
import { Pcb, PinRow } from './shared';
import type { PartModelProps } from './types';
import { PIN_ROWS_3D } from '../wiring/pinRows3d';

const ROW = PIN_ROWS_3D.generic;

export function GenericPartModel({ pins = 4 }: Partial<PartModelProps>) {
  return (
    <group>
      <Pcb w={34} d={26} h={3} color="#64748b" />
      <mesh position={[0, 8, 0]} castShadow>
        <cylinderGeometry args={[8, 8, 6, 24]} />
        <meshStandardMaterial color="#cbd5e1" roughness={0.45} metalness={0.25} />
      </mesh>
      <mesh position={[0, 11.4, 0]} scale={[1, 0.5, 1]}>
        <sphereGeometry args={[6.4, 20, 14]} />
        <meshStandardMaterial color="#94a3b8" roughness={0.35} />
      </mesh>
      <PinRow count={pins} spacing={ROW.spacing} z={ROW.z} base={ROW.base} length={ROW.length} />
    </group>
  );
}
