// 3D model: 0.96" SSD1306 OLED module — blue breakout PCB, black bezel and the
// glass pane carrying the live 128×64 framebuffer texture. The pane is 2:1, the
// real panel's active-area ratio, so what the firmware draws is not squashed.
import { RoundedBox } from '@react-three/drei';
import { Pcb, PinRow } from './shared';
import { ScreenPlate } from './ScreenPlate';
import type { PartModelProps } from './types';
import { PIN_ROWS_3D } from '../wiring/pinRows3d';

const ROW = PIN_ROWS_3D.ssd1306;

export function OledModel({ pins = 4, screen = null }: Partial<PartModelProps>) {
  return (
    <group>
      <Pcb w={44} d={30} h={3} color="#1e3a8a" />
      {/* Bezel: 34 × 20 leaves a 3-unit margin around the 28 × 14 pane. */}
      <RoundedBox args={[34, 1.6, 20]} radius={1} smoothness={3} position={[0, 3.8, 0]} castShadow>
        <meshStandardMaterial color="#05070b" roughness={0.45} />
      </RoundedBox>
      <ScreenPlate width={28} depth={14} y={4.62} texture={screen} />
      <PinRow count={pins} spacing={ROW.spacing} z={ROW.z} base={ROW.base} length={ROW.length} />
      {/* Mounting holes. */}
      {[[-19, -12], [19, -12], [-19, 12], [19, 12]].map(([x, z]) => (
        <mesh key={`${x}:${z}`} position={[x, 3.06, z]}>
          <cylinderGeometry args={[1.5, 1.5, 0.4, 12]} />
          <meshStandardMaterial color="#0b1327" roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}
