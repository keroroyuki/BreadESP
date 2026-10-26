// 3D model: I2S microphone breakout — small dark-green PCB carrying a steel MEMS
// can with a black acoustic port. The port turns red while the renderer is
// capturing host audio (`level` doubles as the LIVE flag here).
import { Pcb, PinRow } from './shared';
import type { PartModelProps } from './types';
import { PIN_ROWS_3D } from '../wiring/pinRows3d';

const ROW = PIN_ROWS_3D.mic;

export function MicModel({ pins = 3, level = 0 }: Partial<PartModelProps>) {
  return (
    <group>
      <Pcb w={26} d={26} h={2.4} color="#1c4e33" />
      {/* MEMS can. */}
      <mesh position={[0, 6.4, 0]} castShadow>
        <cylinderGeometry args={[6.2, 6.2, 5.6, 28]} />
        <meshStandardMaterial color="#c3cbd4" roughness={0.32} metalness={0.85} />
      </mesh>
      {/* Acoustic port: red while capturing. */}
      <mesh position={[0, 9.25, 0]}>
        <cylinderGeometry args={[1.6, 1.6, 0.3, 16]} />
        <meshStandardMaterial
          color={level > 0 ? '#ef4444' : '#05070b'}
          emissive={level > 0 ? '#ef4444' : '#000000'}
          emissiveIntensity={level}
          roughness={0.9}
        />
      </mesh>
      <PinRow count={pins} spacing={ROW.spacing} z={ROW.z} base={ROW.base} length={ROW.length} />
    </group>
  );
}
