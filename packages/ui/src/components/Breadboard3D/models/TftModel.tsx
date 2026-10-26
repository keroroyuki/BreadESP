// 3D model: ST7789 240×240 TFT module — black carrier PCB, brushed steel bezel,
// square glass and the module's nine-pin header. The glass carries the live
// 240×240 framebuffer, so the 3D part shows the same image as the dock's
// ScreenView.
import { RoundedBox } from '@react-three/drei';
import { Pcb, PinRow, STEEL } from './shared';
import { ScreenPlate } from './ScreenPlate';
import type { PartModelProps } from './types';
import { PIN_ROWS_3D } from '../wiring/pinRows3d';

const ROW = PIN_ROWS_3D.st7789;

export function TftModel({ pins = 9, screen = null }: Partial<PartModelProps>) {
  return (
    <group>
      <Pcb w={48} d={44} h={3} color="#111827" />
      <RoundedBox args={[40, 2.4, 40]} radius={1.4} smoothness={3} position={[0, 4.2, 0]} castShadow>
        <meshStandardMaterial color={STEEL} roughness={0.4} metalness={0.65} />
      </RoundedBox>
      <ScreenPlate width={34} depth={34} y={5.42} texture={screen} />
      <PinRow count={pins} spacing={ROW.spacing} z={ROW.z} base={ROW.base} length={ROW.length} />
    </group>
  );
}
