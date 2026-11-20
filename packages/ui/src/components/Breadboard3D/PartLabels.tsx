// 3D nameplates. A modelled part is recognisable in silhouette, but a beginner
// still needs the name; these are HTML overlays (crisp at any zoom, no font
// download — an offline desktop app must not fetch a webfont for a label) pinned
// just above each part's footprint.
//
// Labels are decorative: `pointer-events: none` so they never steal a drag or a
// pin click from the canvas underneath.
import { Html } from '@react-three/drei';
import { useT } from '../../i18n';
import { useProjectStore } from '../../store/projectStore';
import { NODE_H, NODE_W } from '../Breadboard/pinLayout';
import { PART_COPY, partVisual, CATEGORY_ACCENT } from '../parts/partVisuals';
import { PartIcon } from '../parts/PartIcon';

export function PartLabels() {
  const layout = useProjectStore((s) => s.layout);
  const t = useT();
  return (
    <>
      {layout.map((item) => {
        const copy = PART_COPY[item.kind];
        const name = copy === undefined ? item.kind : t(copy.name);
        const accent = CATEGORY_ACCENT[partVisual(item.kind).category];
        return (
          <Html
            key={item.instanceId}
            position={[item.x + NODE_W / 2, 58, item.y + NODE_H / 2]}
            center
            zIndexRange={[8, 0]}
            style={{ pointerEvents: 'none', userSelect: 'none' }}
          >
            <div
              className="flex items-center gap-1 whitespace-nowrap rounded-full bg-white/85 px-1.5 py-0.5
                text-[10px] font-medium leading-3 text-slate-700 shadow-sm backdrop-blur-sm"
              style={{ border: `1px solid ${accent}33` }}
            >
              <PartIcon kind={item.kind} size={10} />
              <span>{name}</span>
            </div>
          </Html>
        );
      })}
    </>
  );
}
