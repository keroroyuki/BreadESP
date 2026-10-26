// 3D part models share this visual language: every model is authored with its
// origin at the centre of its footprint on the board and its base sitting on the
// board surface (y = 0), so the scene places one with a single group transform
// (see ../boardSpace). Keeping the primitives here is what makes a LED read as a
// LED and a breakout board read as a breakout board: solder-mask PCB, gold header
// pins, steel cans, epoxy domes — the details the eye uses to identify a part.
import { RoundedBox } from '@react-three/drei';

/** Solder-mask green used by the small breakout boards. */
export const PCB_GREEN = '#155e34';
/** Cold-rolled steel look shared by shields, cans and USB shells. */
export const STEEL = '#c3cbd4';
/** Gold plating of header pins and test pads. */
export const GOLD = '#d4af37';

export interface PcbProps {
  /** Width along X. */
  w: number;
  /** Depth along Z. */
  d: number;
  /** Board thickness. */
  h?: number;
  color?: string;
}

/** A PCB slab standing on the board surface: its top face is exactly at y = h. */
export function Pcb({ w, d, h = 3, color = PCB_GREEN }: PcbProps) {
  return (
    <RoundedBox
      args={[w, h, d]}
      radius={Math.min(1.2, h / 2)}
      smoothness={3}
      position={[0, h / 2, 0]}
      castShadow
      receiveShadow
    >
      <meshStandardMaterial color={color} roughness={0.62} metalness={0.08} />
    </RoundedBox>
  );
}

export interface PinRowProps {
  count: number;
  /** Distance between pins. */
  spacing?: number;
  /** Row centre on the XZ plane. */
  x?: number;
  z?: number;
  /** Pin height above `base`. */
  length?: number;
  /** Height of the pin base (usually the PCB top). */
  base?: number;
  /** Axis the row runs along. */
  axis?: 'x' | 'z';
}

/** A row of gold header pins — the detail that reads as "breakout module". */
export function PinRow({
  count,
  spacing = 4,
  x = 0,
  z = 0,
  length = 2.6,
  base = 3,
  axis = 'x',
}: PinRowProps) {
  const half = ((count - 1) * spacing) / 2;
  return (
    <group position={[x, base, z]}>
      {Array.from({ length: count }, (_, i) => {
        const offset = i * spacing - half;
        return (
          <mesh
            key={i}
            position={axis === 'x' ? [offset, length / 2, 0] : [0, length / 2, offset]}
            castShadow
          >
            <boxGeometry args={[1.6, length, 1.6]} />
            <meshStandardMaterial color={GOLD} metalness={0.85} roughness={0.3} />
          </mesh>
        );
      })}
    </group>
  );
}

/** A short metal lead going from a body into the board (LED legs, switch legs). */
export function Leg({
  x = 0,
  z = 0,
  from = 3,
  to = 0,
  r = 0.7,
}: {
  x?: number;
  z?: number;
  from?: number;
  to?: number;
  r?: number;
}) {
  const h = Math.max(0.1, from - to);
  return (
    <mesh position={[x, to + h / 2, z]} castShadow>
      <cylinderGeometry args={[r, r, h, 8]} />
      <meshStandardMaterial color="#9aa3ad" metalness={0.9} roughness={0.35} />
    </mesh>
  );
}
