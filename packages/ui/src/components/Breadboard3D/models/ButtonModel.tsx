// 3D model: 6×6 mm tactile push button — dark plastic housing, light round cap
// and four legs at the corners. The cap is what makes it readable as "press me".
import { RoundedBox } from '@react-three/drei';
import { Leg } from './shared';

export function ButtonModel() {
  return (
    <group>
      {[-9, 9].map((x) =>
        [-9, 9].map((z) => <Leg key={`${x}:${z}`} x={x} z={z} from={3} to={0} r={0.8} />),
      )}
      {/* Housing. */}
      <RoundedBox
        args={[22, 9, 22]}
        radius={1.8}
        smoothness={3}
        position={[0, 7.5, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color="#2b3038" roughness={0.75} />
      </RoundedBox>
      {/* Actuator cap, slightly narrower at the top so it reads as a dome-less
          button rather than a cylinder. */}
      <mesh position={[0, 12.6, 0]} castShadow>
        <cylinderGeometry args={[7.4, 7.9, 3.2, 32]} />
        <meshStandardMaterial color="#e6e9ee" roughness={0.45} />
      </mesh>
      <mesh position={[0, 14.3, 0]}>
        <cylinderGeometry args={[6.4, 6.4, 0.6, 32]} />
        <meshStandardMaterial color="#f8fafc" roughness={0.4} />
      </mesh>
    </group>
  );
}
