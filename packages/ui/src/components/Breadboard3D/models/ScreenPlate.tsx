// A lit glass pane showing a live framebuffer texture (step 3).
//
// The plane is laid flat (normal +Y, matching how the module lies on the board)
// and receives the texture with tone mapping disabled, so drawn pixels read as
// emitted light instead of a painted image.
import type { Texture } from 'three';

export interface ScreenPlateProps {
  /** Visible width along X. */
  width: number;
  /** Visible depth along Z. */
  depth: number;
  /** Height above the board (top of the bezel). */
  y: number;
  texture: Texture | null;
}

export function ScreenPlate({ width, depth, y, texture }: ScreenPlateProps) {
  const lit = texture !== null;
  return (
    <mesh position={[0, y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[width, depth]} />
      <meshStandardMaterial
        color={lit ? '#ffffff' : '#020409'}
        map={texture}
        emissiveMap={texture}
        emissive={lit ? '#ffffff' : '#0b1726'}
        emissiveIntensity={lit ? 1.15 : 0.55}
        roughness={0.15}
        metalness={0.2}
        toneMapped={false}
      />
    </mesh>
  );
}
